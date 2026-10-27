// Aus einer Prüfung (oder einem Vorlagen-Entwurf) wird der Plan eines Laufs: Vorlage × Modell × Pfad, aufgelöst auf Endpoints
// der Plattform. Voraussetzungen (vision, tools, reasoning, mcp) und fehlende Endpoints führen zu "nicht anwendbar" statt zu Fehlern.
import { many, one } from './db.js';
import { SECURITY_TYPES } from './evaluate.js';
import { testTypes } from './testtypes/index.js';

export const PATHS = ['direct', 'gateway', 'both'];
const PATH_LABEL = { direct: 'direkt', gateway: 'Gateway' };

// Plattform mit Endpoints und Modellkatalog laden.
export async function platformContext(platformId) {
  const platform = await one('select * from platforms where id = $1', [platformId]);
  if (!platform) return null;
  const endpoints = await many('select e.* from endpoints e where e.platform_id = $1 and e.enabled order by e.kind, e.name', [platformId]);
  const models = await many(
    'select m.* from endpoint_models m join endpoints e on e.id = m.endpoint_id where e.platform_id = $1 and m.available and m.portfolio_id is not null',
    [platformId],
  );
  return { platform, endpoints: endpoints.map((e) => ({ ...e, modelRows: models.filter((m) => m.endpoint_id === e.id) })) };
}

const hasModel = (e, alias) => e.modelRows.some((m) => m.name === alias || m.alias === alias);

// Endpoint für Modell und Pfad: Gateway = ai_proxy, direkt = Inferenzserver (llm). Eigenes Modell zuerst, sonst der erste passende.
export function endpointFor(ctx, alias, path) {
  const kind = path === 'gateway' ? 'ai_proxy' : 'llm';
  const list = ctx.endpoints.filter((e) => e.kind === kind);
  return list.find((e) => hasModel(e, alias)) ?? (path === 'gateway' ? list[0] : null) ?? null;
}

// Fähigkeiten eines Modells: Vereinigung über alle Endpoints der Plattform, an denen es liegt.
export function capabilitiesOf(ctx, alias) {
  const caps = new Set();
  for (const e of ctx.endpoints) for (const m of e.modelRows) if (m.name === alias || m.alias === alias) for (const c of m.capabilities ?? []) caps.add(c);
  return caps;
}

function mergeParams(spec) {
  const config = { ...(spec.config ?? {}) };
  const p = spec.params ?? {};
  if (p.temperature !== undefined) config.temperature = p.temperature;
  if (p.max_tokens !== undefined) config.maxTokens = p.max_tokens;
  for (const [k, v] of Object.entries(p)) if (!['temperature', 'max_tokens'].includes(k)) config[k] = v;
  return config;
}

// Obergrenzen für Lasttests (Freigabe und Prüfung): Parallelität und Gesamtdauer.
export function capLoadConfig(config, limits = {}) {
  const maxC = Number(limits.max_concurrency) || null;
  const maxD = Number(limits.max_duration_s) || null;
  if (!config.stages || (!maxC && !maxD)) return config;
  let left = maxD ?? Infinity;
  const stages = [];
  for (const s of config.stages) {
    if (left <= 0) break;
    const durationS = Math.min(s.durationS, left);
    left -= durationS;
    stages.push({ ...s, concurrency: maxC ? Math.min(s.concurrency, maxC) : s.concurrency, durationS });
  }
  return { ...config, stages };
}

// Eine Vorlagenversion samt Kategorien laden (für Plan und Anzeige).
export async function loadTemplateVersions(ids) {
  if (!ids.length) return new Map();
  const rows = await many(
    `select v.id, v.version, v.status, v.spec, v.hash, t.id as template_id, t.key, t.name, t.type, t.target, t.use_cases, t.origin, t.tenant_id,
       coalesce((select jsonb_agg(jsonb_build_object('framework', c.framework, 'key', c.key, 'name', c.name))
                 from template_version_categories tc join categories c on c.id = tc.category_id where tc.version_id = v.id), '[]') as categories
     from template_versions v join templates t on t.id = v.template_id where v.id = any($1)`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

// Plan erzeugen. `models`: [{ alias, path, api_key_id? }], `items`: [{ template_version_id, endpoint_id?, thresholds }].
// Im Vergleichsmodus (A/B) tragen die Einzeltests die Variante. `limits` begrenzt Lasttests.
export async function buildPlan({ platformId, models, items, repeats, mode = 'standard', compare, limits = {} }) {
  const ctx = await platformContext(platformId);
  if (!ctx) throw Object.assign(new Error('Plattform nicht gefunden'), { statusCode: 400 });
  const versions = await loadTemplateVersions(items.map((i) => i.template_version_id));
  const selection = modelSelection(models, mode, compare);
  const plan = [];
  const push = (atom) => plan.push({ ...atom, idx: plan.length });

  for (const [itemIndex, item] of items.entries()) {
    const v = versions.get(item.template_version_id);
    if (!v) throw Object.assign(new Error(`Vorlagenversion ${item.template_version_id} nicht gefunden`), { statusCode: 400 });
    const type = testTypes[v.type];
    if (!type) throw Object.assign(new Error(`Unbekannter Testtyp "${v.type}"`), { statusCode: 400 });
    const spec = v.spec ?? {};
    const requires = spec.requires ?? [];
    const wantedRepeats = spec.load || v.type === 'load' ? 1 : Math.max(1, Number(repeats) || Number(spec.repeats) || 1);
    let config = mergeParams(spec);
    if (spec.load || v.type === 'load') config = capLoadConfig(config, limits);
    const base = {
      item_index: itemIndex,
      template_version_id: v.id,
      template_key: v.key,
      template_version: v.version,
      template_name: v.name,
      type: v.type,
      security: SECURITY_TYPES.includes(v.type),
      target: v.target,
      load: Boolean(spec.load || v.type === 'load'),
      use_cases: v.use_cases ?? [],
      categories: v.categories,
      dataset: spec.dataset ?? null,
      thresholds: item.thresholds ?? [],
      repeats: wantedRepeats,
      config,
      applicable: true,
      reason: null,
    };
    const skip = (extra, reason) => push({ ...base, ...extra, name: nameOf(v, extra), applicable: false, reason });
    const mode_ = type.modelMode ?? 'each';

    if (type.platformLevel) {
      push({ ...base, name: v.name, endpoint_id: null, endpoint_name: null, path: null, model: null });
      continue;
    }
    if (v.type === 'mcp') {
      const mcps = ctx.endpoints.filter((e) => e.kind === 'mcp' && (!item.endpoint_id || e.id === item.endpoint_id));
      if (!mcps.length) skip({ path: null, model: null }, 'Die Plattform hat keine MCP-Komponente');
      for (const e of mcps) push({ ...base, name: `${v.name} · ${e.name}`, endpoint_id: e.id, endpoint_name: e.name, path: null, model: null });
      continue;
    }
    if (mode_ === 'first') {
      // Zugriffstest: gegen das Gateway, mit dem ersten gewählten Modell.
      const gw = ctx.endpoints.find((e) => e.kind === 'ai_proxy');
      if (!gw) {
        skip({ path: 'gateway', model: null }, 'Die Plattform hat kein Gateway');
        continue;
      }
      const first = selection[0];
      push({ ...base, name: nameOf(v, {}), endpoint_id: gw.id, endpoint_name: gw.name, path: 'gateway', model: first?.alias ?? gw.default_model ?? null, api_key_id: first?.api_key_id ?? null });
      continue;
    }
    if (mode_ === 'list') {
      // Smoke: je Endpoint ein Test mit allen dort erwarteten Modellen.
      const byEndpoint = new Map();
      for (const sel of selection) {
        for (const p of expandPath(sel.path)) {
          const e = endpointFor(ctx, sel.alias, p);
          if (!e) continue;
          const entry = byEndpoint.get(e.id) ?? { endpoint: e, path: p, aliases: [], api_key_id: sel.api_key_id };
          entry.aliases.push(sel.alias);
          byEndpoint.set(e.id, entry);
        }
      }
      if (!byEndpoint.size) {
        const fallback = ctx.endpoints.filter((e) => ['ai_proxy', 'llm'].includes(e.kind));
        for (const e of fallback) byEndpoint.set(e.id, { endpoint: e, path: e.kind === 'llm' ? 'direct' : 'gateway', aliases: [] });
      }
      for (const { endpoint: e, path, aliases, api_key_id } of byEndpoint.values()) {
        push({ ...base, name: `${v.name} · ${e.name}`, endpoint_id: e.id, endpoint_name: e.name, path, model: null, api_key_id: api_key_id ?? null, config: { ...config, models: aliases } });
      }
      continue;
    }
    // each: Modell × Pfad
    for (const sel of selection) {
      for (const p of expandPath(sel.path)) {
        const extra = { model: sel.alias, path: p, variant: sel.variant ?? null, api_key_id: sel.api_key_id ?? null };
        const e = endpointFor(ctx, sel.alias, p);
        if (!e) {
          skip(extra, `Kein ${p === 'gateway' ? 'Gateway' : 'Inferenz-Endpoint'} mit Modell „${sel.alias}“ in der Plattform`);
          continue;
        }
        const caps = capabilitiesOf(ctx, sel.alias);
        const missing = requires.filter((r) => (r === 'mcp' ? !ctx.endpoints.some((x) => x.kind === 'mcp') : !caps.has(r)));
        if (missing.length) {
          skip({ ...extra, endpoint_id: e.id, endpoint_name: e.name }, `Voraussetzung nicht erfüllt: ${missing.join(', ')}`);
          continue;
        }
        push({ ...base, ...extra, name: nameOf(v, extra), endpoint_id: e.id, endpoint_name: e.name });
      }
    }
  }
  return plan;
}

const nameOf = (v, { model, path, variant } = {}) =>
  [v.name, model, path ? PATH_LABEL[path] : null, variant ? `Variante ${variant}` : null].filter(Boolean).join(' · ');

const expandPath = (path) => (path === 'both' ? ['direct', 'gateway'] : [path === 'direct' ? 'direct' : 'gateway']);

// Im Vergleichsmodus entstehen aus der Auswahl die Varianten A und B.
function modelSelection(models, mode, compare) {
  if (mode !== 'compare' || !compare) return models;
  if (compare.kind === 'paths') {
    const m = compare.model ?? models[0]?.alias;
    return [
      { alias: m, path: 'direct', variant: 'A' },
      { alias: m, path: 'gateway', variant: 'B' },
    ];
  }
  return [
    { alias: compare.a, path: compare.path ?? models[0]?.path ?? 'gateway', variant: 'A' },
    { alias: compare.b, path: compare.path ?? models[0]?.path ?? 'gateway', variant: 'B' },
  ];
}

export function validateModels(models) {
  if (!Array.isArray(models)) throw Object.assign(new Error('Modelle müssen eine Liste sein'), { statusCode: 400 });
  return models.map((m) => {
    const alias = typeof m === 'string' ? m : m.alias;
    if (!alias) throw Object.assign(new Error('Modell ohne Namen'), { statusCode: 400 });
    const path = typeof m === 'string' ? 'gateway' : (m.path ?? 'gateway');
    if (!PATHS.includes(path)) throw Object.assign(new Error(`Ungültiger Pfad „${path}“`), { statusCode: 400 });
    return { alias, path, ...(m.api_key_id ? { api_key_id: m.api_key_id } : {}) };
  });
}
