// Prüft die Dashboard-Filter (Prod-Standard, Dev nur für Admins, Auswahl summiert) und die neuen Auswertungen.
// Aufruf: (Server, Mock und Demo-Daten mit mindestens einem abgeschlossenen Lauf aller Tests) node tools/dashboard-check.js
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
const dash = async (user, qs = '') => (await user(`/api/dashboard?scope=all&days=30${qs}`)).data;

const full = await dash(admin);
assert.ok(full.kpis.results > 0, 'es gibt Ergebnisse');
assert.equal(full.selection.isDefault, true);
assert.ok(full.quality.score !== null, 'Gauge hat einen Wert');
assert.ok(full.loadPoints.length > 0, 'Lastpunkte vorhanden');
assert.ok(full.loadPoints.every((p) => p.concurrency && p.latency_ms_p95 != null));
const prof = full.profiles.find((m) => m.load_score != null);
assert.ok(prof && prof.latency_ms != null && prof.ttft_ms != null && prof.quality != null, "Modellprofil mit Kennzahlen");
step('Standardansicht, Gauge, Lastpunkte, Radar-Rohwerte');

// Historie: Läufe als Bündel mit Bestanden/Fehlgeschlagen, gleiche Filter wie das Dashboard.
const hist = (await admin('/api/history?scope=all&pageSize=50')).data;
assert.ok(hist.total > 0 && hist.runs.length > 0, 'Historie hat Läufe');
for (const r of hist.runs) {
  assert.equal(r.results.length, r.total, 'Bündel enthält alle Einzelergebnisse');
  assert.equal(r.passed + r.failed + r.errored <= r.total, true);
}
const failedOnly = (await admin('/api/history?scope=all&status=failed&pageSize=50')).data;
assert.ok(failedOnly.runs.every((r) => r.failed > 0), 'Statusfilter zeigt nur Läufe mit Fehlschlägen');
const someModel = hist.runs.flatMap((r) => r.results).find((x) => x.model)?.model_alias ?? hist.runs.flatMap((r) => r.results).find((x) => x.model)?.model;
const byModel2 = (await admin(`/api/history?scope=all&models=${encodeURIComponent(someModel)}&pageSize=50`)).data;
assert.ok(byModel2.runs.length > 0 && byModel2.runs.every((r) => r.results.every((x) => (x.model_alias ?? x.model) === someModel)), 'Modellfilter');
step('Historie: Bündel und Filter')

const filters = (await admin('/api/dashboard/filters')).data;
const vllm = filters.find((f) => f.name === 'vLLM Qwen3 (Mock)');
assert.ok(vllm && vllm.models.every((m) => m.alias));
const gateway = filters.find((f) => f.name === 'LiteLLM (Mock)');

// Endpoint auf Dev stellen: aus Standardansicht und für Nicht-Admins verschwunden, für Admins auswählbar.
const ep = (await admin('/api/endpoints')).data.find((e) => e.id === vllm.id);
const put = (environment) =>
  admin(`/api/endpoints/${ep.id}`, { method: 'PUT', body: { ...ep, environment, api_key_id: ep.api_key_id, teamIds: ep.teamIds, manual_models: [] } });
try {
  assert.equal((await put('dev')).status, 200);
  const prodOnly = await dash(admin);
  assert.ok(prodOnly.kpis.results < full.kpis.results, 'Dev-Endpoint fehlt in der Standardansicht');
  const picked = await dash(admin, `&endpoints=${ep.id}`);
  assert.equal(picked.selection.isDefault, false);
  assert.ok(picked.kpis.results > 0 && picked.kpis.results < full.kpis.results, 'Auswahl zeigt nur den Dev-Endpoint');
  assert.equal(prodOnly.kpis.results + picked.kpis.results, full.kpis.results, 'Prod und Dev ergeben zusammen alles');

  const bob = await login(`bob-${suffix}`);
  const roles = (await admin('/api/roles')).data;
  const bobMe = (await bob('/api/me')).data;
  await admin(`/api/users/${bobMe.id}`, { method: 'PUT', body: { roleIds: [roles.find((r) => r.key === 'tester').id] } });
  assert.ok(!(await bob('/api/dashboard/filters')).data.some((f) => f.id === ep.id), 'Dev-Endpoint nicht in der Filterliste');
  assert.ok(!(await admin('/api/dashboard/filters')).data.every((f) => f.id !== ep.id), 'Admin sieht ihn');
  const bobPick = (await bob(`/api/dashboard?scope=me&days=30&endpoints=${ep.id}`)).data;
  assert.equal(bobPick.kpis.results, 0, 'Nicht-Admin kann Dev nicht per URL erzwingen');
  step('Prod-Standard, Dev nur für Admins auswählbar');
} finally {
  await put('prod');
}

// Mehrere Modelle bzw. ganze Endpoints summieren sich.
const a = await dash(admin, `&endpoints=${gateway.id}`);
const b = await dash(admin, `&endpoints=${vllm.id}`);
const both = await dash(admin, `&endpoints=${gateway.id},${vllm.id}`);
assert.equal(a.kpis.results + b.kpis.results, both.kpis.results, 'Endpoints werden summiert');
const model = gateway.models[0].alias;
const byModel = await dash(admin, `&models=${encodeURIComponent(model)}`);
assert.ok(byModel.kpis.results > 0 && byModel.kpis.results <= full.kpis.results);
assert.ok(byModel.profiles.every((m) => m.model === model), 'Tabelle zeigt nur das gewählte Modell');
step('Mehrfachauswahl wird summiert');
console.log('Dashboard-Prüfung erfolgreich');
