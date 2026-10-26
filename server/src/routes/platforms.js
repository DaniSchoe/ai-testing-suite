// Plattformen (Ziele): Komponenten, Topologie, Status, Snapshot und Souveränitätsprofil.
import { requirePermission } from '../auth.js';
import { logAudit } from '../audit.js';
import { many, one, query, tx } from '../db.js';
import { catalog } from './admin.js';
import { platformStatus, takeSnapshot } from '../snapshot.js';

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const ENVIRONMENTS = ['dev', 'prod'];

// SEAL (Sovereign Effectiveness Assurance Level) 0 bis 4 je Souveränitätsziel; min_level ist die geforderte Mindeststufe.
function cleanSovereignty(s = {}) {
  const level = (v, fallback = 0) => Math.min(4, Math.max(0, Math.round(Number(v ?? fallback)) || 0));
  const goals = {};
  for (const [key, g] of Object.entries(s.goals ?? {})) {
    if (!/^SOV-\d{1,2}$/.test(key)) continue;
    goals[key] = { level: level(g?.level), note: String(g?.note ?? '').slice(0, 500) };
  }
  return { min_level: level(s.min_level, 2), goals };
}

export default async function platformRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const manager = { preHandler: requirePermission('endpoints.manage') };

  async function load(request) {
    const p = await one('select * from platforms where id = $1 and tenant_id = $2', [request.params.id, request.user.tenant_id]);
    if (!p) throw bad('Plattform nicht gefunden', 404);
    return p;
  }

  app.get('/api/platforms', viewer, async (request) => {
    const env = request.query.environment;
    return many(
      `select p.*,
         (select count(*)::int from endpoints e where e.platform_id = p.id) as components,
         coalesce((select json_agg(distinct e.kind) from endpoints e where e.platform_id = p.id), '[]') as kinds,
         (select count(*)::int from endpoint_models m join endpoints e on e.id = m.endpoint_id where e.platform_id = p.id and m.available) as models,
         (select r.status from runs r where r.platform_id = p.id and r.finished_at is not null order by r.finished_at desc limit 1) as last_status,
         (select max(r.finished_at) from runs r where r.platform_id = p.id) as last_run_at
       from platforms p where p.tenant_id = $1 and ($2::text is null or p.environment = $2) order by p.name`,
      [request.user.tenant_id, ENVIRONMENTS.includes(env) ? env : null],
    );
  });

  app.get('/api/platforms/:id', viewer, async (request) => {
    const p = await load(request);
    const [endpoints, routes] = await Promise.all([
      catalog(request.user, { platformId: p.id }),
      many('select * from platform_routes where platform_id = $1', [p.id]),
    ]);
    return { ...p, endpoints, routes };
  });

  async function save(request, id) {
    const b = request.body ?? {};
    if (!b.name?.trim()) throw bad('Name fehlt');
    const environment = b.environment ?? 'prod';
    if (!ENVIRONMENTS.includes(environment)) throw bad('Umgebung muss dev oder prod sein');
    const tenantId = request.user.tenant_id;
    const row = await tx(async (c) => {
      const { rows } = id
        ? await c.query(
            `update platforms set name = $2, description = $3, environment = $4, updated_at = now() where id = $1 and tenant_id = $5 returning *`,
            [id, b.name.trim(), b.description ?? null, environment, tenantId],
          )
        : await c.query(
            `insert into platforms (tenant_id, name, description, environment, sovereignty, created_by) values ($1, $2, $3, $4, $5, $6) returning *`,
            [tenantId, b.name.trim(), b.description ?? null, environment, JSON.stringify(cleanSovereignty(b.sovereignty)), request.user.id],
          );
      if (!rows[0]) throw bad('Plattform nicht gefunden', 404);
      // Die Umgebung der Komponenten folgt der Plattform.
      await c.query('update endpoints set environment = $2 where platform_id = $1', [rows[0].id, environment]);
      return rows[0];
    });
    await logAudit(request, id ? 'platform.update' : 'platform.create', 'platform', row.id, { name: row.name, environment });
    return row;
  }

  app.post('/api/platforms', manager, async (request) => save(request, null));
  app.put('/api/platforms/:id', manager, async (request) => save(request, request.params.id));
  app.delete('/api/platforms/:id', manager, async (request) => {
    await query('delete from platforms where id = $1 and tenant_id = $2', [request.params.id, request.user.tenant_id]);
    await logAudit(request, 'platform.delete', 'platform', request.params.id);
    return { ok: true };
  });

  // Topologie: komplett ersetzen. Gateway und Backend müssen zur Plattform gehören.
  app.put('/api/platforms/:id/routes', manager, async (request) => {
    const p = await load(request);
    const routes = request.body?.routes ?? [];
    const eps = new Map((await many('select id, kind from endpoints where platform_id = $1', [p.id])).map((e) => [e.id, e.kind]));
    for (const r of routes) {
      if (eps.get(r.gateway_endpoint_id) !== 'ai_proxy') throw bad('Der Ausgang einer Route muss ein AI Proxy (Gateway) der Plattform sein');
      if (!eps.has(r.backend_endpoint_id) || r.backend_endpoint_id === r.gateway_endpoint_id) throw bad('Ungültiges Backend');
    }
    await tx(async (c) => {
      await c.query('delete from platform_routes where platform_id = $1', [p.id]);
      for (const r of routes) {
        await c.query(
          `insert into platform_routes (platform_id, gateway_endpoint_id, backend_endpoint_id, models, note)
           values ($1, $2, $3, $4, $5) on conflict (gateway_endpoint_id, backend_endpoint_id) do update set models = excluded.models, note = excluded.note`,
          [p.id, r.gateway_endpoint_id, r.backend_endpoint_id, (r.models ?? []).map(String), r.note ?? null],
        );
      }
    });
    await logAudit(request, 'platform.routes', 'platform', p.id, { routes: routes.length });
    return many('select * from platform_routes where platform_id = $1', [p.id]);
  });

  app.put('/api/platforms/:id/sovereignty', manager, async (request) => {
    const p = await load(request);
    const value = cleanSovereignty(request.body);
    await query('update platforms set sovereignty = $2, updated_at = now() where id = $1', [p.id, JSON.stringify(value)]);
    await logAudit(request, 'platform.sovereignty', 'platform', p.id, { min_level: value.min_level });
    return value;
  });

  app.get('/api/platforms/:id/status', viewer, async (request) => {
    const p = await load(request);
    return platformStatus(p.id, { force: request.query.force === '1' });
  });

  // Snapshot ansehen (ohne zu speichern); beim Lauf wird er im Lauf abgelegt.
  app.get('/api/platforms/:id/snapshot', viewer, async (request) => {
    const p = await load(request);
    return takeSnapshot(p.id);
  });
}
