// Mandanten, Mitglieder, Rollen und Teams. Rollen sind global definiert und werden je Mandant vergeben;
// Rollen und Berechtigungen werden hier gepflegt, nicht in Keycloak.
import { hasPermission, requirePermission } from '../auth.js';
import { logAudit } from '../audit.js';
import { config } from '../config.js';
import { many, one, query, tx } from '../db.js';
import { isEnvAdmin, PERMISSION_KEYS, PERMISSIONS, SYSTEM_PERMISSIONS } from '../permissions.js';

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

// Ohne ADMIN_EMAILS muss mindestens ein aktiver System-Administrator bleiben.
async function assertSystemAdminRemains(c) {
  if (config.auth.adminEmails.length) return;
  const { rows } = await c.query(
    `select count(*)::int as n from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id
     where r.key = 'admin' and ur.tenant_id is null and not u.disabled`,
  );
  if (rows[0].n === 0) throw badRequest('Mindestens ein aktiver System-Administrator muss bleiben (oder ADMIN_EMAILS setzen)');
}

// Mitglieder eines Mandanten mit ihren Rollen und Teams in diesem Mandanten.
const MEMBER_SELECT = `
  select u.id, u.sub, u.username, u.email, u.email_verified, u.display_name, u.disabled, u.created_at, u.last_login_at,
    coalesce((select json_agg(json_build_object('id', r.id, 'key', r.key, 'name', r.name) order by r.name)
              from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = u.id and ur.tenant_id = $1), '[]') as roles,
    coalesce((select json_agg(json_build_object('id', t.id, 'name', t.name) order by t.name)
              from team_members tm join teams t on t.id = tm.team_id where tm.user_id = u.id and t.tenant_id = $1), '[]') as teams,
    (select count(*)::int from runs r where r.user_id = u.id and r.tenant_id = $1) as runs,
    (select max(created_at) from runs r where r.user_id = u.id and r.tenant_id = $1) as last_run_at
  from users u
  where exists (select 1 from user_roles ur where ur.user_id = u.id and ur.tenant_id = $1)`;

function publicUser(u) {
  return { ...u, pending: !u.sub, env_admin: isEnvAdmin(u, config.auth.adminEmails), service: Boolean(u.sub?.startsWith('service:')) };
}

export default async function accessRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const memberAdmin = { preHandler: requirePermission('users.manage') };
  const roleAdmin = { preHandler: requirePermission('roles.manage') };
  const teamAdmin = { preHandler: requirePermission('teams.manage') };
  const tenantAdmin = { preHandler: requirePermission('tenants.manage') };

  // Namen der Mitglieder des Mandanten, z. B. zur Auswahl eines Maintainers oder Owners. Keine E-Mails.
  app.get('/api/user-directory', viewer, async (request) =>
    many(
      `select u.id, coalesce(u.display_name, u.username, u.email) as name from users u
       where u.sub is not null and not u.disabled and exists (select 1 from user_roles ur where ur.user_id = u.id and ur.tenant_id = $1)
       order by 2`,
      [request.user.tenant_id],
    ),
  );

  app.get('/api/permissions', { preHandler: requireAny('roles.manage', 'users.manage') }, async () =>
    PERMISSIONS.map((p) => ({ ...p, system: SYSTEM_PERMISSIONS.includes(p.key) })),
  );

  // --- Mandanten ---
  app.get('/api/tenants', viewer, async (request) => {
    if (request.user.is_system_admin && hasPermission(request.user, 'tenants.manage')) {
      return many(
        `select t.*, (select count(*)::int from platforms p where p.tenant_id = t.id) as platforms,
           (select count(distinct ur.user_id)::int from user_roles ur where ur.tenant_id = t.id) as members
         from tenants t order by t.name`,
      );
    }
    return request.user.tenants;
  });

  async function saveTenant(request, id) {
    const b = request.body ?? {};
    if (!b.name?.trim()) throw badRequest('Name fehlt');
    const key = (b.key ?? b.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    if (!key) throw badRequest('Kürzel fehlt');
    const row = id
      ? await one('update tenants set name = $2, description = $3 where id = $1 returning *', [id, b.name.trim(), b.description ?? null])
      : await one('insert into tenants (key, name, description) values ($1, $2, $3) returning *', [key, b.name.trim(), b.description ?? null]);
    if (!row) throw badRequest('Mandant nicht gefunden', 404);
    await logAudit(request, id ? 'tenant.update' : 'tenant.create', 'tenant', row.id, { name: row.name });
    return row;
  }

  app.post('/api/tenants', tenantAdmin, async (request) => saveTenant(request, null));
  app.put('/api/tenants/:id', tenantAdmin, async (request) => saveTenant(request, request.params.id));
  app.delete('/api/tenants/:id', tenantAdmin, async (request) => {
    const t = await one('select key from tenants where id = $1', [request.params.id]);
    if (!t) return { ok: true };
    if (t.key === 'default') throw badRequest('Der Standard-Mandant kann nicht gelöscht werden');
    await query('delete from tenants where id = $1', [request.params.id]);
    await logAudit(request, 'tenant.delete', 'tenant', request.params.id);
    return { ok: true };
  });

  // --- Rollen (global definiert) ---
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
    const role = await tx(async (c) => {
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
    await logAudit(request, id ? 'role.update' : 'role.create', 'role', role.id, { name: role.name, permissions });
    return role;
  }

  app.post('/api/roles', roleAdmin, async (request) => saveRole(request, null));
  app.put('/api/roles/:id', roleAdmin, async (request) => saveRole(request, request.params.id));
  app.delete('/api/roles/:id', roleAdmin, async (request) => {
    const role = await one('select key from roles where id = $1', [request.params.id]);
    if (role?.key === 'admin') throw badRequest('Die Rolle Administrator kann nicht gelöscht werden');
    await query('delete from roles where id = $1', [request.params.id]);
    await logAudit(request, 'role.delete', 'role', request.params.id);
    return { ok: true };
  });

  // --- Mitglieder des Mandanten ---
  app.get('/api/members', { preHandler: requireAny('users.manage', 'teams.manage') }, async (request) =>
    (await many(`${MEMBER_SELECT} order by u.last_login_at desc nulls last, u.email`, [request.user.tenant_id])).map(publicUser),
  );

  // Rollen des Users im aktuellen Mandanten setzen. Wer eine Rolle nicht vergeben darf, darf sie auch nicht entziehen.
  async function setMemberRoles(c, actor, userId, tenantId, roleIds) {
    const roles = (await c.query('select * from roles where id = any($1)', [roleIds])).rows;
    const current = (
      await c.query('select r.* from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1 and ur.tenant_id = $2', [userId, tenantId])
    ).rows;
    const wanted = new Set(roles.map((r) => r.id));
    for (const r of roles.filter((r) => !current.some((x) => x.id === r.id))) assertCanGrant(actor, r);
    for (const r of current.filter((r) => !wanted.has(r.id))) assertCanGrant(actor, r);
    await c.query('delete from user_roles where user_id = $1 and tenant_id = $2 and not (role_id = any($3))', [userId, tenantId, [...wanted]]);
    await c.query('insert into user_roles (user_id, role_id, tenant_id) select $1, unnest($3::uuid[]), $2 on conflict do nothing', [
      userId,
      tenantId,
      [...wanted],
    ]);
  }

  async function setMemberTeams(c, userId, tenantId, teamIds) {
    const own = (await c.query('select id from teams where tenant_id = $1 and id = any($2::uuid[])', [tenantId, teamIds])).rows.map((r) => r.id);
    await c.query(
      `delete from team_members tm using teams t where tm.team_id = t.id and t.tenant_id = $2 and tm.user_id = $1 and not (tm.team_id = any($3::uuid[]))`,
      [userId, tenantId, own],
    );
    await c.query('insert into team_members (team_id, user_id) select unnest($2::uuid[]), $1 on conflict do nothing', [userId, own]);
  }

  // Mitglied hinzufügen: legt den User vorab an (Rollen gelten ab dem ersten Login mit dieser bestätigten E-Mail) oder nimmt einen bestehenden auf.
  app.post('/api/members', memberAdmin, async (request) => {
    const b = request.body ?? {};
    const email = b.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) throw badRequest('Gültige E-Mail-Adresse fehlt');
    const tenantId = request.user.tenant_id;
    const id = await tx(async (c) => {
      let user = (await c.query('select id from users where lower(email) = $1', [email])).rows[0];
      if (!user) {
        user = (await c.query(`insert into users (username, email, display_name) values ($1, $1, $2) returning id`, [email, b.display_name?.trim() || null])).rows[0];
      }
      const roleIds = b.roleIds ?? (await c.query('select id from roles where is_default')).rows.map((r) => r.id);
      await setMemberRoles(c, request.user, user.id, tenantId, roleIds);
      if (b.teamIds?.length) await setMemberTeams(c, user.id, tenantId, b.teamIds);
      return user.id;
    });
    await logAudit(request, 'member.add', 'user', id, { email });
    return publicUser(await one(`${MEMBER_SELECT} and u.id = $2`, [tenantId, id]));
  });

  app.put('/api/members/:id', memberAdmin, async (request) => {
    const b = request.body ?? {};
    const userId = request.params.id;
    const tenantId = request.user.tenant_id;
    if (!(await one(`${MEMBER_SELECT} and u.id = $2`, [tenantId, userId]))) throw badRequest('Mitglied nicht gefunden', 404);
    await tx(async (c) => {
      if (b.roleIds) await setMemberRoles(c, request.user, userId, tenantId, b.roleIds);
      if (b.display_name !== undefined) await c.query('update users set display_name = $2 where id = $1', [userId, b.display_name?.trim() || null]);
      if (b.teamIds) await setMemberTeams(c, userId, tenantId, b.teamIds);
    });
    await logAudit(request, 'member.update', 'user', userId, { roleIds: b.roleIds, teamIds: b.teamIds });
    return publicUser(await one(`${MEMBER_SELECT} and u.id = $2`, [tenantId, userId]));
  });

  // Aus dem Mandanten entfernen (Rollen und Teams dieses Mandanten); der User selbst bleibt erhalten.
  app.delete('/api/members/:id', memberAdmin, async (request) => {
    const userId = request.params.id;
    if (userId === request.user.id) throw badRequest('Du kannst dich nicht selbst entfernen');
    const tenantId = request.user.tenant_id;
    await tx(async (c) => {
      const roles = (await c.query('select r.* from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1 and ur.tenant_id = $2', [userId, tenantId])).rows;
      for (const r of roles) assertCanGrant(request.user, r);
      await c.query('delete from user_roles where user_id = $1 and tenant_id = $2', [userId, tenantId]);
      await c.query('delete from team_members tm using teams t where tm.team_id = t.id and t.tenant_id = $2 and tm.user_id = $1', [userId, tenantId]);
    });
    await logAudit(request, 'member.remove', 'user', userId);
    return { ok: true };
  });

  // --- Alle Benutzer und System-Administratoren (global) ---
  app.get('/api/users', roleAdmin, async () =>
    many(
      `select u.id, u.sub, u.username, u.email, u.display_name, u.disabled, u.last_login_at,
         exists (select 1 from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = u.id and r.key = 'admin' and ur.tenant_id is null) as system_admin,
         coalesce((select json_agg(json_build_object('tenant', t.name, 'role', r.name) order by t.name, r.name)
                   from user_roles ur join roles r on r.id = ur.role_id join tenants t on t.id = ur.tenant_id where ur.user_id = u.id), '[]') as grants
       from users u where u.sub is null or u.sub not like 'service:%' order by u.last_login_at desc nulls last, u.email`,
    ),
  );

  app.put('/api/users/:id', roleAdmin, async (request) => {
    const b = request.body ?? {};
    const userId = request.params.id;
    if (!(await one('select 1 from users where id = $1', [userId]))) throw badRequest('Benutzer nicht gefunden', 404);
    if (userId === request.user.id && (b.disabled || b.system_admin === false)) throw badRequest('Du kannst dir die eigenen Rechte nicht entziehen');
    await tx(async (c) => {
      if (b.disabled !== undefined) await c.query('update users set disabled = $2 where id = $1', [userId, Boolean(b.disabled)]);
      if (b.system_admin !== undefined) {
        if (b.system_admin) {
          await c.query(
            `insert into user_roles (user_id, role_id, tenant_id) select $1, id, null from roles where key = 'admin' on conflict do nothing`,
            [userId],
          );
        } else {
          await c.query(`delete from user_roles ur using roles r where ur.role_id = r.id and r.key = 'admin' and ur.tenant_id is null and ur.user_id = $1`, [userId]);
        }
      }
      await assertSystemAdminRemains(c);
    });
    await logAudit(request, 'user.update', 'user', userId, b);
    return { ok: true };
  });

  // --- Teams (je Mandant) ---
  app.get('/api/teams', viewer, async (request) =>
    many(
      `select t.*,
         coalesce((select json_agg(json_build_object('id', u.id, 'display_name', u.display_name, 'username', u.username, 'email', u.email)
                   order by coalesce(u.display_name, u.username))
                   from team_members tm join users u on u.id = tm.user_id where tm.team_id = t.id), '[]') as members
       from teams t where t.tenant_id = $1 order by t.name`,
      [request.user.tenant_id],
    ),
  );

  async function saveTeam(request, id) {
    const b = request.body ?? {};
    if (!b.name?.trim()) throw badRequest('Name fehlt');
    const tenantId = request.user.tenant_id;
    const departmentId = b.department_id || null;
    if (departmentId && !(await one('select 1 from departments where id = $1 and tenant_id = $2', [departmentId, tenantId]))) throw badRequest('Abteilung nicht gefunden', 404);
    return tx(async (c) => {
      const { rows } = id
        ? await c.query(
            `update teams set name = $2, description = $3, department_id = case when $5 then $6::uuid else department_id end
             where id = $1 and tenant_id = $4 returning *`,
            [id, b.name.trim(), b.description ?? null, tenantId, b.department_id !== undefined, departmentId],
          )
        : await c.query('insert into teams (name, description, tenant_id, department_id) values ($1, $2, $3, $4) returning *', [b.name.trim(), b.description ?? null, tenantId, departmentId]);
      if (!rows[0]) throw badRequest('Team nicht gefunden', 404);
      if (b.memberIds) {
        await c.query('delete from team_members where team_id = $1 and not (user_id = any($2::uuid[]))', [rows[0].id, b.memberIds]);
        await c.query('insert into team_members (team_id, user_id) select $1, unnest($2::uuid[]) on conflict do nothing', [rows[0].id, b.memberIds]);
      }
      return rows[0];
    });
  }

  app.post('/api/teams', teamAdmin, async (request) => saveTeam(request, null));
  app.put('/api/teams/:id', teamAdmin, async (request) => saveTeam(request, request.params.id));
  app.delete('/api/teams/:id', teamAdmin, async (request) => {
    await query('delete from teams where id = $1 and tenant_id = $2', [request.params.id, request.user.tenant_id]);
    return { ok: true };
  });

  // --- Organisation: Mandant -> Abteilung -> Teams ---
  // Systemadministratoren sehen alle Mandanten, alle anderen nur ihren eigenen.
  app.get('/api/organization', viewer, async (request) => {
    const all = request.user.is_system_admin && hasPermission(request.user, 'tenants.manage');
    const tenants = await many('select id, key, name, description from tenants where ($1 or id = $2) order by name', [all, request.user.tenant_id]);
    const ids = tenants.map((t) => t.id);
    const [departments, teams] = await Promise.all([
      many('select * from departments where tenant_id = any($1::uuid[]) order by name', [ids]),
      many(
        `select t.id, t.tenant_id, t.department_id, t.name, t.description,
           (select count(*)::int from team_members tm where tm.team_id = t.id) as members
         from teams t where t.tenant_id = any($1::uuid[]) order by t.name`,
        [ids],
      ),
    ]);
    return tenants.map((t) => ({
      ...t,
      current: t.id === request.user.tenant_id,
      departments: departments.filter((d) => d.tenant_id === t.id).map((d) => ({ ...d, teams: teams.filter((x) => x.department_id === d.id) })),
      teams: teams.filter((x) => x.tenant_id === t.id && !x.department_id),
    }));
  });

  async function saveDepartment(request, id) {
    const b = request.body ?? {};
    if (!b.name?.trim()) throw badRequest('Name fehlt');
    const tenantId = request.user.tenant_id;
    let row;
    try {
      row = id
        ? await one('update departments set name = $2, description = $3 where id = $1 and tenant_id = $4 returning *', [id, b.name.trim(), b.description ?? null, tenantId])
        : await one('insert into departments (tenant_id, name, description) values ($1, $2, $3) returning *', [tenantId, b.name.trim(), b.description ?? null]);
    } catch (err) {
      if (err.code === '23505') throw badRequest(`Eine Abteilung „${b.name.trim()}“ existiert bereits`);
      throw err;
    }
    if (!row) throw badRequest('Abteilung nicht gefunden', 404);
    await logAudit(request, id ? 'department.update' : 'department.create', 'department', row.id, { name: row.name });
    return row;
  }

  app.post('/api/departments', teamAdmin, async (request) => saveDepartment(request, null));
  app.put('/api/departments/:id', teamAdmin, async (request) => saveDepartment(request, request.params.id));
  app.delete('/api/departments/:id', teamAdmin, async (request) => {
    await query('delete from departments where id = $1 and tenant_id = $2', [request.params.id, request.user.tenant_id]);
    await logAudit(request, 'department.delete', 'department', request.params.id);
    return { ok: true };
  });
}
