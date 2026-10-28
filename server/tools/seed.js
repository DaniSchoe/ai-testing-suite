// Demo-Daten für lokale Entwicklung und CI: Mandant "Standard" mit Mock-Plattformen (Dev und Prod), API-Keys,
// Modellmetadaten und Beispielprüfungen aus dem offiziellen Katalog.
// Aufruf: MOCK_URL=http://localhost:4000 node tools/seed.js
import { encrypt } from '../src/crypto.js';
import { one, many, pool, query } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { syncEndpointModels } from '../src/models.js';

const MOCK_URL = process.env.MOCK_URL ?? 'http://localhost:4000';

await migrate();
const tenant = await one(`select id from tenants where key = 'default'`);

async function upsertKey(k) {
  return one(
    `insert into api_keys (tenant_id, name, description, secret_enc, visibility, admin_only) values ($1, $2, $3, $4, 'global', $5)
     on conflict (tenant_id, name) do update set secret_enc = excluded.secret_enc, description = excluded.description, admin_only = excluded.admin_only returning *`,
    [tenant.id, k.name, k.description, encrypt(k.secret), k.admin_only ?? false],
  );
}

async function upsertPlatform(p) {
  return one(
    `insert into platforms (tenant_id, name, description, environment, sovereignty) values ($1, $2, $3, $4, $5)
     on conflict (tenant_id, name) do update set description = excluded.description, environment = excluded.environment returning *`,
    [tenant.id, p.name, p.description, p.environment, JSON.stringify(p.sovereignty ?? {})],
  );
}

async function upsertComponent(platform, c) {
  return one(
    `insert into endpoints (tenant_id, platform_id, name, kind, spec, metrics_url) values ($1, $2, $3, $4, $5, $6)
     on conflict (tenant_id, name) do update set platform_id = excluded.platform_id, spec = excluded.spec, metrics_url = excluded.metrics_url returning *`,
    [tenant.id, platform.id, c.name, c.kind, JSON.stringify(c.spec), c.metrics_url ?? null],
  );
}

async function upsertEndpoint(platform, e) {
  const key = e.api_key ? await upsertKey({ name: `${e.name} Key`, description: 'Demo-Key', secret: e.api_key, admin_only: true }) : null;
  const row = await one(
    `insert into endpoints (tenant_id, platform_id, name, kind, llm_flavor, base_url, api_key_id, default_model) values ($1, $2, $3, $4, 'openai', $5, $6, $7)
     on conflict (tenant_id, name) do update set platform_id = excluded.platform_id, base_url = excluded.base_url, api_key_id = excluded.api_key_id, default_model = excluded.default_model returning *`,
    [tenant.id, platform.id, e.name, e.kind, e.base_url, key?.id ?? null, e.default_model],
  );
  if (e.kind !== 'mcp') {
    const withKey = await one(`select e.*, k.secret_enc as api_key_enc from endpoints e left join api_keys k on k.id = e.api_key_id where e.id = $1`, [row.id]);
    await syncEndpointModels(withKey);
  }
  return row;
}

await upsertKey({ name: 'admin', description: 'Plattform-Admin, alle Modelle und Tools', secret: 'sk-admin' });
await upsertKey({ name: 'team-a', description: 'Fachbereich A, nur mock-small und Tool "search"', secret: 'sk-team-a' });
await upsertKey({ name: 'limited', description: 'Key mit 10 RPM', secret: 'sk-limited' });

const platforms = {};
for (const env of ['dev', 'prod']) {
  const suffix = env === 'prod' ? ' (Prod)' : '';
  const platform = await upsertPlatform({
    name: `Mock-Plattform${suffix}`,
    description: 'LiteLLM-Gateway, vLLM und MCP als Mock für Entwicklung und CI',
    environment: env,
    sovereignty: { min_level: 2, overrides: {} },
  });
  const gateway = await upsertEndpoint(platform, { name: `LiteLLM (Mock)${suffix}`, kind: 'ai_proxy', base_url: MOCK_URL, api_key: 'sk-admin', default_model: 'mock-small' });
  const mcp = await upsertEndpoint(platform, { name: `MCP Gateway (Mock)${suffix}`, kind: 'mcp', base_url: `${MOCK_URL}/mcp`, api_key: 'sk-admin' });
  await query(`update endpoints set api_key_id = null, auth_token_enc = $2, spec = $3 where id = $1`, [mcp.id, encrypt('sk-admin'), JSON.stringify({ auth: { type: 'bearer' } })]);
  // vLLM ohne Auth; das Modell heißt dort anders als im Gateway und bekommt deshalb einen Alias.
  const vllm = await upsertEndpoint(platform, { name: `vLLM Qwen3 (Mock)${suffix}`, kind: 'llm', base_url: `${MOCK_URL}/vllm-qwen`, default_model: 'qwen3-32b' });
  await query(`update endpoint_models set alias = 'qwen3-32b' where endpoint_id = $1 and name = 'Qwen/Qwen3-32B'`, [vllm.id]);
  await query(`insert into platform_routes (platform_id, gateway_endpoint_id, backend_endpoint_id, models, mappings) values ($1, $2, $3, '{Qwen/Qwen3-32B}', '[{"gateway_model":"qwen3-32b","backend_model":"Qwen/Qwen3-32B"}]') on conflict do nothing`, [platform.id, gateway.id, vllm.id]);
  // Metrik-Endpunkte des Mock-Servers, damit Lasttests Messwerte der Komponenten erfassen.
  await query(
    `insert into platform_sizing (platform_id, config) values ($1, $2) on conflict (platform_id) do nothing`,
    [platform.id, JSON.stringify({ metrics: Object.fromEntries(['gpu', 'inference', 'gateway'].map((k) => [k, { urls: [`${MOCK_URL}/metrics/${k}`], api_key_id: null }])) })],
  );
  await query(`update endpoints set spec = $2, metrics_url = $3 where id = $1`, [gateway.id, JSON.stringify({ product: 'litellm', instances: 2 }), `${MOCK_URL}/metrics/gateway`]);
  await query(`update endpoints set spec = $2, metrics_url = $3 where id = $1`, [vllm.id, JSON.stringify({ provider: 'vllm', hosting: 'self', served_models: ['Qwen/Qwen3-32B'] }), `${MOCK_URL}/metrics/inference`]);
  // Inventar: Rechenzentrum, Kubernetes, zwei GPUs (eine mit MIG) und ihre Zuordnung.
  const dc = await upsertComponent(platform, { name: `Rechenzentrum Frankfurt${suffix}`, kind: 'datacenter', spec: { provider: 'on_prem', on_prem: true, region: 'Frankfurt', country: 'DE', certifications: ['ISO 27001', 'BSI C5'], renewable_energy: true, pue: 1.3 } });
  const k8s = await upsertComponent(platform, { name: `Kubernetes${suffix}`, kind: 'kubernetes', spec: { operation: 'self_managed', distribution: 'rke2', version: '1.31', certifications: [] } });
  const gpu1 = await upsertComponent(platform, { name: `GPU H100 #1${suffix}`, kind: 'gpu', metrics_url: `${MOCK_URL}/metrics/gpu`, spec: { gpu_type: 'h100', memory_gb: 80, mig: { enabled: true, layout: [{ profile: '3g.40gb', slices: 3, memory_gb: 40 }, { profile: '4g.40gb', slices: 4, memory_gb: 40 }] } } });
  const gpu2 = await upsertComponent(platform, { name: `GPU H100 #2${suffix}`, kind: 'gpu', metrics_url: `${MOCK_URL}/metrics/gpu`, spec: { gpu_type: 'h100', memory_gb: 80, mig: { enabled: false, layout: [] } } });
  const server = await upsertComponent(platform, { name: `GPU-Server 1${suffix}`, kind: 'server', spec: { server_type: 'gpu', model: 'Dell PowerEdge XE9680', cpu_cores: 112, ram_gb: 2048, storage_tb: 30 } });
  const nvlink = await upsertComponent(platform, { name: `NVLink${suffix}`, kind: 'interconnect', spec: { type: 'nvlink', bundles: [{ id: 'b1', name: 'H100 Verbund', mode: 'nvlink', gpu_ids: [gpu1.id, gpu2.id] }] } });
  await query('update endpoints set spec = $2 where id = $1', [k8s.id, JSON.stringify({ operation: 'self_managed', distribution: 'rke2', version: '1.31', certifications: [], nodes: [{ server_id: server.id, role: 'gpu' }] })]);
  await query('delete from platform_links where platform_id = $1', [platform.id]);
  const link = (kind, from, to, data = {}) => query('insert into platform_links (platform_id, kind, from_id, to_id, data) values ($1, $2, $3, $4, $5)', [platform.id, kind, from.id, to.id, JSON.stringify(data)]);
  await link('hosted_in', k8s, dc);
  await link('hosted_in', server, dc);
  await link('cluster', server, k8s);
  await link('hosted_in', gpu1, server);
  await link('hosted_in', gpu2, server);
  await link('runs_on', vllm, gpu2);
  const layout = { placed: { datacenter: [dc.id], server: [server.id], interconnect: [nvlink.id], orchestration: [k8s.id], inference: [vllm.id], gateway: [gateway.id], mcp: [mcp.id] }, collapsed: {} };
  await query('update platforms set layout = $2 where id = $1', [platform.id, JSON.stringify(layout)]);
  platforms[env] = { platform, gateway, vllm, mcp };
}

// Modellportfolio: fachliche Modelle aus den gefundenen Modellen der Endpoints (mehrere Endpoints können dasselbe Modell liefern).
async function portfolioModel(name, meta, members) {
  const p = await one(
    `insert into portfolio_models (tenant_id, name, provider, license, origin, open_weights, revision, quantization, capabilities, context_length, visibility)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'global')
     on conflict (tenant_id, name) do update set provider = excluded.provider, license = excluded.license, origin = excluded.origin, open_weights = excluded.open_weights,
       revision = excluded.revision, quantization = excluded.quantization, capabilities = excluded.capabilities, context_length = excluded.context_length returning *`,
    [tenant.id, name, meta.provider, meta.license, meta.origin, meta.open_weights, meta.revision ?? null, meta.quantization ?? null, meta.capabilities, meta.context_length ?? null],
  );
  for (const [endpointId, modelName] of members) {
    await query(
      `update endpoint_models set portfolio_id = $3, alias = $4, license = $5, provider = $6, origin = $7, open_weights = $8, revision = $9, quantization = $10, capabilities = $11, context_length = $12
       where endpoint_id = $1 and name = $2`,
      [endpointId, modelName, p.id, p.name, p.license, p.provider, p.origin, p.open_weights, p.revision, p.quantization, p.capabilities, p.context_length],
    );
  }
}
const both = (pick) => ['dev', 'prod'].map((env) => pick(platforms[env]));
await portfolioModel('mock-small', { provider: 'Mock AG', license: 'MIT', origin: 'DE', open_weights: true, revision: 'mock-1', capabilities: ['tools', 'json'] }, both((p) => [p.gateway.id, 'mock-small']));
await portfolioModel('mock-large', { provider: 'Mock AG', license: 'proprietär', origin: 'DE', open_weights: false, capabilities: ['tools', 'json', 'vision'] }, both((p) => [p.gateway.id, 'mock-large']));
await portfolioModel(
  'qwen3-32b',
  { provider: 'Alibaba Cloud', license: 'Apache-2.0', origin: 'CN', open_weights: true, revision: 'a9c98e6', quantization: 'bf16', capabilities: ['tools', 'json', 'reasoning'], context_length: 32768 },
  both((p) => [p.vllm.id, 'Qwen/Qwen3-32B']).concat(both((p) => [p.gateway.id, 'qwen3-32b'])),
);

// Modell für die KI-Analyse der Läufe (Einstellung je Mandant).
await query(`insert into app_settings (key, value) values ($1, $2) on conflict (key) do nothing`, [`analysis_model:${tenant.id}`, JSON.stringify({ endpoint_id: platforms.dev.gateway.id, model: 'mock-large' })]);

// Veröffentlichte Version einer Vorlage (offiziell, neueste).
async function versionOf(key) {
  const row = await one(
    `select v.id, v.spec from template_versions v join templates t on t.id = v.template_id where t.key = $1 and t.tenant_id is null and v.status = 'published'
     order by string_to_array(v.version, '.')::int[] desc limit 1`,
    [key],
  );
  if (!row) throw new Error(`Offizielle Vorlage ${key} fehlt`);
  return row;
}
async function item(key, thresholds) {
  const v = await versionOf(key);
  return { template_version_id: v.id, thresholds: thresholds ?? v.spec.suggested_thresholds ?? [] };
}
const keyId = async (name) => (await one('select id from api_keys where tenant_id = $1 and name = $2', [tenant.id, name])).id;

const audits = [
  {
    name: 'Nightly Gateway',
    description: 'Smoke, Qualität und Security über das Gateway',
    platform: 'dev',
    models: [{ alias: 'mock-small', path: 'gateway' }, { alias: 'mock-large', path: 'gateway' }],
    items: [await item('smoke-health'), await item('quality-reasoning', [{ metric: 'score', op: '>=', value: 0.3 }]), await item('security-owasp', [{ metric: 'score', op: '>=', value: 0.5 }]),],
    repeats: 1,
  },
  {
    name: 'Zugriff Team A',
    description: 'Darf der Key von Team A nur mock-small nutzen und keine Admin-Routen?',
    platform: 'dev',
    key: 'team-a',
    models: [{ alias: 'mock-small', path: 'gateway' }],
    items: [await item('access-keys')],
    repeats: 1,
  },
  {
    name: 'Performance der Modelle',
    description: 'Streaming-Performance, direkt (vLLM) und über das Gateway',
    platform: 'dev',
    models: [{ alias: 'mock-small', path: 'gateway' }, { alias: 'qwen3-32b', path: 'both' }],
    items: [await item('performance-streaming', [{ metric: 'error_rate', op: '<=', value: 0.1 }])],
    repeats: 2,
  },
  {
    name: 'Qwen3: direkt gegen Gateway',
    description: 'Vergleichsmodus: dasselbe Modell direkt und über das Gateway',
    platform: 'dev',
    mode: 'compare',
    compare: { kind: 'paths', model: 'qwen3-32b' },
    models: [{ alias: 'qwen3-32b', path: 'both' }],
    items: [await item('quality-reasoning', [{ metric: 'score', op: '>=', value: 0.2 }])],
    repeats: 1,
  },
  {
    name: 'Dokumente (OCR)',
    description: 'Rechnung und Prüfbericht als Bild; nur Modelle mit Vision',
    platform: 'dev',
    models: [{ alias: 'mock-large', path: 'gateway' }, { alias: 'mock-small', path: 'gateway' }],
    items: [await item('ocr-documents')],
    repeats: 1,
  },
  {
    name: 'Coding und Tool-Calling',
    description: 'Programmieraufgaben und Tool-Aufrufe',
    platform: 'dev',
    models: [{ alias: 'mock-small', path: 'gateway' }, { alias: 'mock-large', path: 'gateway' }],
    items: [await item('coding-js', [{ metric: 'score', op: '>=', value: 0.3 }]), await item('structured-tools')],
    repeats: 1,
  },
  {
    name: 'MCP-Freigaben',
    description: 'Welche Tools sieht der Key auf dem MCP-Gateway?',
    platform: 'dev',
    models: [],
    items: [await item('mcp-tools', [])],
    repeats: 1,
  },
  {
    name: 'Prod-Abnahme',
    description: 'Smoke und Performance auf der Prod-Plattform (braucht eine Freigabe)',
    platform: 'prod',
    models: [{ alias: 'mock-small', path: 'gateway' }],
    items: [await item('smoke-health'), await item('performance-streaming', [{ metric: 'error_rate', op: '<=', value: 0.1 }])],
    repeats: 1,
  },
];

let count = 0;
for (const a of audits) {
  const platform = platforms[a.platform].platform;
  const values = [a.name, a.description, platform.id, JSON.stringify(a.models), JSON.stringify(a.items), a.repeats ?? 1, a.mode ?? 'standard', a.compare ? JSON.stringify(a.compare) : null, await keyId(a.key ?? 'admin')];
  const existing = await one('select id from audits where tenant_id = $1 and name = $2', [tenant.id, a.name]);
  if (existing) {
    await query(`update audits set description = $3, platform_id = $4, models = $5, items = $6, repeats = $7, mode = $8, compare = $9, api_key_id = $10, updated_at = now() where id = $1 and tenant_id = $2`, [existing.id, tenant.id, ...values.slice(1)]);
  } else {
    await query(
      `insert into audits (tenant_id, name, description, platform_id, models, items, repeats, mode, compare, api_key_id, visibility, baseline_auto) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'global', true)`,
      [tenant.id, ...values],
    );
  }
  count += 1;
}

console.log(`Seed fertig: ${count} Prüfungen, 2 Plattformen (Dev, Prod), 3 API-Keys`);
await pool.end();
