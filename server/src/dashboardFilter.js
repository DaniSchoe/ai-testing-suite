// Welche Endpoints und Modelle ein User im Dashboard sieht und welche Auswahl er getroffen hat.
// Standard: nur produktive Endpoints und Modelle. Dev sehen nur Administratoren und Maintainer, und nur
// wenn sie es ausdrücklich auswählen.
import { many } from './db.js';
import { catalog } from './routes/admin.js';

const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const effective = (e, m) => (e.environment === 'dev' || m?.environment === 'dev' ? 'dev' : 'prod');

// Auswahlliste für das Dashboard: sichtbare Endpoints mit ihren Modellen (Alias) und der Umgebung.
export async function dashboardFilters(user) {
  const out = [];
  for (const e of await catalog(user)) {
    const mayDev = user.is_admin || e.maintainer_id === user.id;
    if (e.environment === 'dev' && !mayDev) continue;
    const models = e.models
      .filter((m) => m.available && (m.environment !== 'dev' || user.is_admin || m.maintainer_id === user.id))
      .map((m) => ({ name: m.name, alias: m.alias ?? m.name, environment: effective(e, m) }));
    out.push({ id: e.id, name: e.name, kind: e.kind, llm_flavor: e.llm_flavor, environment: e.environment, models });
  }
  return out;
}

// SQL-Parameter für die Ergebnisfilter im Dashboard:
//   allowedEndpoints, blockedEndpoints/blockedModels (Paare), selModels (Aliase), selEndpoints.
export async function dashboardAccess(user, query) {
  const filters = await dashboardFilters(user);
  const selModels = csv(query.models);
  const selEndpoints = csv(query.endpoints).filter((id) => filters.some((f) => f.id === id));
  const selected = selModels.length > 0 || selEndpoints.length > 0;
  const blocked = { endpoints: [], models: [] };
  const rows = await many('select endpoint_id, name from endpoint_models');
  const visible = new Map(filters.map((f) => [f.id, new Map(f.models.map((m) => [m.name, m]))]));
  for (const r of rows) {
    const model = visible.get(r.endpoint_id)?.get(r.name);
    // Nicht sichtbare Modelle, und ohne Auswahl auch alle Dev-Modelle, werden ausgeblendet.
    if (!model || (!selected && model.environment === 'dev')) blocked.models.push([r.endpoint_id, r.name]);
  }
  const allowedEndpoints = filters.filter((f) => selected || f.environment !== 'dev').map((f) => f.id);
  return {
    allowedEndpoints,
    blockedEndpoints: blocked.models.map((x) => x[0]),
    blockedModels: blocked.models.map((x) => x[1]),
    selModels,
    selEndpoints,
    selected,
  };
}

// SQL-Fragment für Ergebnisse (Alias res) samt Parametern, ab Parameternummer n.
// Dashboard und Historie verwenden dasselbe: sichtbare Endpoints/Modelle (ohne Auswahl nur Prod) und die Auswahl als Vereinigung.
export function resultFilter(access, n) {
  const sql = `res.endpoint_id = any($${n}::uuid[])
    and not exists (select 1 from unnest($${n + 1}::uuid[], $${n + 2}::text[]) as b(e, m) where b.e = res.endpoint_id and b.m = res.model)
    and (cardinality($${n + 3}::text[]) + cardinality($${n + 4}::uuid[]) = 0
         or coalesce(res.model_alias, res.model) = any($${n + 3}::text[]) or res.endpoint_id = any($${n + 4}::uuid[]))`;
  return { sql, params: [access.allowedEndpoints, access.blockedEndpoints, access.blockedModels, access.selModels, access.selEndpoints] };
}
