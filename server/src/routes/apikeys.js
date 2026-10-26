// API-Key-Sammlung: jeder User legt Keys für sich und seine Teams an, nur Administratoren globale
// und rein administrative Keys. Secrets werden nie ausgeliefert, nur maskiert.
import { requirePermission } from '../auth.js';
import { encrypt, mask } from '../crypto.js';
import { many, one, query, tx } from '../db.js';
import { canEditKey, canSeeKey } from '../visibility.js';

function badRequest(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export async function loadKeys() {
  const [keys, teams, users] = await Promise.all([
    many(
      `select k.*, u.display_name as created_by_name,
         (select count(*)::int from endpoints e where e.api_key_id = k.id) as endpoints,
         (select count(*)::int from test_definitions t where t.api_key_id = k.id) as tests
       from api_keys k left join users u on u.id = k.created_by order by k.name`,
    ),
    many('select api_key_id, team_id from api_key_teams'),
    many('select api_key_id, user_id from api_key_users'),
  ]);
  return keys.map((k) => ({
    ...k,
    teamIds: teams.filter((t) => t.api_key_id === k.id).map((t) => t.team_id),
    userIds: users.filter((u) => u.api_key_id === k.id).map((u) => u.user_id),
  }));
}

export const publicKey = (user, k) => {
  const { secret_enc, ...rest } = k;
  return { ...rest, masked: mask(secret_enc), has_secret: Boolean(secret_enc), can_edit: canEditKey(user, k), mine: k.created_by === user.id };
};

export default async function apiKeyRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };

  app.get('/api/api-keys', viewer, async (request) =>
    (await loadKeys()).filter((k) => canSeeKey(request.user, k)).map((k) => publicKey(request.user, k)),
  );

  // Regeln: Nicht-Admins nur "user" oder "teams" mit eigenen Teams, keine Einzel-User, kein admin_only.
  function validate(user, b) {
    if (!b.name?.trim()) throw badRequest('Name fehlt');
    const visibility = b.visibility ?? 'user';
    if (!['user', 'teams', 'global'].includes(visibility)) throw badRequest('Ungültige Sichtbarkeit');
    const teamIds = visibility === 'teams' ? [...new Set(b.teamIds ?? [])] : [];
    if (visibility === 'teams' && teamIds.length === 0) throw badRequest('Mindestens ein Team auswählen');
    const userIds = [...new Set(b.userIds ?? [])];
    if (!user.is_admin) {
      if (visibility === 'global') throw badRequest('Nur Administratoren dürfen globale Keys anlegen', 403);
      if (b.admin_only) throw badRequest('Nur Administratoren dürfen Keys auf "nur Administratoren" stellen', 403);
      if (userIds.length) throw badRequest('Nur Administratoren dürfen Keys einzelnen Usern zuordnen', 403);
      const own = (user.teams ?? []).map((t) => t.id);
      if (teamIds.some((id) => !own.includes(id))) throw badRequest('Du kannst Keys nur für deine eigenen Teams freigeben', 403);
    }
    return { visibility, teamIds, userIds, adminOnly: user.is_admin && Boolean(b.admin_only) };
  }

  async function save(request, id) {
    const b = request.body ?? {};
    const v = validate(request.user, b);
    const row = await tx(async (c) => {
      let key;
      if (id) {
        const existing = (await c.query('select * from api_keys where id = $1', [id])).rows[0];
        if (!existing) throw badRequest('Key nicht gefunden', 404);
        if (!canEditKey(request.user, existing)) throw badRequest('Nur der Ersteller oder ein Administrator darf den Key ändern', 403);
        key = (
          await c.query(
            // secret: undefined = unverändert, sonst neu setzen
            `update api_keys set name = $2, description = $3, visibility = $4, admin_only = $5,
               secret_enc = case when $6::boolean then $7 else secret_enc end, updated_at = now()
             where id = $1 returning *`,
            [id, b.name.trim(), b.description ?? null, v.visibility, request.user.is_admin ? v.adminOnly : existing.admin_only, b.secret !== undefined && b.secret !== '', encrypt(b.secret)],
          )
        ).rows[0];
      } else {
        if (!b.secret) throw badRequest('Der Key selbst fehlt');
        key = (
          await c.query(
            `insert into api_keys (name, description, secret_enc, visibility, admin_only, created_by)
             values ($1, $2, $3, $4, $5, $6) returning *`,
            [b.name.trim(), b.description ?? null, encrypt(b.secret), v.visibility, v.adminOnly, request.user.id],
          )
        ).rows[0];
      }
      // Als Nicht-Admin bleiben bestehende Einzel-User-Zuordnungen unberührt.
      if (request.user.is_admin) {
        await c.query('delete from api_key_users where api_key_id = $1', [key.id]);
        if (v.userIds.length) await c.query('insert into api_key_users select $1, unnest($2::uuid[])', [key.id, v.userIds]);
      }
      await c.query('delete from api_key_teams where api_key_id = $1', [key.id]);
      if (v.teamIds.length) await c.query('insert into api_key_teams select $1, unnest($2::uuid[])', [key.id, v.teamIds]);
      return key;
    });
    const full = (await loadKeys()).find((k) => k.id === row.id);
    return publicKey(request.user, full);
  }

  app.post('/api/api-keys', viewer, async (request) => save(request, null));
  app.put('/api/api-keys/:id', viewer, async (request) => save(request, request.params.id));

  app.delete('/api/api-keys/:id', viewer, async (request) => {
    const key = await one('select * from api_keys where id = $1', [request.params.id]);
    if (!key) return { ok: true };
    if (!canEditKey(request.user, key)) throw badRequest('Nur der Ersteller oder ein Administrator darf den Key löschen', 403);
    await query('delete from api_keys where id = $1', [request.params.id]);
    return { ok: true };
  });
}
