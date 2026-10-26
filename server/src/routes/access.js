// Benutzer, Rollen und Teams. Rollen und Berechtigungen werden hier gepflegt, nicht in Keycloak.
import { hasPermission, requirePermission } from '../auth.js';
import { config } from '../config.js';
import { many, one, query, tx } from '../db.js';
import { isEnvAdmin, PERMISSION_KEYS, PERMISSIONS } from '../permissions.js';

function badRequest(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function requireAny(...permissions) {
  return async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Nicht angemeldet' });
    if (!permissions.some((p) => hasPermission(request.user, p))) {
      return reply.code(403).send({ error: `Berechtigung "${permissions.join('" oder "')}" erforderlich` });
    }
  };
}

// Niemand kann mehr Rechte vergeben, als er selbst hat; die Admin-Rolle vergeben nur Admins.
function assertCanGrant(actor, role) {
  if (actor.is_admin) return;
  if (role.key === 'admin') throw badRequest('Nur Admins dürfen die Rolle Administrator vergeben', 403);
  const missing = role.permissions.filter((p) => !actor.permissions.includes(p));
  if (missing.length) throw badRequest(`Rolle "${role.name}" enthält Berechtigungen, die du selbst nicht hast: ${missing.join(', ')}`, 403);
}

// Ohne ADMIN_EMAILS muss mindestens ein aktiver User die Rolle Administrator behalten.
async function assertAdminRemains(c) {
  if (config.auth.adminEmails.length) return;
  const { rows } = await c.query(
    `select count(*)::int as n from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id
     where r.key = 'admin' and not u.disabled`,
  );
  if (rows[0].n === 0) throw badRequest('Mindestens ein aktiver Administrator muss bleiben (oder ADMIN_EMAILS setzen)');
}

const USER_SELECT = `
  select u.id, u.sub, u.username, u.email, u.email_verified, u.display_name, u.disabled, u.created_at, u.last_login_at,
    coalesce((select json_agg(json_build_object('id', r.id, 'key', r.key, 'name', r.name) order by r.name)
              from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = u.id), '[]') as roles,
    coalesce((select json_agg(json_build_object('id', t.id, 'name', t.name) order by t.name)
              from team_members tm join teams t on t.id = tm.team_id where tm.user_id = u.id), '[]') as teams,
    (select count(*)::int from runs r where r.user_id = u.id) as runs,
    (select max(created_at) from runs r where r.user_id = u.id) as last_run_at
  from users u`;

function publicUser(u) {
  return { ...u, pending: !u.sub, env_admin: isEnvAdmin(u, config.auth.adminEmails) };
}

export default async function accessRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const userAdmin = { preHandler: requirePermission('users.manage') };
  const roleAdmin = { preHandler: requirePermission('roles.manage') };
  const teamAdmin = { preHandler: requirePermission('teams.manage') };

  app.get('/api/permissions', { preHandler: requireAny('roles.manage', 'users.manage') }, async () => PERMISSIONS);

  // --- Rollen ---
  app.get('/api/roles', { preHandler: requireAny('roles.manage', 'users.manage') }, async () => {
    const rows = await many(
      `select r.*, (select count(*)::int from user_roles ur where ur.role_id = r.id) as users
       from roles r order by r.key = 'admin' desc, r.name`,
    );
    return rows.map((r) => (r.key === 'admin' ? { ...r, permissions: [...PERMISSION_KEYS] } : r));
  });

  async function saveRole(request, id) {
    const b = request.body ?? {};
    if (!b.name?.trim()) throw badRequest('Name fehlt');
    const permissions = [...new Set(b.permissions ?? [])];
    const unknown = permissions.filter((p) => !PERMISSION_KEYS.includes(p));
    if (unknown.length) throw badRequest(`Unbekannte Berechtigung: ${unknown.join(', ')}`);
    const existing = id ? await one('select * from roles where id = $1', [id]) : null;
    if (id && !existing) throw badRequest('Rolle nicht gefunden', 404);
    const isAdminRole = existing?.key === 'admin';
    if (!isAdminRole) assertCanGrant(request.user, { name: b.name, permissions });
    return tx(async (c) => {
      if (b.is_default) await c.query('update roles set is_default = false where is_default');
      const { rows } = id
        ? await c.query(
            `update roles set name = $2, description = $3, permissions = $4, is_default = $5, updated_at = now()
             where id = $1 returning *`,
            // Die Admin-Rolle hat immer alle Berechtigungen und ist nie Standardrolle.
            [id, b.name.trim(), b.description ?? null, isAdminRole ? [] : permissions, isAdminRole ? false : Boolean(b.is_default)],
          )
        : await c.query(
            `insert into roles (name, description, permissions, is_default) values ($1, $2, $3, $4) returning *`,
            [b.name.trim(), b.description ?? null, permissions, Boolean(b.is_default)],
          );
      return rows[0];
    });
  }

  app.post('/api/roles', roleAdmin, async (request) => saveRole(request, null));
  app.put('/api/roles/:id', roleAdmin, async (request) => saveRole(request, request.params.id));
  app.delete('/api/roles/:id', roleAdmin, async (request) => {
    const role = await one('select key from roles where id = $1', [request.params.id]);
    if (role?.key === 'admin') throw badRequest('Die Rolle Administrator kann nicht gelöscht werden');
    await query('delete from roles where id = $1', [request.params.id]);
    return { ok: true };
  });

  // --- Benutzer ---
  app.get('/api/users', { preHandler: requireAny('users.manage', 'teams.manage') }, async () =>
    (await many(`${USER_SELECT} order by u.last_login_at desc nulls last, u.email`)).map(publicUser),
  );

  async function setUserRoles(c, actor, userId, roleIds) {
    const roles = (await c.query('select * from roles where id = any($1)', [roleIds])).rows;
    const current = (await c.query('select r.* from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1', [userId])).rows;
    const wanted = new Set(roles.map((r) => r.id));
    // Hinzufügen und Entfernen prüfen: wer eine Rolle nicht vergeben darf, darf sie auch nicht entziehen.
    for (const r of roles.filter((r) => !current.some((x) => x.id === r.id))) assertCanGrant(actor, r);
    for (const r of current.filter((r) => !wanted.has(r.id))) assertCanGrant(actor, r);
    await c.query('delete from user_roles where user_id = $1 and not (role_id = any($2))', [userId, [...wanted]]);
    await c.query(
      'insert into user_roles (user_id, role_id) select $1, unnest($2::uuid[]) on conflict do nothing',
      [userId, [...wanted]],
    );
  }

  // Vorab anlegen: Rollen und Teams gelten ab dem ersten Login mit dieser (bestätigten) E-Mail.
  app.post('/api/users', userAdmin, async (request) => {
    const b = request.body ?? {};
    const email = b.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) throw badRequest('Gültige E-Mail-Adresse fehlt');
    if (await one('select 1 from users where lower(email) = $1', [email])) throw badRequest('Ein User mit dieser E-Mail existiert bereits');
    const id = await tx(async (c) => {
      const { rows } = await c.query(
        `insert into users (username, email, display_name) values ($1, $1, $2) returning id`,
        [email, b.display_name?.trim() || null],
      );
      const userId = rows[0].id;
      const roleIds = b.roleIds ?? (await c.query('select id from roles where is_default')).rows.map((r) => r.id);
      await setUserRoles(c, request.user, userId, roleIds);
      if (b.teamIds?.length) {
        await c.query('insert into team_members (team_id, user_id) select unnest($2::uuid[]), $1', [userId, b.teamIds]);
      }
      return userId;
    });
    return publicUser(await one(`${USER_SELECT} where u.id = $1`, [id]));
  });

  app.put('/api/users/:id', userAdmin, async (request) => {
    const b = request.body ?? {};
    const userId = request.params.id;
    if (!(await one('select 1 from users where id = $1', [userId]))) throw badRequest('Benutzer nicht gefunden', 404);
    if (userId === request.user.id && b.disabled) throw badRequest('Du kannst dich nicht selbst sperren');
    await tx(async (c) => {
      if (b.roleIds) await setUserRoles(c, request.user, userId, b.roleIds);
      if (b.disabled !== undefined) await c.query('update users set disabled = $2 where id = $1', [userId, Boolean(b.disabled)]);
      if (b.display_name !== undefined) await c.query('update users set display_name = $2 where id = $1', [userId, b.display_name?.trim() || null]);
      if (b.teamIds) {
        await c.query('delete from team_members where user_id = $1 and not (team_id = any($2::uuid[]))', [userId, b.teamIds]);
        await c.query('insert into team_members (team_id, user_id) select unnest($2::uuid[]), $1 on conflict do nothing', [userId, b.teamIds]);
      }
      await assertAdminRemains(c);
    });
    return publicUser(await one(`${USER_SELECT} where u.id = $1`, [userId]));
  });

  // Nur vorab angelegte User löschen; angemeldete User werden gesperrt, damit ihre Historie bleibt.
  app.delete('/api/users/:id', userAdmin, async (request) => {
    const user = await one('select sub from users where id = $1', [request.params.id]);
    if (user?.sub) throw badRequest('Angemeldete Benutzer können nur gesperrt werden');
    await query('delete from users where id = $1 and sub is null', [request.params.id]);
    return { ok: true };
  });

  // --- Teams ---
  app.get('/api/teams', viewer, async () =>
    many(
      `select t.*,
         coalesce((select json_agg(json_build_object('id', u.id, 'display_name', u.display_name, 'username', u.username, 'email', u.email)
                   order by coalesce(u.display_name, u.username))
                   from team_members tm join users u on u.id = tm.user_id where tm.team_id = t.id), '[]') as members
       from teams t order by t.name`,
    ),
  );

  async function saveTeam(request, id) {
    const b = request.body ?? {};
    if (!b.name?.trim()) throw badRequest('Name fehlt');
    return tx(async (c) => {
      const { rows } = id
        ? await c.query('update teams set name = $2, description = $3 where id = $1 returning *', [id, b.name.trim(), b.description ?? null])
        : await c.query('insert into teams (name, description) values ($1, $2) returning *', [b.name.trim(), b.description ?? null]);
      if (!rows[0]) throw badRequest('Team nicht gefunden', 404);
      if (b.memberIds) {
        await c.query('delete from team_members where team_id = $1 and not (user_id = any($2::uuid[]))', [rows[0].id, b.memberIds]);
        await c.query('insert into team_members (team_id, user_id) select $1, unnest($2::uuid[]) on conflict do nothing', [
          rows[0].id,
          b.memberIds,
        ]);
      }
      return rows[0];
    });
  }

  app.post('/api/teams', teamAdmin, async (request) => saveTeam(request, null));
  app.put('/api/teams/:id', teamAdmin, async (request) => saveTeam(request, request.params.id));
  app.delete('/api/teams/:id', teamAdmin, async (request) => {
    await query('delete from teams where id = $1', [request.params.id]);
    return { ok: true };
  });
}
