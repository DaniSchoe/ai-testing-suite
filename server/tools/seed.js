// Demo-Daten für lokale Entwicklung: Mock-Endpoints, Personas, Beispieltests und eine Suite.
// Aufruf: MOCK_URL=http://localhost:4000 node tools/seed.js
import { encrypt } from '../src/crypto.js';
import { one, pool, query } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const MOCK_URL = process.env.MOCK_URL ?? 'http://localhost:4000';

await migrate();

async function upsertEndpoint(e) {
  return one(
    `insert into endpoints (name, kind, base_url, api_key_enc, models, default_model)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (name) do update set base_url = excluded.base_url, api_key_enc = excluded.api_key_enc,
       models = excluded.models, default_model = excluded.default_model
     returning *`,
    [e.name, e.kind, e.base_url, encrypt(e.api_key), e.models, e.default_model],
  );
}

async function upsertPersona(p) {
  return one(
    `insert into personas (name, description, auth_type, secret_enc, attributes)
     values ($1, $2, 'api_key', $3, $4)
     on conflict (name) do update set secret_enc = excluded.secret_enc, description = excluded.description
     returning *`,
    [p.name, p.description, encrypt(p.secret), p.attributes ?? {}],
  );
}

const gateway = await upsertEndpoint({
  name: 'LiteLLM (Mock)',
  kind: 'litellm',
  base_url: MOCK_URL,
  api_key: 'sk-admin',
  models: ['mock-small', 'mock-large'],
  default_model: 'mock-small',
});
const mcpServer = await upsertEndpoint({ name: 'MCP Gateway (Mock)', kind: 'mcp', base_url: `${MOCK_URL}/mcp`, api_key: 'sk-admin', models: [] });

await upsertPersona({ name: 'admin', description: 'Plattform-Admin, alle Modelle und Tools', secret: 'sk-admin' });
await upsertPersona({ name: 'team-a', description: 'Fachbereich A, nur mock-small und Tool "search"', secret: 'sk-team-a' });
await upsertPersona({ name: 'limited', description: 'Key mit 10 RPM', secret: 'sk-limited' });

const tests = [
  { name: 'Smoke: Gateway', type: 'smoke', endpoint: gateway, config: {} },
  { name: 'Performance: mock-small', type: 'performance', endpoint: gateway, config: { model: 'mock-small', requests: 12, concurrency: 3 } },
  { name: 'Performance: mock-large', type: 'performance', endpoint: gateway, config: { model: 'mock-large', requests: 12, concurrency: 3 } },
  { name: 'Last: Ramp-up kurz', type: 'load', endpoint: gateway, config: { stages: [{ durationS: 3, concurrency: 2 }, { durationS: 3, concurrency: 8 }] } },
  { name: 'Qualität: Basiswissen', type: 'quality', endpoint: gateway, config: { model: 'mock-small' } },
  { name: 'Vergleich: small vs. large', type: 'comparison', endpoint: gateway, config: { models: ['mock-small', 'mock-large'] } },
  { name: 'Security & DLP: Standardkatalog', type: 'security', endpoint: gateway, config: {} },
  { name: 'Tool-Calling: Wetter', type: 'structured', endpoint: gateway, config: {} },
  {
    name: 'Zugriff: Modellfreigaben je Team',
    type: 'access',
    endpoint: gateway,
    config: {
      cases: [
        { persona: 'admin', model: 'mock-large', expect: 'allow' },
        { persona: 'team-a', model: 'mock-small', expect: 'allow' },
        { persona: 'team-a', model: 'mock-large', expect: 'deny' },
        { persona: 'team-a', method: 'GET', path: '/key/list', expect: 'deny' },
        { persona: null, model: 'mock-small', expect: 'deny', name: 'Ohne Credentials' },
      ],
    },
  },
  {
    name: 'MCP: Tool-Freigaben je User',
    type: 'mcp',
    endpoint: mcpServer,
    config: {
      personas: [
        { persona: 'admin', expectTools: ['search', 'delete_records'] },
        { persona: 'team-a', expectTools: ['search'], forbiddenTools: ['delete_records'] },
      ],
      calls: [
        { persona: 'team-a', tool: 'search', arguments: { q: 'Vertrag' }, expect: 'allow', assert: [{ type: 'contains', value: 'Treffer' }] },
        { persona: 'team-a', tool: 'delete_records', arguments: {}, expect: 'deny' },
      ],
    },
  },
  { name: 'Rate-Limit: 10 RPM Key', type: 'ratelimit', endpoint: gateway, persona: 'limited', config: { burst: 15, expectedLimit: 10 } },
];

const ids = [];
for (const t of tests) {
  const persona = t.persona ? await one('select id from personas where name = $1', [t.persona]) : null;
  const existing = await one('select id from test_definitions where name = $1', [t.name]);
  const row = existing
    ? await one('update test_definitions set config = $2, endpoint_id = $3, persona_id = $4 where id = $1 returning id', [
        existing.id,
        t.config,
        t.endpoint.id,
        persona?.id ?? null,
      ])
    : await one(
        'insert into test_definitions (name, type, endpoint_id, persona_id, config) values ($1, $2, $3, $4, $5) returning id',
        [t.name, t.type, t.endpoint.id, persona?.id ?? null, t.config],
      );
  ids.push(row.id);
}

const suite = await one(
  `insert into suites (name, description) values ('Nightly Gateway', 'Smoke, Qualität, Security und Berechtigungen')
   on conflict (name) do update set description = excluded.description returning id`,
);
await query('delete from suite_tests where suite_id = $1', [suite.id]);
for (const [i, id] of [ids[0], ids[4], ids[6], ids[8], ids[9]].entries()) {
  await query('insert into suite_tests (suite_id, test_id, position) values ($1, $2, $3)', [suite.id, id, i]);
}

console.log(`Seed fertig: ${tests.length} Tests, 1 Suite, 3 Personas`);
await pool.end();
