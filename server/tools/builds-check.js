// End-to-End-Prüfung des Test-Builders: Testarten × Modelle, Ausführung, Zeitpläne, Kalender, Veröffentlichung.
// Aufruf: (Server und Mock laufen, Demo-Daten per tools/seed.js) node tools/builds-check.js [http://localhost:8080]
import assert from 'node:assert/strict';

const base = process.argv[2] ?? 'http://localhost:8080';
const suffix = Date.now().toString(36);

async function login(as) {
  const res = await fetch(`${base}/auth/login${as ? `?as=${as}` : ''}`, { redirect: 'manual' });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
}
const step = (name) => console.log(`✓ ${name}`);

const admin = await login();
const endpoints = (await admin('/api/endpoints')).data;
const gateway = endpoints.find((e) => e.kind === 'ai_proxy');
const llm = endpoints.find((e) => e.kind === 'llm' && e.llm_flavor === 'openai');
assert.ok(gateway && llm);

const builds = (await admin('/api/builds')).data;
assert.ok(builds.length >= 10, 'migrierte/seeded Tests sichtbar');
assert.ok(builds.some((b) => b.types.length > 1), 'gebündelter Test vorhanden');
step('Test-Liste');

// Testarten × Modelle
const spec = {
  name: `Builder ${suffix}`,
  description: 'E2E',
  tags: ['e2e'],
  endpoint_id: gateway.id,
  models: ['mock-small', 'mock-large'],
  types: ['smoke', 'performance'],
  configs: { performance: { requests: 4, concurrency: 2 } },
};
const preview = (await admin('/api/builds/preview', { method: 'POST', body: spec })).data;
assert.equal(preview.count, 3, 'smoke (Liste) + performance je Modell');
assert.ok(preview.estimate_ms > 0 && ['history', 'estimate', 'mixed'].includes(preview.basis), 'Laufzeitschätzung vorhanden');
assert.equal(preview.tests, undefined, 'die Zusammenfassung nennt keine einzelnen Tests');
assert.equal((await admin('/api/builds', { method: 'POST', body: { ...spec, types: [] } })).status, 400);
assert.equal((await admin('/api/builds', { method: 'POST', body: { ...spec, endpoint_id: llm.id, types: ['mcp'] } })).status, 400, 'MCP passt nicht zu LLM-Endpoint');
step('Vorschau der Einzeltests, Validierung');

const created = await admin('/api/builds', { method: 'POST', body: { ...spec, schedule: { mode: 'now' } } });
assert.equal(created.status, 200);
const build = created.data.build;
const run = created.data.run;
assert.equal(run.total, 3);
for (let i = 0; i < 60; i++) {
  const r = (await admin(`/api/runs/${run.id}`)).data;
  if (!['queued', 'running'].includes(r.status)) {
    assert.equal(r.results.length, 3);
    assert.deepEqual(r.results.map((x) => x.model).filter(Boolean).sort().slice(0, 2), ['mock-large', 'mock-small']);
    break;
  }
  await new Promise((res) => setTimeout(res, 1000));
  assert.ok(i < 59, 'Lauf wird fertig');
}
assert.equal((await admin(`/api/builds/${build.id}`)).data.run_count, 1);
step('Test speichern und sofort ausführen (Testart × Modell)');

// Änderung behält die IDs der Einzeltests, entfernte Modelle verschwinden
const updated = await admin(`/api/builds/${build.id}`, { method: 'PUT', body: { ...spec, models: ['mock-small'], schedule: { mode: 'save' } } });
assert.equal(updated.status, 200);
assert.equal((await admin('/api/builds/preview', { method: 'POST', body: { ...spec, models: ['mock-small'] } })).data.count, 2);
step('Test ändern');

// Zeitpläne und Kalender
const in2h = new Date(Date.now() + 2 * 3600_000).toISOString();
assert.equal((await admin(`/api/builds/${build.id}`, { method: 'PUT', body: { ...spec, schedule: { mode: 'once', run_at: '2020-01-01T00:00:00Z' } } })).status, 400);
assert.equal((await admin(`/api/builds/${build.id}`, { method: 'PUT', body: { ...spec, schedule: { mode: 'recurring', cron: 'nope' } } })).status, 400);
let r = await admin(`/api/builds/${build.id}`, { method: 'PUT', body: { ...spec, schedule: { mode: 'once', run_at: in2h } } });
assert.equal(r.status, 200);
assert.equal(r.data.build.schedule_run_at, in2h);
const from = new Date(Date.now() - 3600_000).toISOString();
const to = new Date(Date.now() + 5 * 86400_000).toISOString();
let cal = (await admin(`/api/calendar?from=${from}&to=${to}&scope=all`)).data;
assert.equal(cal.filter((e) => e.kind === 'planned' && e.build_id === build.id).length, 1, 'einmaliger Zeitpunkt im Kalender');
r = await admin(`/api/builds/${build.id}`, { method: 'PUT', body: { ...spec, schedule: { mode: 'recurring', cron: '0 6 * * *' } } });
assert.equal(r.data.build.schedule_cron, '0 6 * * *');
cal = (await admin(`/api/calendar?from=${from}&to=${to}&scope=all`)).data;
assert.ok(cal.filter((e) => e.kind === 'planned' && e.build_id === build.id).length >= 4, 'Cron wird zu mehreren Terminen');
assert.ok(cal.some((e) => e.kind === 'run'), 'bisherige Läufe im Kalender');
assert.equal((await admin(`/api/calendar?from=${from}&to=2099-01-01`)).status, 400);
step('Einmalig und regelmäßig planen, Kalender');

// Ein einmaliger Zeitpunkt in Kürze startet genau einen Lauf.
const soon = await admin('/api/builds', {
  method: 'POST',
  body: { ...spec, name: `Einmalig ${suffix}`, models: [], types: ['smoke'], schedule: { mode: 'once', run_at: new Date(Date.now() + 4000).toISOString() } },
});
assert.equal(soon.status, 200);
let fired;
for (let i = 0; i < 30 && !fired; i++) {
  await new Promise((res) => setTimeout(res, 1000));
  fired = (await admin('/api/runs?scope=all&limit=20')).data.find((x) => x.build_id === soon.data.build.id);
}
assert.ok(fired, 'einmaliger Lauf wurde gestartet');
assert.equal(fired.trigger, 'schedule');
assert.equal((await admin(`/api/builds/${soon.data.build.id}`)).data.schedule_enabled, false, 'einmaliger Zeitplan ist danach erledigt');
await admin(`/api/builds/${soon.data.build.id}`, { method: 'DELETE' });
step('Einmaliger Zeitpunkt löst Lauf aus');

// Sichtbarkeit und Veröffentlichung
const bob = await login(`bob-${suffix}`);
const bobMe = (await bob('/api/me')).data;
assert.ok(!(await bob('/api/builds')).data.some((b) => b.id === build.id), 'privater Test ist für andere unsichtbar');
assert.equal((await bob(`/api/builds/${build.id}`)).status, 404);
const team = (await admin('/api/teams', { method: 'POST', body: { name: `BT ${suffix}`, memberIds: [bobMe.id] } })).data;
const roles = (await admin('/api/roles')).data;
await admin(`/api/users/${bobMe.id}`, { method: 'PUT', body: { roleIds: [roles.find((x) => x.key === 'tester').id] } });
await admin(`/api/builds/${build.id}/publish`, { method: 'POST', body: { visibility: 'teams', teamIds: [team.id], requires_api_key: true } });
assert.ok((await bob('/api/builds')).data.some((b) => b.id === build.id), 'Team-Mitglied sieht den Test');

// Marketplace: Detail, Merkliste, Ausführen mit eigenem Key
const detail = (await bob(`/api/marketplace/${build.id}`)).data;
assert.equal(detail.requires_api_key, true);
assert.equal(detail.endpoint.name, gateway.name);
assert.equal(detail.configs, undefined, 'Konfiguration nur für Berechtigte');
assert.ok((await admin(`/api/marketplace/${build.id}`)).data.configs);
assert.equal((await bob(`/api/builds/${build.id}/watch`, { method: 'POST' })).status, 200);
assert.equal((await bob(`/api/builds/${build.id}/watch`, { method: 'POST' })).status, 200, 'doppelt merken ist harmlos');
assert.equal((await bob(`/api/marketplace/${build.id}`)).data.watch_count, 1);
assert.equal((await bob(`/api/marketplace/${build.id}`)).data.watched, true);
assert.equal((await bob(`/api/builds/${build.id}/run`, { method: 'POST', body: {} })).status, 400, 'eigener Key ist Pflicht');
const adminKey = (await admin('/api/api-keys')).data.find((k) => k.admin_only);
assert.equal((await bob(`/api/builds/${build.id}/run`, { method: 'POST', body: { api_key_id: adminKey.id } })).status, 403, 'fremden Key nicht nutzbar');
const bobKey = (await bob('/api/api-keys', { method: 'POST', body: { name: `bob-key-${suffix}`, secret: 'sk-admin', visibility: 'user' } })).data;
const bobRun = await bob(`/api/builds/${build.id}/run`, { method: 'POST', body: { api_key_id: bobKey.id } });
assert.equal(bobRun.status, 200);
for (let i = 0; i < 60; i++) {
  const r = (await bob(`/api/runs/${bobRun.data.id}`)).data;
  if (!['queued', 'running'].includes(r.status)) {
    assert.ok(r.results.every((x) => x.api_key_name === `bob-key-${suffix}`), 'Lauf nutzt den eigenen Key');
    break;
  }
  await new Promise((res) => setTimeout(res, 1000));
}
assert.equal((await bob(`/api/builds/${build.id}/watch`, { method: 'DELETE' })).status, 200);
assert.equal((await bob(`/api/marketplace/${build.id}`)).data.watch_count, 0);
step('Marketplace: Detail, Merkliste, Ausführen mit eigenem Key');
assert.equal((await bob(`/api/builds/${build.id}`, { method: 'PUT', body: spec })).status, 403, 'Fremde dürfen nicht ändern');
assert.equal((await bob(`/api/builds/${build.id}/publish`, { method: 'POST', body: { visibility: 'global' } })).status, 403);
const other = (await admin('/api/teams', { method: 'POST', body: { name: `BT2 ${suffix}` } })).data;
const bobBuild = await bob('/api/builds', { method: 'POST', body: { ...spec, name: `Bob ${suffix}`, schedule: { mode: 'save' } } });
assert.equal(bobBuild.status, 200);
assert.equal((await bob(`/api/builds/${bobBuild.data.build.id}/publish`, { method: 'POST', body: { visibility: 'teams', teamIds: [other.id] } })).status, 403, 'nur eigene Teams');
await admin(`/api/builds/${build.id}/unpublish`, { method: 'POST' });
assert.ok(!(await bob('/api/builds')).data.some((b) => b.id === build.id), 'zurückgezogen');
step('Veröffentlichen, zurückziehen, Rechte');

assert.equal((await admin(`/api/builds/${build.id}`, { method: 'DELETE' })).status, 200);
assert.equal((await admin(`/api/builds/${build.id}`)).status, 404);
step('Löschen');
console.log('Test-Builder-Prüfung erfolgreich');
