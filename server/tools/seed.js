// Demo-Daten für lokale Entwicklung: API-Keys, Mock-Endpoints, Beispieltests (Test-Builder).
// Aufruf: MOCK_URL=http://localhost:4000 node tools/seed.js
import { encrypt } from '../src/crypto.js';
import { one, pool, query } from '../src/db.js';
import { syncAtoms } from '../src/builds.js';
import { migrate } from '../src/migrate.js';
import { syncEndpointModels } from '../src/models.js';

const MOCK_URL = process.env.MOCK_URL ?? 'http://localhost:4000';

await migrate();

async function upsertKey(k) {
  return one(
    `insert into api_keys (name, description, secret_enc, visibility, admin_only)
     values ($1, $2, $3, 'global', $4)
     on conflict (name) do update set secret_enc = excluded.secret_enc, description = excluded.description
     returning *`,
    [k.name, k.description, encrypt(k.secret), k.admin_only ?? false],
  );
}

async function upsertEndpoint(e) {
  const key = e.api_key ? await upsertKey({ name: `${e.name} Key`, description: 'Demo-Key', secret: e.api_key, admin_only: true }) : null;
  const row = await one(
    `insert into endpoints (name, kind, llm_flavor, base_url, api_key_id, default_model)
     values ($1, $2, 'openai', $3, $4, $5)
     on conflict (name) do update set base_url = excluded.base_url, api_key_id = excluded.api_key_id,
       default_model = excluded.default_model
     returning *`,
    [e.name, e.kind, e.base_url, key?.id ?? null, e.default_model],
  );
  if (e.kind !== 'mcp') {
    const withKey = await one(`select e.*, k.secret_enc as api_key_enc from endpoints e left join api_keys k on k.id = e.api_key_id where e.id = $1`, [row.id]);
    await syncEndpointModels(withKey);
  }
  return row;
}

const gateway = await upsertEndpoint({
  name: 'LiteLLM (Mock)',
  kind: 'ai_proxy',
  base_url: MOCK_URL,
  api_key: 'sk-admin',
  default_model: 'mock-small',
});
const mcpServer = await upsertEndpoint({ name: 'MCP Gateway (Mock)', kind: 'mcp', base_url: `${MOCK_URL}/mcp`, api_key: 'sk-admin' });
// vLLM ohne Auth; das Modell heißt dort anders als im Gateway und bekommt deshalb einen Alias.
const vllm = await upsertEndpoint({ name: 'vLLM Qwen3 (Mock)', kind: 'llm', base_url: `${MOCK_URL}/vllm-qwen`, default_model: 'qwen3-32b' });
await query(`update endpoint_models set alias = 'qwen3-32b' where endpoint_id = $1 and name = 'Qwen/Qwen3-32B'`, [vllm.id]);

await upsertKey({ name: 'admin', description: 'Plattform-Admin, alle Modelle und Tools', secret: 'sk-admin', admin_only: true });
await upsertKey({ name: 'team-a', description: 'Fachbereich A, nur mock-small und Tool "search"', secret: 'sk-team-a', admin_only: true });
await upsertKey({ name: 'limited', description: 'Key mit 10 RPM', secret: 'sk-limited', admin_only: true });

const tests = [
  { name: 'Smoke: Gateway', type: 'smoke', endpoint: gateway, config: {} },
  { name: 'Performance: mock-small', type: 'performance', endpoint: gateway, config: { model: 'mock-small', requests: 12, concurrency: 3 } },
  { name: 'Performance: mock-large', type: 'performance', endpoint: gateway, config: { model: 'mock-large', requests: 12, concurrency: 3 } },
  { name: 'Last: Ramp-up kurz', type: 'load', endpoint: gateway, config: { stages: [{ durationS: 3, concurrency: 2 }, { durationS: 3, concurrency: 8 }] } },
  { name: 'Qualität: Basiswissen', type: 'quality', endpoint: gateway, config: { model: 'mock-small' } },
  { name: 'Vergleich: small vs. large', type: 'comparison', endpoint: gateway, config: { models: ['mock-small', 'mock-large'] } },
  {
    name: 'Vergleich: qwen3 über LiteLLM vs. vLLM direkt',
    type: 'comparison',
    endpoint: gateway,
    config: {
      targets: [
        { endpoint: 'LiteLLM (Mock)', model: 'qwen3-32b' },
        { endpoint: 'vLLM Qwen3 (Mock)', model: 'qwen3-32b' },
      ],
    },
  },
  { name: 'Smoke: vLLM Qwen3', type: 'smoke', endpoint: vllm, config: {} },
  { name: 'Thinking: Qwen3 mit und ohne Reasoning', type: 'thinking', endpoint: vllm, config: { judgeModel: 'qwen3-32b' } },
  { name: 'Security & DLP: Standardkatalog', type: 'security', endpoint: gateway, config: {} },
  { name: 'Tool-Calling: Wetter', type: 'structured', endpoint: gateway, config: {} },
  {
    name: 'Zugriff: Modellfreigaben je Team',
    type: 'access',
    endpoint: gateway,
    config: {
      cases: [
        { apiKey: 'admin', model: 'mock-large', expect: 'allow' },
        { apiKey: 'team-a', model: 'mock-small', expect: 'allow' },
        { apiKey: 'team-a', model: 'mock-large', expect: 'deny' },
        { apiKey: 'team-a', method: 'GET', path: '/key/list', expect: 'deny' },
        { apiKey: null, model: 'mock-small', expect: 'deny', name: 'Ohne Credentials' },
      ],
    },
  },
  {
    name: 'MCP: Tool-Freigaben je User',
    type: 'mcp',
    endpoint: mcpServer,
    config: {
      apiKeys: [
        { apiKey: 'admin', expectTools: ['search', 'delete_records'] },
        { apiKey: 'team-a', expectTools: ['search'], forbiddenTools: ['delete_records'] },
      ],
      calls: [
        { apiKey: 'team-a', tool: 'search', arguments: { q: 'Vertrag' }, expect: 'allow', assert: [{ type: 'contains', value: 'Treffer' }] },
        { apiKey: 'team-a', tool: 'delete_records', arguments: {}, expect: 'deny' },
      ],
    },
  },
  { name: 'Rate-Limit: 10 RPM Key', type: 'ratelimit', endpoint: gateway, apiKey: 'limited', config: { burst: 15, expectedLimit: 10 } },
];

// Beispiele für den Test-Builder: ein gebündelter Test (Nightly Gateway) und je ein Test für den Rest.
const nightly = ['Smoke: Gateway', 'Qualität: Basiswissen', 'Security & DLP: Standardkatalog', 'Zugriff: Modellfreigaben je Team'];
const groups = [
  { name: 'Nightly Gateway', description: 'Smoke, Qualität, Security und Berechtigungen', members: tests.filter((t) => nightly.includes(t.name)) },
  ...tests.filter((t) => !nightly.includes(t.name)).map((t) => ({ name: t.name, members: [t] })),
];

let atoms = 0;
for (const g of groups) {
  const first = g.members[0];
  const key = first.apiKey ? await one('select id from api_keys where name = $1', [first.apiKey]) : null;
  const configs = Object.fromEntries(g.members.map((t) => [t.type, t.config]));
  const values = [g.name, g.description ?? null, first.endpoint.id, key?.id ?? null, g.members.map((t) => t.type), configs];
  const existing = await one('select id from tests where name = $1', [g.name]);
  const build = existing
    ? await one(
        `update tests set description = $2, endpoint_id = $3, api_key_id = $4, types = $5, configs = $6, updated_at = now()
         where id = $1 returning *`,
        [existing.id, ...values.slice(1)],
      )
    : await one(
        `insert into tests (name, description, endpoint_id, api_key_id, types, configs, visibility)
         values ($1, $2, $3, $4, $5, $6, 'global') returning *`,
        values,
      );
  atoms += await syncAtoms(pool, build);
}

console.log(`Seed fertig: ${groups.length} Tests (${atoms} Einzeltests), 3 API-Keys`);
await pool.end();
