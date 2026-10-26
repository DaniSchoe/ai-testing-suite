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
    sovereignty: { min_level: 2, goals: { 'SOV-3': { level: 3, note: 'Modelle laufen im eigenen Rechenzentrum' }, 'SOV-4': { level: 3 }, 'SOV-6': { level: 2, note: 'Open-Weights-Modelle, Gateway quelloffen' } } },
  });
  const gateway = await upsertEndpoint(platform, { name: `LiteLLM (Mock)${suffix}`, kind: 'ai_proxy', base_url: MOCK_URL, api_key: 'sk-admin', default_model: 'mock-small' });
  const mcp = await upsertEndpoint(platform, { name: `MCP Gateway (Mock)${suffix}`, kind: 'mcp', base_url: `${MOCK_URL}/mcp`, api_key: 'sk-admin' });
  // vLLM ohne Auth; das Modell heißt dort anders als im Gateway und bekommt deshalb einen Alias.
  const vllm = await upsertEndpoint(platform, { name: `vLLM Qwen3 (Mock)${suffix}`, kind: 'llm', base_url: `${MOCK_URL}/vllm-qwen`, default_model: 'qwen3-32b' });
  await query(`update endpoint_models set alias = 'qwen3-32b' where endpoint_id = $1 and name = 'Qwen/Qwen3-32B'`, [vllm.id]);
  // Metadaten des Modellkatalogs (Lizenz, Herkunft, Fähigkeiten).
  await query(`update endpoint_models set license = 'Apache-2.0', provider = 'Alibaba Cloud', origin = 'CN', open_weights = true, revision = 'a9c98e6', quantization = 'bf16', capabilities = '{tools,json,reasoning}', context_length = 32768 where endpoint_id = $1`, [vllm.id]);
  await query(`update endpoint_models set capabilities = '{tools,json}', license = 'MIT', provider = 'Mock AG', origin = 'DE', open_weights = true, revision = 'mock-1' where endpoint_id = $1 and name = 'mock-small'`, [gateway.id]);
  await query(`update endpoint_models set capabilities = '{tools,json,vision}', license = 'proprietär', provider = 'Mock AG', origin = 'DE', open_weights = false where endpoint_id = $1 and name = 'mock-large'`, [gateway.id]);
  await query(`update endpoint_models set capabilities = '{tools,json,reasoning}', license = 'Apache-2.0', provider = 'Alibaba Cloud', origin = 'CN', open_weights = true, revision = 'a9c98e6' where endpoint_id = $1 and name = 'qwen3-32b'`, [gateway.id]);
  await query(`insert into platform_routes (platform_id, gateway_endpoint_id, backend_endpoint_id, models) values ($1, $2, $3, '{qwen3-32b}') on conflict do nothing`, [platform.id, gateway.id, vllm.id]);
  // Metrik-Endpunkte des Mock-Servers, damit Lasttests Messwerte der Komponenten erfassen.
  await query(
    `insert into platform_sizing (platform_id, config) values ($1, $2) on conflict (platform_id) do nothing`,
    [platform.id, JSON.stringify({ metrics: Object.fromEntries(['gpu', 'inference', 'gateway'].map((k) => [k, { urls: [`${MOCK_URL}/metrics/${k}`], api_key_id: null }])) })],
  );
  platforms[env] = { platform, gateway, vllm, mcp };
}

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
