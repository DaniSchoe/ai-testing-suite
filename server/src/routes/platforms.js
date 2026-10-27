// Plattformen (Ziele): Komponenten, Topologie, Status, Snapshot und Souveränitätsprofil.
import { requirePermission } from '../auth.js';
import { logAudit } from '../audit.js';
import { many, one, query, tx } from '../db.js';
import { catalog } from './admin.js';
import { platformStatus, takeSnapshot } from '../snapshot.js';
import { assess } from '../assessment.js';
import { presets } from '../inventory.js';
import { validateLinks } from '../inventorySpec.js';

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const ENVIRONMENTS = ['dev', 'prod'];

// SEAL (Sovereign Effectiveness Assurance Level) 0 bis 4. min_level ist die geforderte Mindeststufe; overrides überschreiben die
// abgeleitete Stufe eines Ziels und brauchen eine Begründung.
const level = (v, fallback = 0) => Math.min(4, Math.max(0, Math.round(Number(v ?? fallback)) || 0));

function cleanSovereignty(s = {}, user = null, previous = {}) {
  const overrides = {};
  const incoming = s.overrides ?? previous.overrides ?? {};
  for (const [key, o] of Object.entries(incoming)) {
    if (!/^SOV-\d{1,2}$/.test(key) || !o) continue;
    const reason = String(o.reason ?? '').trim().slice(0, 1000);
    if (!reason) throw bad(`Überschreiben von ${key} braucht eine Begründung`);
    const same = previous.overrides?.[key] && Number(previous.overrides[key].level) === level(o.level) && previous.overrides[key].reason === reason;
    overrides[key] = same ? previous.overrides[key] : { level: level(o.level), reason, by: user?.display_name ?? user?.username ?? user?.email ?? null, at: new Date().toISOString() };
  }
  return { min_level: level(s.min_level, previous.min_level ?? 2), overrides };
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
         (select count(*)::int from endpoint_models m join endpoints e on e.id = m.endpoint_id where e.platform_id = p.id and m.available and m.portfolio_id is not null) as models,
         (select r.status from runs r where r.platform_id = p.id and r.finished_at is not null order by r.finished_at desc limit 1) as last_status,
         (select max(r.finished_at) from runs r where r.platform_id = p.id) as last_run_at
       from platforms p where p.tenant_id = $1 and ($2::text is null or p.environment = $2) order by p.name`,
      [request.user.tenant_id, ENVIRONMENTS.includes(env) ? env : null],
    );
  });

  app.get('/api/platforms/:id', viewer, async (request) => {
    const p = await load(request);
    const [endpoints, routes, links] = await Promise.all([
      catalog(request.user, { platformId: p.id }),
      many('select * from platform_routes where platform_id = $1', [p.id]),
      many('select kind, from_id, to_id, data from platform_links where platform_id = $1', [p.id]),
    ]);
    return { ...p, endpoints, routes, links };
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
            [tenantId, b.name.trim(), b.description ?? null, environment, JSON.stringify(cleanSovereignty(b.sovereignty, request.user)), request.user.id],
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

  // Topologie: Zuordnungen (Standort, Cluster, GPU), Routen vom Gateway zu Inferenzservern, Modelle je Inferenzserver und Positionen
  // im Editor werden gemeinsam ersetzt. Gateway und Backend müssen zur Plattform gehören.
  app.put('/api/platforms/:id/topology', manager, async (request) => {
    const p = await load(request);
    const b = request.body ?? {};
    const eps = await many('select id, name, kind, spec from endpoints where platform_id = $1', [p.id]);
    const byId = new Map(eps.map((e) => [e.id, e]));
    const links = validateLinks(b.links, byId);
    const routes = b.routes ?? [];
    for (const r of routes) {
      if (byId.get(r.gateway_endpoint_id)?.kind !== 'ai_proxy') throw bad('Der Ausgang einer Route muss ein AI Gateway der Plattform sein');
      if (!['llm', 'ai_proxy'].includes(byId.get(r.backend_endpoint_id)?.kind) || r.backend_endpoint_id === r.gateway_endpoint_id) throw bad('Eine Route führt zu einem Inferenzserver oder Gateway der Plattform');
    }
    const layout = {};
    for (const [id, pos] of Object.entries(b.layout ?? {})) {
      if (byId.has(id) && Number.isFinite(Number(pos?.x)) && Number.isFinite(Number(pos?.y))) layout[id] = { x: Math.round(pos.x), y: Math.round(pos.y) };
    }
    const warnings = [];
    const slots = new Map();
    for (const l of links.filter((x) => x.kind === 'runs_on')) {
      const key = `${l.to_id}|${l.data.mig_slice ?? 'all'}`;
      slots.set(key, [...(slots.get(key) ?? []), byId.get(l.from_id).name]);
    }
    for (const [key, users] of slots) {
      const gpu = byId.get(key.split('|')[0]);
      if (users.length > 1) warnings.push(`${gpu.name}: ${users.join(', ')} teilen sich ${key.endsWith('|all') ? 'die GPU' : 'eine MIG-Instanz'}`);
    }
    for (const [id, models] of Object.entries(b.served_models ?? {})) {
      if (byId.get(id)?.kind !== 'llm') continue;
      const spec = { ...(byId.get(id).spec ?? {}), served_models: [...new Set((models ?? []).map(String))] };
      await query('update endpoints set spec = $2 where id = $1', [id, JSON.stringify(spec)]);
    }
    await tx(async (c) => {
      await c.query('delete from platform_links where platform_id = $1', [p.id]);
      for (const l of links) {
        await c.query('insert into platform_links (platform_id, kind, from_id, to_id, data) values ($1, $2, $3, $4, $5)', [p.id, l.kind, l.from_id, l.to_id, JSON.stringify(l.data)]);
      }
      await c.query('delete from platform_routes where platform_id = $1', [p.id]);
      for (const r of routes) {
        await c.query(
          `insert into platform_routes (platform_id, gateway_endpoint_id, backend_endpoint_id, models, note)
           values ($1, $2, $3, $4, $5) on conflict (gateway_endpoint_id, backend_endpoint_id) do update set models = excluded.models, note = excluded.note`,
          [p.id, r.gateway_endpoint_id, r.backend_endpoint_id, (r.models ?? []).map(String), r.note ?? null],
        );
      }
      await c.query('update platforms set layout = $2, updated_at = now() where id = $1', [p.id, JSON.stringify(layout)]);
    });
    await logAudit(request, 'platform.topology', 'platform', p.id, { links: links.length, routes: routes.length });
    return {
      links: await many('select kind, from_id, to_id, data from platform_links where platform_id = $1', [p.id]),
      routes: await many('select * from platform_routes where platform_id = $1', [p.id]),
      layout,
      warnings,
    };
  });

  app.get('/api/inventory/presets', viewer, async () => presets());

  // Einstufung: Sicherheit, Produktionsreife und Souveränitätsziele mit Begründung je Prüfpunkt.
  app.get('/api/platforms/:id/assessment', viewer, async (request) => {
    const p = await load(request);
    return assess(request.user.tenant_id, p.id);
  });

  // Mindeststufe und Überschreibungen der Ziele. Eine Überschreibung braucht eine Begründung; null hebt sie auf.
  app.put('/api/platforms/:id/sovereignty', manager, async (request) => {
    const p = await load(request);
    const value = cleanSovereignty(request.body, request.user, p.sovereignty ?? {});
    await query('update platforms set sovereignty = $2, updated_at = now() where id = $1', [p.id, JSON.stringify(value)]);
    await logAudit(request, 'platform.sovereignty', 'platform', p.id, { min_level: value.min_level, overrides: Object.keys(value.overrides) });
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
