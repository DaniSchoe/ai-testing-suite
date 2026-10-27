// Modellportfolio: fachliche Modelle, die aus einem oder mehreren gefundenen Endpoint-Modellen bestehen.
// Nur Modelle im Portfolio werden getestet und bewertet; gefundene Modelle erscheinen erst als Kandidaten.
import { requirePermission } from '../auth.js';
import { logAudit } from '../audit.js';
import { many, one, tx } from '../db.js';
import { hasPermission } from '../permissions.js';
import { canSeePublished } from '../visibility.js';

const CAPABILITIES = ['vision', 'tools', 'reasoning', 'mcp', 'json', 'embeddings'];
const VISIBILITIES = ['admins', 'teams', 'global'];
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const text = (v) => (v === undefined || v === null ? null : String(v).trim() || null);

export default async function portfolioRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const manager = { preHandler: requirePermission('endpoints.manage') };

  async function members(tenantId) {
    return many(
      `select m.portfolio_id, m.endpoint_id, m.name as model_name, m.available, e.name as endpoint_name, e.kind as endpoint_kind,
              e.platform_id, p.name as platform_name, p.environment as platform_environment
       from endpoint_models m join endpoints e on e.id = m.endpoint_id join platforms p on p.id = e.platform_id
       where e.tenant_id = $1 and m.portfolio_id is not null order by p.name, e.name, m.name`,
      [tenantId],
    );
  }

  app.get('/api/portfolio', viewer, async (request) => {
    const user = request.user;
    const [models, teams, users, mem] = await Promise.all([
      many('select * from portfolio_models where tenant_id = $1 order by name', [user.tenant_id]),
      many('select t.* from portfolio_model_teams t join portfolio_models p on p.id = t.portfolio_id where p.tenant_id = $1', [user.tenant_id]),
      many('select id, coalesce(display_name, username) as name from users'),
      members(user.tenant_id),
    ]);
    const userName = new Map(users.map((u) => [u.id, u.name]));
    const admin = user.is_admin || hasPermission(user, 'endpoints.manage');
    return models
      .map((m) => ({
        ...m,
        teamIds: teams.filter((t) => t.portfolio_id === m.id).map((t) => t.team_id),
        maintainer_name: userName.get(m.maintainer_id) ?? null,
        members: mem.filter((x) => x.portfolio_id === m.id),
        can_edit: admin || m.maintainer_id === user.id,
      }))
      .filter((m) => admin || canSeePublished(user, m));
  });

  // Gefundene Modelle, die noch keinem Portfolio-Modell angehören.
  app.get('/api/portfolio/candidates', manager, async (request) =>
    many(
      `select m.endpoint_id, m.name as model_name, m.capabilities, m.info, e.name as endpoint_name, e.kind as endpoint_kind,
              e.platform_id, p.name as platform_name, p.environment as platform_environment
       from endpoint_models m join endpoints e on e.id = m.endpoint_id join platforms p on p.id = e.platform_id
       where e.tenant_id = $1 and m.available and m.portfolio_id is null
         and ($2::uuid is null or e.platform_id = $2) order by p.name, e.name, m.name`,
      [request.user.tenant_id, request.query.platform_id ?? null],
    ),
  );

  async function save(request, id) {
    const b = request.body ?? {};
    const tenantId = request.user.tenant_id;
    const existing = id ? await one('select * from portfolio_models where id = $1 and tenant_id = $2', [id, tenantId]) : null;
    if (id && !existing) throw bad('Modell nicht gefunden', 404);
    if (id && !(request.user.is_admin || hasPermission(request.user, 'endpoints.manage') || existing.maintainer_id === request.user.id)) {
      throw bad('Nur Administratoren und der Maintainer dürfen Modelle bearbeiten', 403);
    }
    const name = b.name?.trim();
    if (!name) throw bad('Name fehlt');
    const visibility = b.visibility ?? existing?.visibility ?? 'global';
    if (!VISIBILITIES.includes(visibility)) throw bad('Ungültige Veröffentlichung');
    const teamIds = visibility === 'teams' ? [...new Set(b.teamIds ?? [])] : [];
    if (visibility === 'teams' && !teamIds.length) throw bad('Mindestens ein Team auswählen');
    const wanted = [...new Map((b.members ?? []).map((m) => [`${m.endpoint_id}|${m.model_name}`, m])).values()];
    if (!id && !wanted.length) throw bad('Mindestens ein gefundenes Modell auswählen');
    const pick = (k) => (b[k] === undefined ? (existing?.[k] ?? null) : text(b[k]));
    const capabilities = b.capabilities === undefined ? (existing?.capabilities ?? []) : [...new Set(b.capabilities)].filter((c) => CAPABILITIES.includes(c));
    const row = await tx(async (c) => {
      const values = [
        name, pick('description'),
        pick('provider'), pick('license'), pick('origin'),
        b.open_weights === undefined ? (existing?.open_weights ?? null) : b.open_weights === null || b.open_weights === '' ? null : Boolean(b.open_weights),
        pick('revision'), pick('quantization'), capabilities,
        b.context_length === undefined ? (existing?.context_length ?? null) : Number(b.context_length) || null,
        b.maintainer_id === undefined ? (existing?.maintainer_id ?? request.user.id) : b.maintainer_id || null,
        visibility,
      ];
      let rows;
      try {
        ({ rows } = id
          ? await c.query(
              `update portfolio_models set name = $2, description = $3, provider = $4, license = $5, origin = $6, open_weights = $7, revision = $8,
                 quantization = $9, capabilities = $10, context_length = $11, maintainer_id = $12, visibility = $13, updated_at = now()
               where id = $1 returning *`,
              [id, ...values],
            )
          : await c.query(
              `insert into portfolio_models (tenant_id, name, description, provider, license, origin, open_weights, revision, quantization, capabilities,
                 context_length, maintainer_id, visibility, created_by)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning *`,
              [tenantId, ...values, request.user.id],
            ));
      } catch (err) {
        if (err.code === '23505') throw bad(`Ein Modell „${name}“ existiert bereits im Portfolio`);
        throw err;
      }
      const p = rows[0];
      await c.query('delete from portfolio_model_teams where portfolio_id = $1', [p.id]);
      if (teamIds.length) await c.query('insert into portfolio_model_teams select $1, unnest($2::uuid[])', [p.id, teamIds]);
      // Mitglieder: Modelle am Endpoint, die diesem Portfolio-Modell zugeordnet sind. Alias und Metadaten werden gespiegelt.
      await c.query('update endpoint_models set portfolio_id = null where portfolio_id = $1', [p.id]);
      for (const m of wanted) {
        const { rowCount } = await c.query(
          `update endpoint_models m set portfolio_id = $3, alias = $4, license = $5, provider = $6, origin = $7, open_weights = $8, revision = $9,
             quantization = $10, capabilities = $11, context_length = $12, maintainer_id = $13, visibility = $14
           from endpoints e where e.id = m.endpoint_id and e.tenant_id = $15 and m.endpoint_id = $1 and m.name = $2
             and (m.portfolio_id is null or m.portfolio_id = $3)`,
          [m.endpoint_id, m.model_name, p.id, p.name, p.license, p.provider, p.origin, p.open_weights, p.revision, p.quantization, p.capabilities, p.context_length, p.maintainer_id, p.visibility, tenantId],
        );
        if (!rowCount) throw bad(`Modell „${m.model_name}“ ist unbekannt oder gehört bereits zu einem anderen Portfolio-Modell`);
        await c.query('delete from model_teams where endpoint_id = $1 and model_name = $2', [m.endpoint_id, m.model_name]);
        if (teamIds.length) await c.query('insert into model_teams select $1, $2, unnest($3::uuid[])', [m.endpoint_id, m.model_name, teamIds]);
      }
      return p;
    });
    await logAudit(request, id ? 'portfolio.update' : 'portfolio.create', 'portfolio_model', row.id, { name: row.name, members: wanted.length });
    return row;
  }

  app.post('/api/portfolio', manager, async (request) => save(request, null));
  app.put('/api/portfolio/:id', viewer, async (request) => save(request, request.params.id));

  app.delete('/api/portfolio/:id', manager, async (request) => {
    await tx(async (c) => {
      await c.query('update endpoint_models set portfolio_id = null where portfolio_id = $1', [request.params.id]);
      await c.query('delete from portfolio_models where id = $1 and tenant_id = $2', [request.params.id, request.user.tenant_id]);
    });
    await logAudit(request, 'portfolio.delete', 'portfolio_model', request.params.id);
    return { ok: true };
  });
}
