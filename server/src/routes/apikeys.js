// API-Key-Sammlung: jeder User legt Keys für sich und seine Teams an, nur Administratoren globale
// und rein administrative Keys. Secrets werden nie ausgeliefert, nur maskiert.
import { randomBytes, randomUUID } from 'node:crypto';
import { requirePermission, tokenHash } from '../auth.js';
import { logAudit } from '../audit.js';
import { encrypt, mask } from '../crypto.js';
import { many, one, query, tx } from '../db.js';
import { canEditKey, canSeeKey } from '../visibility.js';

function badRequest(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export async function loadKeys(tenantId) {
  const [keys, teams, users] = await Promise.all([
    many(
      `select k.*, u.display_name as created_by_name,
         (select count(*)::int from endpoints e where e.api_key_id = k.id) as endpoints,
         (select count(*)::int from audits a where a.api_key_id = k.id) as audits
       from api_keys k left join users u on u.id = k.created_by where k.tenant_id = $1 order by k.name`,
      [tenantId],
    ),
    many('select t.api_key_id, t.team_id from api_key_teams t join api_keys k on k.id = t.api_key_id where k.tenant_id = $1', [tenantId]),
    many('select t.api_key_id, t.user_id from api_key_users t join api_keys k on k.id = t.api_key_id where k.tenant_id = $1', [tenantId]),
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
    (await loadKeys(request.user.tenant_id)).filter((k) => canSeeKey(request.user, k)).map((k) => publicKey(request.user, k)),
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
    if (v.teamIds.length) {
      const own = await one('select count(*)::int as n from teams where tenant_id = $1 and id = any($2::uuid[])', [request.user.tenant_id, v.teamIds]);
      if (own.n !== v.teamIds.length) throw badRequest('Unbekanntes Team');
    }
    const row = await tx(async (c) => {
      let key;
      if (id) {
        const existing = (await c.query('select * from api_keys where id = $1 and tenant_id = $2', [id, request.user.tenant_id])).rows[0];
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
            `insert into api_keys (name, description, secret_enc, visibility, admin_only, created_by, tenant_id)
             values ($1, $2, $3, $4, $5, $6, $7) returning *`,
            [b.name.trim(), b.description ?? null, encrypt(b.secret), v.visibility, v.adminOnly, request.user.id, request.user.tenant_id],
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
    const full = (await loadKeys(request.user.tenant_id)).find((k) => k.id === row.id);
    return publicKey(request.user, full);
  }

  app.post('/api/api-keys', viewer, async (request) => save(request, null));
  app.put('/api/api-keys/:id', viewer, async (request) => save(request, request.params.id));

  app.delete('/api/api-keys/:id', viewer, async (request) => {
    const key = await one('select * from api_keys where id = $1 and tenant_id = $2', [request.params.id, request.user.tenant_id]);
    if (!key) return { ok: true };
    if (!canEditKey(request.user, key)) throw badRequest('Nur der Ersteller oder ein Administrator darf den Key löschen', 403);
    await query('delete from api_keys where id = $1', [request.params.id]);
    return { ok: true };
  });

  // --- Service-Tokens für CI/CD und CLI (Mandant, Rolle "Service Account") ---
  const tokenAdmin = { preHandler: requirePermission('users.manage') };

  app.get('/api/service-tokens', tokenAdmin, async (request) =>
    many(
      `select t.id, t.name, t.prefix, t.created_at, t.last_used_at, t.expires_at, t.revoked_at, u.display_name as created_by_name
       from service_tokens t left join users u on u.id = t.created_by where t.tenant_id = $1 order by t.created_at desc`,
      [request.user.tenant_id],
    ),
  );

  // Das Token wird nur hier einmal angezeigt; gespeichert wird nur der Hash.
  app.post('/api/service-tokens', tokenAdmin, async (request) => {
    const b = request.body ?? {};
    if (!b.name?.trim()) throw badRequest('Name fehlt');
    const days = b.expires_in_days ? Number(b.expires_in_days) : null;
    if (days !== null && !(days > 0 && days <= 3650)) throw badRequest('Ungültige Laufzeit');
    const token = `sat_${randomBytes(24).toString('base64url')}`;
    const id = randomUUID();
    await tx(async (c) => {
      const user = (
        await c.query(`insert into users (sub, username, display_name, email_verified) values ($1, $2, $3, false) returning id`, [`service:${id}`, `svc-${id.slice(0, 8)}`, `Service: ${b.name.trim()}`])
      ).rows[0];
      await c.query(`insert into user_roles (user_id, role_id, tenant_id) select $1, id, $2 from roles where key = 'service'`, [user.id, request.user.tenant_id]);
      await c.query(
        `insert into service_tokens (id, tenant_id, user_id, name, prefix, token_hash, created_by, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, case when $8::int is null then null else now() + make_interval(days => $8::int) end)`,
        [id, request.user.tenant_id, user.id, b.name.trim(), token.slice(0, 10), tokenHash(token), request.user.id, days],
      );
    });
    await logAudit(request, 'service_token.create', 'service_token', id, { name: b.name });
    return { id, token };
  });

  app.delete('/api/service-tokens/:id', tokenAdmin, async (request) => {
    await query('update service_tokens set revoked_at = now() where id = $1 and tenant_id = $2 and revoked_at is null', [request.params.id, request.user.tenant_id]);
    await logAudit(request, 'service_token.revoke', 'service_token', request.params.id);
    return { ok: true };
  });
}
