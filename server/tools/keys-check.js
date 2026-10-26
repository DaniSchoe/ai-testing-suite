// End-to-End-Prüfung von API-Key-Sammlung, Endpoint-Arten, Veröffentlichung und Modellkatalog.
// Voraussetzung: Server im Dev-Modus und mock-llm.js laufen. Aufruf: node tools/keys-check.js [http://localhost:8080]
import assert from 'node:assert/strict';

const base = process.argv[2] ?? 'http://localhost:8080';
const mock = process.env.MOCK_URL ?? 'http://localhost:4000';
const suffix = Date.now().toString(36);

async function login(as) {
  const res = await fetch(`${base}/auth/login${as ? `?as=${as}` : ''}`, { redirect: 'manual' });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, text, data: text ? JSON.parse(text) : null };
  };
}
const step = (name) => console.log(`✓ ${name}`);

const admin = await login();
const bob = await login(`bob-${suffix}`);
const carol = await login(`carol-${suffix}`);
const bobMe = (await bob('/api/me')).data;
const carolMe = (await carol('/api/me')).data;
const roles = (await admin('/api/roles')).data;
await admin(`/api/users/${bobMe.id}`, { method: 'PUT', body: { roleIds: [roles.find((r) => r.key === 'tester').id] } });

const team = (await admin('/api/teams', { method: 'POST', body: { name: `Keys ${suffix}`, memberIds: [bobMe.id] } })).data;
const otherTeam = (await admin('/api/teams', { method: 'POST', body: { name: `Andere ${suffix}` } })).data;

// --- API-Keys ---
const secret = `sk-secret-${suffix}`;
let r = await bob('/api/api-keys', { method: 'POST', body: { name: `bob-${suffix}`, secret, visibility: 'user' } });
assert.equal(r.status, 200);
assert.ok(!r.text.includes(secret), 'Secret wird nie ausgeliefert');
assert.match(r.data.masked, /^••••/);
assert.equal((await carol('/api/api-keys')).data.some((k) => k.name === `bob-${suffix}`), false);
step('User legt privaten Key an, Secret nur maskiert, andere sehen ihn nicht');

assert.equal((await bob('/api/api-keys', { method: 'POST', body: { name: `g-${suffix}`, secret: 'x', visibility: 'global' } })).status, 403);
assert.equal((await bob('/api/api-keys', { method: 'POST', body: { name: `a-${suffix}`, secret: 'x', admin_only: true } })).status, 403);
assert.equal((await bob('/api/api-keys', { method: 'POST', body: { name: `t-${suffix}`, secret: 'x', visibility: 'teams', teamIds: [otherTeam.id] } })).status, 403);
r = await bob('/api/api-keys', { method: 'POST', body: { name: `team-${suffix}`, secret: 'x', visibility: 'teams', teamIds: [team.id] } });
assert.equal(r.status, 200);
step('Nicht-Admin: kein globaler/Admin-Key, Team-Key nur für eigene Teams');

const globalKey = (await admin('/api/api-keys', { method: 'POST', body: { name: `global-${suffix}`, secret: 'sk-global', visibility: 'global' } })).data;
const adminKey = (await admin('/api/api-keys', { method: 'POST', body: { name: `admin-${suffix}`, secret: 'sk-admin', visibility: 'global', admin_only: true } })).data;
const names = (await bob('/api/api-keys')).data.map((k) => k.name);
assert.ok(names.includes(`global-${suffix}`) && !names.includes(`admin-${suffix}`));
assert.ok((await admin('/api/api-keys')).data.some((k) => k.name === `admin-${suffix}`));
assert.equal((await carol('/api/api-keys')).data.some((k) => k.name === `team-${suffix}`), false, 'Team-Key nur im Team');
await admin(`/api/api-keys/${globalKey.id}`, { method: 'PUT', body: { name: `global-${suffix}`, visibility: 'user', userIds: [carolMe.id] } });
assert.ok((await carol('/api/api-keys')).data.some((k) => k.id === globalKey.id), 'Einzelner User zugeordnet');
assert.equal((await bob('/api/api-keys')).data.some((k) => k.id === globalKey.id), false);
assert.equal((await bob(`/api/api-keys/${globalKey.id}`, { method: 'DELETE' })).status, 403);
step('Globale Keys, nur-Admin-Keys, Zuordnung an einzelne User');

// --- Endpoints ---
assert.equal((await bob('/api/endpoints', { method: 'POST', body: { name: 'x', kind: 'llm', base_url: mock } })).status, 403);
const claudeKey = (await admin('/api/api-keys', { method: 'POST', body: { name: `claude-${suffix}`, secret: 'sk-claude', visibility: 'global' } })).data;
const probe = await admin('/api/endpoints/test', { method: 'POST', body: { kind: 'llm', llm_flavor: 'claude', base_url: `${mock}/claude`, api_key_id: claudeKey.id } });
assert.deepEqual([probe.data.ok, probe.data.models], [true, ['claude-mock-1']]);
const bad = await admin('/api/endpoints/test', { method: 'POST', body: { kind: 'llm', llm_flavor: 'claude', base_url: `${mock}/claude`, api_key_id: adminKey.id } });
assert.equal(bad.data.ok, false);
step('Nur Admins legen Endpoints an, Verbindungstest vor dem Speichern (Claude-Flavor)');

const created = (await admin('/api/endpoints', {
  method: 'POST',
  body: { name: `Claude ${suffix}`, kind: 'llm', llm_flavor: 'claude', base_url: `${mock}/claude`, api_key_id: claudeKey.id, maintainer_id: bobMe.id, environment: 'dev', visibility: 'teams', teamIds: [team.id] },
})).data;
assert.deepEqual(created.discovered.models, ['claude-mock-1']);
assert.equal(created.endpoint.llm_flavor, 'claude');
assert.equal(created.endpoint.has_api_key, true);
assert.ok(!JSON.stringify(created).includes('sk-claude'));
step('Anlegen liefert die gelesenen Modelle für das Popup');

const adminsOnly = (await admin('/api/endpoints', { method: 'POST', body: { name: `Intern ${suffix}`, kind: 'llm', base_url: `${mock}/vllm-qwen`, visibility: 'admins' } })).data.endpoint;
const visible = async (s) => (await s('/api/endpoints')).data.map((e) => e.name);
assert.ok((await visible(bob)).includes(`Claude ${suffix}`), 'Team-Mitglied sieht Team-Endpoint');
assert.ok(!(await visible(carol)).includes(`Claude ${suffix}`), 'Fremde sehen ihn nicht');
assert.ok(!(await visible(bob)).includes(`Intern ${suffix}`), 'admins-only unsichtbar');
assert.ok((await visible(admin)).includes(`Intern ${suffix}`));
step('Veröffentlichung: Admins, Teams, global');

// --- Modelle ---
const model = (await bob('/api/models')).data.find((m) => m.endpoint_id === created.endpoint.id);
assert.equal(model.name, 'claude-mock-1');
assert.equal(model.effective_environment, 'dev');
assert.equal(model.can_edit, false);
assert.equal((await bob('/api/endpoint-models', { method: 'PUT', body: { endpoint_id: model.endpoint_id, name: model.name, alias: 'x' } })).status, 403);
await admin('/api/endpoint-models', { method: 'PUT', body: { endpoint_id: model.endpoint_id, name: model.name, alias: 'claude-alias', maintainer_id: bobMe.id, environment: 'prod', visibility: 'global' } });
r = await bob('/api/endpoint-models', { method: 'PUT', body: { endpoint_id: model.endpoint_id, name: model.name, alias: 'claude-bob', maintainer_id: bobMe.id, environment: 'dev', visibility: 'teams', teamIds: [team.id] } });
assert.equal(r.status, 200);
assert.equal(r.data.alias, 'claude-bob');
step('Modelle: nur Admin oder Maintainer dürfen bearbeiten');

// --- Test mit Claude-Endpoint ausführen (Chat und Streaming über die Übersetzung) ---
const keyTest = await bob('/api/tests', { method: 'POST', body: { name: `Fremder Key ${suffix}`, type: 'smoke', endpoint_id: created.endpoint.id, api_key_id: adminKey.id } });
assert.equal(keyTest.status, 403, 'Nur sichtbare Keys im Test');
for (const [type, config] of [['smoke', {}], ['performance', { model: 'claude-bob', requests: 3, concurrency: 1 }], ['quality', { model: 'claude-bob' }]]) {
  const test = (await admin('/api/tests', { method: 'POST', body: { name: `Claude ${type} ${suffix}`, type, endpoint_id: created.endpoint.id, config } })).data;
  const run = (await admin('/api/runs', { method: 'POST', body: { kind: 'single', testIds: [test.id] } })).data;
  let res;
  for (let i = 0; i < 60; i++) {
    res = (await admin(`/api/runs/${run.id}`)).data;
    if (!['queued', 'running'].includes(res.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const result = res.results[0];
  assert.ok(['passed', 'failed'].includes(result.status) && !result.error, `${type}: ${result.status} ${result.error}`);
  if (type !== 'quality') assert.equal(result.status, 'passed', `${type}: ${result.error}`);
}
step('Tests laufen über Claude-Flavor (Chat und Streaming)');

assert.equal((await admin('/api/personas')).status, 404);
step('Personas-API entfernt');
console.log('API-Key- und Endpoint-Prüfung erfolgreich');
