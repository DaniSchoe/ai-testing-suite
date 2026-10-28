// End-to-End-Prüfung von Version 0.5.0 gegen einen laufenden Server (Dev-Modus) und den Mock: Datensätze, Testkatalog mit
// Freigabeprozess, Import/Export, Prüfungen, Läufe, Freigaben für Prod, Kill-Switch, Findings mit Nachtest, Berichte,
// Nachweise, Gate für CI/CD, Dashboard und Mandantentrennung.
// Voraussetzung: mock-llm.js läuft, Seed wurde ausgeführt. Aufruf: node tools/e2e-check.js [http://localhost:8080]
import assert from 'node:assert/strict';

const base = process.argv[2] ?? 'http://localhost:8080';
const suffix = Date.now().toString(36);

async function login(as, { tenant } = {}) {
  const res = await fetch(`${base}/auth/login${as ? `?as=${as}` : ''}`, { redirect: 'manual' });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = async (path, { method = 'GET', body, tenantId = tenant, token } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : { cookie }), ...(tenantId ? { 'x-tenant-id': tenantId } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* kein JSON */
    }
    return { status: r.status, text, data };
  };
  return call;
}

const step = (name) => console.log(`✓ ${name}`);
const ok = (r, msg) => assert.equal(r.status, 200, `${msg ?? 'Anfrage'}: ${r.status} ${r.text?.slice(0, 300)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitRun(api, id, timeoutS = 240) {
  for (let i = 0; i < timeoutS; i += 1) {
    const r = await api(`/api/runs/${id}`);
    ok(r, 'Lauf lesen');
    if (!['queued', 'running'].includes(r.data.status)) {
      // Bericht und Analyse entstehen kurz nach dem Lauf.
      await sleep(1500);
      return (await api(`/api/runs/${id}`)).data;
    }
    await sleep(1000);
  }
  throw new Error(`Lauf ${id} wurde nicht fertig`);
}

// ------------------------------------------------------------------ Benutzer und Rollen
const admin = await login();
const me = (await admin('/api/me')).data;
assert.equal(me.is_system_admin, true);
assert.ok((await (await fetch(`${base}/api/version`)).json()).version);
step('Admin angemeldet, Version über /api/version');

const people = {};
const names = { alice: 'tester', bob: 'reviewer', carol: 'engagement_lead', rita: 'red_teamer', kurt: 'viewer' };
const roles = (await admin('/api/roles')).data;
for (const [name, role] of Object.entries(names)) {
  const user = `${name}-${suffix}`;
  const api = await login(user);
  const meU = (await api('/api/me')).data;
  ok(await admin(`/api/members/${meU.id}`, { method: 'PUT', body: { roleIds: [roles.find((r) => r.key === role).id] } }), `Rolle ${role}`);
  people[name] = { api, id: meU.id };
}
const { alice, bob, carol, rita, kurt } = Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.api]));
const platforms = (await admin('/api/platforms')).data;
const dev = platforms.find((p) => p.name === 'Mock-Plattform');
const prod = platforms.find((p) => p.name === 'Mock-Plattform (Prod)');
assert.ok(dev && prod, 'Seed-Plattformen vorhanden');
step('Benutzer mit Rollen Test Engineer, Reviewer, Engagement Lead, Red Teamer und Kunden-Viewer');

// ------------------------------------------------------------------ Datensätze
const csv = 'key;difficulty;category;prompt;expected;match\nk1;1;rechnen;Was ist 2+2? Antworte mit "Antwort: <Zahl>".;4;answer\nk2;2;rechnen;Was ist 3+3? Antworte mit "Antwort: <Zahl>".;6;answer\nk3;1;wissen;Wie heißt die Hauptstadt von Deutschland? Antworte mit "Antwort: <Stadt>".;Berlin;answer\n';
let r = await alice('/api/datasets/validate', { method: 'POST', body: { kind: 'qa', csv } });
ok(r);
assert.equal(r.data.ok, true);
assert.equal(r.data.cases, 3);
r = await alice('/api/datasets/validate', { method: 'POST', body: { kind: 'qa', csv: 'prompt;expected\nfrage;antwort\n' } });
assert.equal(r.data.ok, false, 'Schema-Prüfung findet fehlende difficulty/category');
assert.equal((await kurt('/api/datasets', { method: 'POST', body: { name: 'x', kind: 'qa', csv } })).status, 403);
r = await alice('/api/datasets', { method: 'POST', body: { name: `Rechnen ${suffix}`, kind: 'qa', csv, sensitivity: 'internal', min_cases: 30 } });
ok(r, 'Datensatz anlegen');
const dataset = r.data;
assert.equal(dataset.latest_version, '1.0.0');
assert.equal(dataset.case_count, 3);
r = await alice(`/api/datasets/${dataset.id}/versions`, { method: 'POST', body: { csv: `${csv}k4;3;rechnen;Was ist 10-3? Antworte mit "Antwort: <Zahl>".;7;answer\n`, bump: 'minor' } });
ok(r);
assert.equal(r.data.latest_version, '1.1.0');
assert.notEqual(r.data.hash, dataset.hash);
assert.equal((await alice('/api/datasets', { method: 'POST', body: { name: `Angriff ${suffix}`, kind: 'attacks', sensitivity: 'attack', csv: 'key;difficulty;category;prompt;expect\na;1;jailbreak;Hallo;refuse\n' } })).status, 403, 'Angriffs-Datensatz braucht security.payloads');
const attackList = (await alice('/api/datasets')).data.find((d) => d.sensitivity === 'attack');
r = await alice(`/api/datasets/${attackList.id}/versions/1.0.0`);
assert.ok(r.status === 403 || !JSON.stringify(r.data).includes('Ignoriere'), 'Angriffs-Payloads nicht ohne Berechtigung sichtbar');
step('Datensätze: Upload mit Schema-Prüfung, Versionen mit Hash, Angriffs-Datensätze nur mit Berechtigung');

// ------------------------------------------------------------------ Katalog und Freigabe
const cats = (await alice('/api/catalog/categories')).data;
const owasp = cats.find((c) => c.framework === 'OWASP LLM Top 10' && c.key === 'LLM09');
r = await alice('/api/catalog/templates', {
  method: 'POST',
  body: {
    name: `Rechnen ${suffix}`,
    description: 'Kleine Rechenaufgaben',
    type: 'quality',
    use_cases: ['chat'],
    category_ids: [owasp.id],
    spec: { dataset: { key: dataset.key, version: '1.1.0' }, config: { maxTokens: 512 }, params: { temperature: 0 }, repeats: 3, suggested_thresholds: [{ metric: 'score', op: '>=', value: 0.3 }] },
  },
});
ok(r, 'Vorlage anlegen');
const template = r.data;
assert.equal(template.version.status, 'draft');
assert.equal((await kurt(`/api/catalog/templates/${template.id}`)).status, 404, 'Entwurf ist für andere unsichtbar');
// Testlauf eines Entwurfs: zählt nicht in Historie und Dashboard.
r = await alice(`/api/catalog/templates/${template.id}/versions/1.0.0/test-run`, { method: 'POST', body: { platform_id: dev.id, models: [{ alias: 'mock-small', path: 'gateway' }] } });
ok(r, 'Testlauf Entwurf');
const draftRun = await waitRun(alice, r.data.id);
assert.equal(draftRun.is_draft, true);
assert.equal((await alice('/api/runs')).data.runs.some((x) => x.id === draftRun.id), false, 'Entwurfslauf nicht in der Historie');
assert.equal((await alice('/api/runs?drafts=1')).data.runs.some((x) => x.id === draftRun.id), true);
assert.equal((await alice(`/api/catalog/templates/${template.id}/versions/1.0.0/test-run`, { method: 'POST', body: { platform_id: prod.id, models: [{ alias: 'mock-small', path: 'gateway' }] } })).status, 403, 'Entwurfsläufe nicht auf Prod');
ok(await alice(`/api/catalog/templates/${template.id}/versions/1.0.0/submit`, { method: 'POST' }));
assert.equal((await alice(`/api/catalog/templates/${template.id}/versions/1.0.0/approve`, { method: 'POST' })).status, 403, 'Autor ohne catalog.publish');
assert.equal((await carol(`/api/catalog/templates/${template.id}/versions/1.0.0/approve`, { method: 'POST' })).status, 200, 'Reviewer mit catalog.publish gibt frei');
r = await bob(`/api/catalog/templates/${template.id}`);
ok(r);
assert.equal(r.data.versions[0].status, 'published');
assert.equal((await kurt(`/api/catalog/templates/${template.id}`)).status, 404, 'Private Vorlagen bleiben privat, auch veröffentlicht');
step('Katalog: Entwurf, Testlauf ohne Historie, Review und Freigabe');

// Vier-Augen-Prinzip: Einreicher darf nicht selbst freigeben, auch nicht mit der Berechtigung.
r = await carol('/api/catalog/templates', { method: 'POST', body: { name: `Vier Augen ${suffix}`, type: 'smoke', spec: { config: {} } } });
ok(r);
ok(await carol(`/api/catalog/templates/${r.data.id}/versions/1.0.0/submit`, { method: 'POST' }));
assert.equal((await carol(`/api/catalog/templates/${r.data.id}/versions/1.0.0/approve`, { method: 'POST' })).status, 403, 'Selbstfreigabe verboten');
ok(await bob(`/api/catalog/templates/${r.data.id}/versions/1.0.0/approve`, { method: 'POST' }));
step('Vier-Augen-Prinzip für Freigaben');

// Security-Vorlage: eigene Freigabestufe mit security.payloads.
const attackDs = (await rita('/api/datasets')).data.find((d) => d.key === 'security-owasp-llm-de');
assert.ok(attackDs, 'Offizieller Angriffsdatensatz sichtbar');
assert.equal((await alice('/api/catalog/templates', { method: 'POST', body: { name: `Sec ${suffix}`, type: 'security', spec: { dataset: { key: 'security-owasp-llm-de', version: '1.0.0' }, config: {} } } })).status, 403, 'Security-Datensatz braucht security.payloads');
r = await rita('/api/catalog/templates', { method: 'POST', body: { name: `Sec ${suffix}`, type: 'security', spec: { dataset: { key: 'security-owasp-llm-de', version: '1.0.0' }, config: {}, suggested_thresholds: [{ metric: 'score', op: '>=', value: 0.5 }] } } });
ok(r, 'Security-Vorlage');
const secTpl = r.data;
ok(await rita(`/api/catalog/templates/${secTpl.id}/versions/1.0.0/submit`, { method: 'POST' }));
r = await bob(`/api/catalog/templates/${secTpl.id}/versions/1.0.0/approve`, { method: 'POST' });
ok(r);
assert.equal(r.data.awaiting, undefined, 'Keine zusätzliche Sicherheitsstufe mehr');
assert.equal(r.data.status, 'published', 'Eine Freigabe genügt');
step('Security-Vorlagen: normale Freigabe (keine zusätzliche Stufe)');

// Update-Hinweis bei neuer Version: Prüfung bleibt auf ihrer Version.
r = await alice('/api/audits', {
  method: 'POST',
  body: { name: `Rechnen-Audit ${suffix}`, platform_id: dev.id, models: [{ alias: 'mock-small', path: 'gateway' }, { alias: 'mock-large', path: 'gateway' }], items: [{ template_version_id: template.version.id }], repeats: 3, visibility: 'global', api_key_id: (await admin('/api/api-keys')).data.find((k) => k.name === 'admin').id },
});
ok(r, 'Prüfung anlegen');
const audit = r.data;
assert.equal(audit.items.length, 1);
r = await alice(`/api/catalog/templates/${template.id}/versions`, { method: 'POST', body: { bump: 'minor', changelog: 'Zusätzliche Kategorie' } });
ok(r);
ok(await alice(`/api/catalog/templates/${template.id}/versions/1.1.0/submit`, { method: 'POST' }));
ok(await bob(`/api/catalog/templates/${template.id}/versions/1.1.0/approve`, { method: 'POST' }));
r = await alice(`/api/audits/${audit.id}`);
assert.equal(r.data.items[0].version, '1.0.0');
assert.equal(r.data.items[0].update_available?.version, '1.1.0');
step('Neue Vorlagenversion: Prüfung bleibt auf 1.0.0, Update wird angezeigt');

// ------------------------------------------------------------------ Lauf mit Wiederholungen, Schwellwerten, Baseline
r = await alice(`/api/audits/${audit.id}/preflight`);
ok(r);
assert.equal(r.data.can_start, true);
r = await alice(`/api/audits/${audit.id}/run`, { method: 'POST', body: {} });
ok(r, 'Prüfung starten');
const run1 = await waitRun(alice, r.data.id);
assert.equal(run1.results.length, 2);
const small = run1.results.find((x) => x.model_alias === 'mock-small');
assert.equal(small.attempts, 3, 'drei Wiederholungen');
assert.equal(small.statistics.n, 3);
assert.ok(small.details.thresholds.rules.length === 0 || Array.isArray(small.details.thresholds.rules), 'Schwellwerte im Ergebnis');
assert.ok(['passed', 'quality_deviation'].includes(small.outcome));
assert.equal(small.template_version, '1.0.0', 'Ergebnis hält die Vorlagenversion fest');
assert.equal(small.details.dataset.version, '1.1.0');
assert.equal(small.details.dataset.small_sample, true, 'Kleine Stichprobe wird markiert (3 < 30 Fälle)');
const a2 = (await alice(`/api/audits/${audit.id}`)).data;
assert.equal(a2.baseline_run_id, run1.id, 'Erster Lauf wird Baseline');
step('Lauf: Wiederholungen mit Statistik, Schwellwerte, Versionsbezug, Baseline automatisch');

// Update bewusst übernehmen.
ok(await alice(`/api/audits/${audit.id}/items/0/update`, { method: 'POST' }));
assert.equal((await alice(`/api/audits/${audit.id}`)).data.items[0].version, '1.1.0');
r = await alice(`/api/audits/${audit.id}/run`, { method: 'POST', body: {} });
const run2 = await waitRun(alice, r.data.id);
assert.equal(run2.results[0].template_version, '1.1.0');
assert.ok(run2.results.every((x) => x.details.regression), 'Vergleich mit der Baseline');
step('Update übernommen, Regressionsvergleich gegen feste Baseline');

// Evidence und Report.
let ev = await alice(`/api/runs/${run1.id}/evidence/verify`);
ok(ev);
assert.equal(ev.data.ok, true);
r = await alice(`/api/runs/${run1.id}/report`);
ok(r);
assert.equal(r.data.status, 'draft');
const report = r.data;
assert.equal((await kurt(`/api/reports/${report.id}`)).status, 404, 'Kunden-Viewer sieht keinen Entwurf');
ok(await alice(`/api/reports/${report.id}`, { method: 'PUT', body: { summary: 'Rechenfähigkeit der Modelle geprüft.' } }));
ok(await alice(`/api/reports/${report.id}/submit`, { method: 'POST' }));
assert.equal((await alice(`/api/reports/${report.id}/approve`, { method: 'POST' })).status, 403);
assert.equal((await carol(`/api/reports/${report.id}/approve`, { method: 'POST' })).status, 200);
r = await kurt(`/api/reports/${report.id}`);
ok(r);
assert.equal(r.data.status, 'approved');
assert.equal((await alice(`/api/reports/${report.id}`, { method: 'PUT', body: { summary: 'x' } })).status, 409, 'Freigegebener Bericht unveränderlich');
const html = await kurt(`/api/reports/${report.id}/export?format=html`);
assert.match(html.text, /Prüfbericht/);
step('Nachweise mit Hash prüfbar; Bericht: Entwurf → Review → Freigabe (Vier-Augen), Export');

// ------------------------------------------------------------------ Gate und Service-Token
r = await admin('/api/service-tokens', { method: 'POST', body: { name: `ci-${suffix}` } });
ok(r, 'Service-Token');
const token = r.data.token;
assert.match(token, /^sat_/);
r = await admin('/api/audits');
const nightly = r.data.find((a) => a.name === 'Nightly Gateway');
r = await admin(`/api/audits/${nightly.id}/run`, { method: 'POST', body: {}, token });
ok(r, 'Start mit Service-Token');
assert.equal(r.data.trigger, 'api');
const ciRun = await waitRun(admin, r.data.id);
r = await admin(`/api/runs/${ciRun.id}/gate`, { token });
ok(r);
assert.equal(typeof r.data.pass, 'boolean');
assert.ok(Array.isArray(r.data.fail_on));
assert.equal((await admin('/api/service-tokens', { token })).status, 403, 'Service-Account darf keine Tokens verwalten');
step('CI/CD: Lauf und Gate mit Service-Token');

// ------------------------------------------------------------------ Prod: Freigabe, Vier-Augen, Verbrauch
const prodAudit = (await admin('/api/audits')).data.find((a) => a.name === 'Prod-Abnahme');
r = await alice(`/api/audits/${prodAudit.id}/run`, { method: 'POST', body: {} });
assert.equal(r.status, 409, 'Prod ohne Freigabe nicht startbar');
r = await alice(`/api/audits/${prodAudit.id}/approvals`, { method: 'POST', body: { note: 'Abnahme vor Go-Live', runs_allowed: 1, limits: { max_concurrency: 2, max_duration_s: 10 } } });
ok(r, 'Freigabe beantragen');
const approval = r.data;
assert.equal((await alice(`/api/approvals/${approval.id}/decision`, { method: 'POST', body: { decision: 'approve' } })).status, 403, 'Kein runs.prod');
// Engagement Lead darf freigeben; Antragsteller nicht selbst.
const carolApproval = await carol(`/api/audits/${prodAudit.id}/approvals`, { method: 'POST', body: {} });
assert.equal(carolApproval.status, 409, 'Antrag bereits offen');
ok(await carol(`/api/approvals/${approval.id}/decision`, { method: 'POST', body: { decision: 'approve', note: 'ok' } }), 'Freigabe');
r = await alice(`/api/audits/${prodAudit.id}/run`, { method: 'POST', body: {} });
ok(r, 'Prod-Lauf mit Freigabe');
const prodRun = await waitRun(alice, r.data.id);
assert.equal(prodRun.platform_environment, 'prod');
assert.equal(prodRun.approval_id, approval.id);
assert.equal((await alice(`/api/audits/${prodAudit.id}/run`, { method: 'POST', body: {} })).status, 409, 'Freigabe ist verbraucht');
step('Prod: Freigabe mit Vier-Augen-Prinzip, einmal verwendbar');

// Selbstfreigabe: Carol beantragt, Carol darf nicht entscheiden.
r = await carol(`/api/audits/${prodAudit.id}/approvals`, { method: 'POST', body: {} });
ok(r);
assert.equal((await carol(`/api/approvals/${r.data.id}/decision`, { method: 'POST', body: { decision: 'approve' } })).status, 403, 'Eigenen Antrag nicht freigeben');
ok(await admin(`/api/approvals/${r.data.id}/decision`, { method: 'POST', body: { decision: 'reject', note: 'nicht nötig' } }));
step('Eigener Antrag kann nicht selbst entschieden werden');

// Zuweisung: Antrag an eine bestimmte Person; andere sehen ihn nicht.
r = await alice(`/api/audits/${prodAudit.id}/approvals`, { method: 'POST', body: { assigned_user_id: people.carol.id, note: 'für Carol' } });
ok(r, 'Antrag mit Zuweisung');
const assigned = r.data;
assert.equal(assigned.assigned_user_id, people.carol.id);
assert.ok((await carol('/api/approvals?status=pending')).data.some((a) => a.id === assigned.id && a.can_decide), 'Zugewiesene Person sieht und entscheidet');
assert.ok((await carol('/api/approvals/summary')).data.pending >= 1, 'Hinweis in der Navigation');
assert.ok(!(await bob('/api/approvals?status=pending')).data.some((a) => a.id === assigned.id), 'Andere ohne Zuweisung sehen den Antrag nicht');
assert.equal((await bob(`/api/approvals/${assigned.id}/decision`, { method: 'POST', body: { decision: 'approve' } })).status, 403, 'Nur die zugewiesene Person entscheidet');
assert.equal((await alice(`/api/audits/${prodAudit.id}/approvals`, { method: 'POST', body: { assigned_user_id: people.alice.id } })).status, 409, 'Offener Antrag vorhanden');
ok(await carol(`/api/approvals/${assigned.id}/decision`, { method: 'POST', body: { decision: 'reject', note: 'später' } }));
step('Freigaben: Zuweisung an Person, Sichtbarkeit und Hinweis');

// Kill-Switch.
ok(await carol(`/api/platforms/${dev.id}/lock`, { method: 'POST', body: { reason: 'Test des Kill-Switch' } }));
r = await alice(`/api/audits/${nightly.id}/run`, { method: 'POST', body: {} });
assert.equal(r.status, 423, 'Gesperrte Plattform startet keine Läufe');
assert.equal((await alice(`/api/platforms/${dev.id}/unlock`, { method: 'POST' })).status, 403);
ok(await carol(`/api/platforms/${dev.id}/unlock`, { method: 'POST' }));
step('Kill-Switch sperrt und entsperrt die Plattform');

// ------------------------------------------------------------------ Findings und Nachtest
const accessAudit = (await admin('/api/audits')).data.find((a) => a.name === 'Zugriff Team A');
r = await admin('/api/api-keys');
const adminKeyId = r.data.find((k) => k.name === 'admin').id;
r = await alice('/api/audits', { method: 'POST', body: { name: `Zugriff mit Admin-Key ${suffix}`, platform_id: dev.id, models: [{ alias: 'mock-small', path: 'gateway' }], items: [{ template_version_id: accessAudit.items[0].template_version_id }], api_key_id: adminKeyId, visibility: 'global' } });
ok(r);
const accessBad = r.data;
r = await alice(`/api/audits/${accessBad.id}/run`, { method: 'POST', body: {} });
const accRun = await waitRun(alice, r.data.id);
assert.equal(accRun.outcomes.security_finding, 1, 'Zugriff mit Admin-Key: Sicherheitsfinding');
assert.equal(accRun.gate.pass, false);
r = await alice('/api/findings?open=1');
ok(r);
const finding = r.data.find((f) => f.template_key === 'access-keys' && f.audit_id === accessBad.id);
assert.ok(finding, 'Finding wurde automatisch angelegt');
assert.equal(finding.severity, 'critical');
assert.equal(finding.framework, 'OWASP LLM Top 10');
assert.equal(finding.category, 'LLM06');
assert.equal((await alice(`/api/findings/${finding.id}`, { method: 'PUT', body: { status: 'accepted' } })).status, 403, 'Ohne findings.manage');
ok(await carol(`/api/findings/${finding.id}`, { method: 'PUT', body: { status: 'in_progress', owner_id: people.alice.id, note: 'Wird geprüft' } }));
// Nachtest: Problem besteht weiter, Finding bleibt offen und zählt hoch.
r = await carol(`/api/findings/${finding.id}/retest`, { method: 'POST' });
ok(r, 'Nachtest');
const retest = await waitRun(carol, r.data.id);
assert.equal(retest.kind, 'retest');
assert.equal(retest.results.length, 1);
r = await carol(`/api/findings/${finding.id}`);
assert.equal(r.data.retest_result, 'still_failing');
assert.equal(r.data.status, 'open');
assert.ok(r.data.occurrences >= 2, 'Dedupe: dasselbe Problem zählt hoch statt doppelt angelegt');
assert.equal((await carol('/api/findings')).data.filter((f) => f.fingerprint === finding.fingerprint).length, 1);
// Kunden-Viewer sieht Findings ohne Rohdaten.
r = await kurt(`/api/findings/${finding.id}`);
ok(r);
assert.equal(r.data.evidence?.masked, true);
step('Findings: automatisch angelegt, dedupliziert, Status und Verantwortliche, Nachtest, Rohdaten verborgen');

// Angriffsdaten bleiben für Kunden-Viewer verborgen.
r = await rita('/api/audits', { method: 'POST', body: { name: `Security ${suffix}`, platform_id: dev.id, models: [{ alias: 'mock-small', path: 'gateway' }], items: [{ template_version_id: secTpl.version.id }], visibility: 'global' } });
ok(r);
r = await rita(`/api/audits/${r.data.id}/run`, { method: 'POST', body: {} });
const secRun = await waitRun(rita, r.data.id);
assert.equal(secRun.results[0].sensitivity, 'attack');
assert.ok(JSON.stringify((await kurt(`/api/runs/${secRun.id}`)).data).includes('masked'), 'Kunden-Viewer: maskiert');
assert.ok(!(await kurt(`/api/runs/${secRun.id}`)).text.includes('Ignoriere alle vorherigen'), 'keine Angriffs-Payloads für Kunden-Viewer');
ev = await rita(`/api/runs/${secRun.id}/evidence`);
ok(ev);
assert.ok(ev.data.items.some((e) => e.prompt), 'Red Teamer sieht Prompts');
ev = await kurt(`/api/runs/${secRun.id}/evidence`);
assert.ok(ev.data.items.every((e) => e.prompt === null), 'Kunden-Viewer sieht keine Prompts');
step('Angriffs-Payloads nur mit security.payloads sichtbar');

// ------------------------------------------------------------------ Vergleichsmodus, nicht anwendbar
const compareAudit = (await admin('/api/audits')).data.find((a) => a.name === 'Qwen3: direkt gegen Gateway');
r = await alice(`/api/audits/${compareAudit.id}/run`, { method: 'POST', body: {} });
ok(r);
const cmp = await waitRun(alice, r.data.id);
assert.ok(cmp.comparison?.items?.[0]?.a && cmp.comparison.items[0].b, 'Vergleich A/B');
assert.ok(cmp.comparison.items[0].diff.score, 'Ergebnis ist die Differenz');
const ocrAudit = (await admin('/api/audits')).data.find((a) => a.name === 'Dokumente (OCR)');
r = await alice(`/api/audits/${ocrAudit.id}/run`, { method: 'POST', body: {} });
ok(r);
const ocr = await waitRun(alice, r.data.id, 300);
assert.ok(ocr.results.some((x) => x.outcome === 'not_applicable' && /vision/.test(x.details.reason)), 'mock-small ohne Vision ist „nicht anwendbar“');
assert.ok(ocr.results.some((x) => x.model_alias === 'mock-large' && x.status !== 'skipped'));
step('Vergleichsmodus (Differenz) und Voraussetzungen (nicht anwendbar)');

// ------------------------------------------------------------------ Dashboard
r = await carol('/api/dashboard/portfolio?environment=dev');
ok(r);
assert.ok(r.data.platforms.length >= 1 && r.data.totals.tests > 0);
r = await carol(`/api/dashboard/platforms/${dev.id}`);
ok(r);
assert.ok(r.data.models.length >= 2);
const card = r.data.models.find((m) => m.alias === 'mock-large').scorecard;
for (const dim of ['quality', 'sovereignty']) assert.ok(card.dimensions[dim], `Scorecard: ${dim}`);
assert.equal(card.normalization, '1');
assert.equal(r.data.heatmap.rows.length, 10);
assert.ok(r.data.heatmap.rows.find((x) => x.key === 'LLM01'));
assert.ok(r.data.models[0].suitability.length === 4, 'Eignungsprofile Chat, Coding, OCR, Agent');
assert.ok(r.data.sovereignty.goals.length === 8);
assert.ok(r.data.snapshot?.components?.length, 'Plattform-Snapshot');
r = await carol(`/api/dashboard/models?platform_id=${dev.id}&model=mock-large`);
ok(r);
assert.ok(r.data.results.length > 0 && r.data.trend.length > 0);
r = await carol('/api/dashboard/normalization');
assert.equal(r.data.version, '1');
r = await kurt(`/api/dashboard/platforms/${dev.id}`);
ok(r);
assert.equal(r.data.view, 'customer');
step('Dashboard: Portfolio, Plattform (Scorecard, Eignung, Heatmap, Souveränität, Snapshot), Modell');

// ------------------------------------------------------------------ Export/Import und Mandanten
r = await alice(`/api/catalog/templates/${template.id}/versions/1.1.0/export?datasets=1&format=yaml`);
ok(r);
assert.match(r.text, /schema: ai-testing-suite\/v1/);
const yaml = r.text;
r = await alice(`/api/catalog/templates/${template.id}/versions/1.1.0/export?format=json`);
assert.equal(JSON.parse(r.text).kind, 'template');
r = await admin('/api/tenants', { method: 'POST', body: { name: `Kunde B ${suffix}` } });
ok(r, 'Mandant anlegen');
const tenantB = r.data;
const adminB = await login(undefined, { tenant: tenantB.id });
const meB = (await adminB('/api/me')).data;
assert.equal(meB.tenant.id, tenantB.id);
assert.equal((await adminB('/api/platforms')).data.length, 0, 'Mandanten sind getrennt: keine Plattformen');
assert.equal((await adminB('/api/audits')).data.length, 0);
assert.equal((await adminB(`/api/audits/${audit.id}`)).status, 404, 'Fremde Prüfung nicht erreichbar');
assert.equal((await adminB(`/api/runs/${run1.id}`)).status, 404, 'Fremder Lauf nicht erreichbar');
assert.ok((await adminB('/api/catalog/templates')).data.some((t) => t.origin === 'official'), 'Katalog ist global');
assert.ok(!(await adminB('/api/catalog/templates')).data.some((t) => t.key.startsWith('rechnen-')), 'Eigene Vorlagen bleiben im Mandanten');
r = await adminB('/api/catalog/import', { method: 'POST', body: { content: yaml, format: 'yaml' } });
ok(r, 'Import');
assert.equal(r.data.datasets.length, 1);
assert.equal(r.data.templates[0].status, 'draft');
r = await adminB('/api/catalog/templates');
assert.ok(r.data.some((t) => t.key.startsWith('rechnen-') && t.latest.status === 'draft'));
assert.equal((await adminB('/api/catalog/import', { method: 'POST', body: { content: 'schema: fremd/v9\nkind: template\n', format: 'yaml' } })).status, 400);
step('Export/Import (YAML/JSON, mit Datensatz) und Mandantentrennung');

// ------------------------------------------------------------------ 0.5.0: Inventar, Topologie, Einstufung, Portfolio
const presets = (await carol('/api/inventory/presets')).data;
assert.ok(presets.gpu_types['rtx-pro-6000'] && presets.gpu_types.b300 && presets.hosting_providers.length > 5, 'Voreinstellungen für das Inventar');
const spec = (kind, extra) => ({ name: `${kind}-${suffix}`, kind, platform_id: dev.id, spec: extra });
assert.equal((await admin('/api/endpoints', { method: 'POST', body: spec('datacenter', { provider: 'gibtsnicht' }) })).status, 400, 'Unbekannter Hosting-Anbieter');
assert.equal((await admin('/api/endpoints', { method: 'POST', body: spec('gpu', { gpu_type: 'h100', mig: { enabled: true, layout: [{ profile: '7g.80gb', slices: 7 }, { profile: '1g.10gb', slices: 1 }] } }) })).status, 400, 'MIG: höchstens 7 Slices');
r = await admin('/api/endpoints', { method: 'POST', body: spec('gpu', { gpu_type: 'custom', custom: { name: 'AMD MI300X', memory_gb: 192, mig_capable: false } }) });
ok(r, 'Eigener GPU-Typ');
const customGpu = r.data.endpoint;
assert.equal(customGpu.base_url, null, 'GPU hat keine URL');
r = await admin('/api/endpoints', { method: 'POST', body: spec('datacenter', { provider: 'hetzner', country: 'de', region: 'Falkenstein', certifications: ['ISO 27001'] }) });
ok(r, 'Rechenzentrum');
const newDc = r.data.endpoint;
assert.equal(newDc.spec.country, 'DE');
const devFull = (await admin(`/api/platforms/${dev.id}`)).data;
assert.ok(devFull.links.length >= 5 && devFull.endpoints.some((e) => e.kind === 'gpu' && e.spec.mig.enabled), 'Seed-Inventar mit MIG-GPU');
const vllmEp = devFull.endpoints.find((e) => e.kind === 'llm');
const migGpu = devFull.endpoints.find((e) => e.kind === 'gpu' && e.spec.mig.enabled);
const gateway = devFull.endpoints.find((e) => e.kind === 'ai_proxy');
const links = devFull.links.map((l) => ({ kind: l.kind, from_id: l.from_id, to_id: l.to_id, data: l.data }));
assert.equal((await admin(`/api/platforms/${dev.id}/topology`, { method: 'PUT', body: { links: [{ kind: 'runs_on', from_id: vllmEp.id, to_id: newDc.id }] } })).status, 400, 'Inferenzserver läuft nicht auf einem Rechenzentrum');
assert.equal((await admin(`/api/platforms/${dev.id}/topology`, { method: 'PUT', body: { links: [{ kind: 'runs_on', from_id: vllmEp.id, to_id: migGpu.id, data: { mig_slice: 5 } }] } })).status, 400, 'MIG-Instanz existiert nicht');
r = await admin(`/api/platforms/${dev.id}/topology`, {
  method: 'PUT',
  body: { links: [...links.filter((l) => l.kind !== 'runs_on'), { kind: 'runs_on', from_id: vllmEp.id, to_id: migGpu.id, data: { mig_slice: 1 } }], routes: [{ gateway_endpoint_id: gateway.id, backend_endpoint_id: vllmEp.id, mappings: [{ gateway_model: 'qwen3-32b', backend_model: 'Qwen/Qwen3-32B' }] }], layout: { placed: { inference: [vllmEp.id, 'unbekannt'] }, collapsed: { inference: true, nirgends: true } }, served_models: { [vllmEp.id]: ['Qwen/Qwen3-32B'] } },
});
ok(r, 'Topologie speichern');
assert.equal(r.data.links.find((l) => l.kind === 'runs_on').data.mig_slice, 1);
assert.deepEqual(r.data.layout, { placed: { inference: [vllmEp.id] }, collapsed: { inference: true } });
r = await admin(`/api/platforms/${dev.id}/assessment`);
ok(r, 'Einstufung');
assert.equal(r.data.sovereignty.goals.length, 8);
assert.ok(r.data.security.checks.length >= 6 && r.data.production.checks.length >= 8);
const sov2 = r.data.sovereignty.goals.find((g) => g.key === 'SOV-2');
assert.ok(sov2.checks.some((c) => c.id === 'location' && c.status === 'pass'), 'Standort DE aus dem Inventar');
assert.equal((await admin(`/api/platforms/${dev.id}/sovereignty`, { method: 'PUT', body: { min_level: 2, overrides: { 'SOV-8': { level: 3 } } } })).status, 400, 'Überschreiben braucht Begründung');
r = await admin(`/api/platforms/${dev.id}/sovereignty`, { method: 'PUT', body: { min_level: 2, overrides: { 'SOV-8': { level: 3, reason: 'Nachweis liegt als Zertifikat vor' } } } });
ok(r, 'Überschreiben mit Begründung');
assert.equal(r.data.overrides['SOV-8'].reason, 'Nachweis liegt als Zertifikat vor');
r = await admin(`/api/platforms/${dev.id}/assessment`);
const sov8 = r.data.sovereignty.goals.find((g) => g.key === 'SOV-8');
assert.equal(sov8.effective, 3);
assert.equal(sov8.override.level, 3);
assert.equal((await carol(`/api/dashboard/platforms/${dev.id}`)).data.reports.total >= 0, true, 'Dashboard liefert Berichtszähler');
step('Inventar, Topologie mit MIG, Einstufung und Überschreiben mit Begründung');

// ------------------------------------------------------------------ 0.6.0: Ebenen, Server, Bundles, Organisation
r = await admin(`/api/platforms/${dev.id}`);
const layered = r.data;
const serverEp = layered.endpoints.find((e) => e.kind === 'server');
const icEp = layered.endpoints.find((e) => e.kind === 'interconnect');
const k8sEp = layered.endpoints.find((e) => e.kind === 'kubernetes');
const gpuEps = layered.endpoints.filter((e) => e.kind === 'gpu');
assert.ok(serverEp && icEp && layered.layout.placed, 'Seed: Server, Interconnect und Platzierung');
assert.deepEqual(layered.routes[0].mappings, [{ gateway_model: 'qwen3-32b', backend_model: 'Qwen/Qwen3-32B' }], 'Route mit Zuordnung der Modellnamen');
const layeredLinks = layered.links.map((l) => ({ kind: l.kind, from_id: l.from_id, to_id: l.to_id, data: l.data }));
const put = (body) => admin(`/api/platforms/${dev.id}/topology`, { method: 'PUT', body: { links: layeredLinks, routes: [], ...body } });
assert.equal((await put({ specs: { [icEp.id]: { type: 'nvlink', bundles: [{ id: 'x', name: 'Allein', mode: 'nvlink', gpu_ids: [gpuEps[0].id] }] } } })).status, 400, 'NVLink braucht mindestens zwei GPUs');
assert.equal((await put({ specs: { [k8sEp.id]: { nodes: [{ server_id: gpuEps[0].id, role: 'worker' }] } } })).status, 400, 'Cluster-Knoten müssen Server sein');
assert.equal((await put({ specs: { [icEp.id]: { type: 'nvlink', bundles: [{ id: 'm1', name: 'Zu viel', mode: 'mig', gpu_ids: [gpuEps[1].id], profile: '7g.80gb', slices: 7 }, { id: 'm2', name: 'Noch mehr', mode: 'mig', gpu_ids: [gpuEps[1].id], profile: '1g.10gb', slices: 1 }] } } })).status, 400, 'MIG-Slices je GPU begrenzt');
r = await put({
  specs: { [icEp.id]: { type: 'nvlink', bundles: [{ id: 'm1', name: 'Klein', mode: 'mig', gpu_ids: [gpuEps[1].id], profile: '3g.40gb', slices: 3, memory_gb: 40 }] } },
  links: [...layeredLinks.filter((l) => l.kind !== 'runs_on'), { kind: 'runs_on', from_id: vllmEp.id, to_id: icEp.id, data: { bundle_id: 'm1' } }],
});
ok(r, 'Inferenz auf GPU-Bundle');
assert.equal(r.data.links.find((l) => l.kind === 'runs_on').data.bundle_id, 'm1');
assert.ok(r.data.links.some((l) => l.kind === 'cluster' && l.from_id === serverEp.id && l.to_id === k8sEp.id), 'Cluster-Zuordnung aus den Knoten');
assert.equal((await put({ links: [...layeredLinks.filter((l) => l.kind !== 'runs_on'), { kind: 'runs_on', from_id: vllmEp.id, to_id: icEp.id, data: { bundle_id: 'gibtsnicht' } }] })).status, 400, 'Unbekanntes Bundle');
ok(await put({ specs: { [icEp.id]: { type: 'nvlink', bundles: [{ id: 'b1', name: 'H100 Verbund', mode: 'nvlink', gpu_ids: gpuEps.map((g) => g.id) }] } } }), 'Seed-Zustand wiederherstellen');
step('Ebenen: Server, GPU-Bundles (NVLink/MIG), Cluster-Knoten');

r = await admin('/api/organization');
ok(r);
const myOrg = r.data.find((t) => t.current);
r = await admin('/api/departments', { method: 'POST', body: { name: `Forschung-${suffix}` } });
ok(r, 'Abteilung anlegen');
const dept = r.data;
assert.equal((await admin('/api/departments', { method: 'POST', body: { name: `Forschung-${suffix}` } })).status, 400, 'Abteilung doppelt');
r = await admin('/api/teams', { method: 'POST', body: { name: `Team-D-${suffix}`, department_id: dept.id } });
ok(r, 'Team in Abteilung');
r = await admin('/api/organization');
const tree = r.data.find((t) => t.current).departments.find((d) => d.id === dept.id);
assert.ok(tree.teams.some((t) => t.name === `Team-D-${suffix}`), 'Hierarchie Mandant, Abteilung, Team');
assert.ok(myOrg, 'Eigener Mandant in der Organisation');
assert.equal((await alice('/api/departments', { method: 'POST', body: { name: 'x' } })).status, 403, 'Abteilungen brauchen teams.manage');
step('Organisation: Mandant, Abteilung, Team');

// Modellportfolio: nur ausgewählte Modelle werden getestet.
r = await admin('/api/portfolio');
ok(r);
assert.ok(['mock-small', 'mock-large', 'qwen3-32b'].every((n) => r.data.some((m) => m.name === n)), 'Portfolio aus Seed');
const qwen = r.data.find((m) => m.name === 'qwen3-32b');
assert.ok(qwen.members.length >= 2, 'Ein Portfolio-Modell bündelt mehrere gefundene Modelle');
assert.equal((await admin('/api/portfolio', { method: 'POST', body: { name: `leer-${suffix}`, members: [] } })).status, 400, 'Ohne gefundenes Modell kein Portfolio-Modell');
assert.equal((await admin('/api/portfolio', { method: 'POST', body: { name: `doppelt-${suffix}`, members: [{ endpoint_id: qwen.members[0].endpoint_id, model_name: qwen.members[0].model_name }] } })).status, 400, 'Bereits zugeordnetes Modell');
r = await admin('/api/portfolio/candidates');
ok(r);
assert.ok(!r.data.some((c) => c.model_name === 'mock-small'), 'Zugeordnete Modelle sind keine Kandidaten');
assert.equal((await kurt('/api/portfolio/candidates')).status, 403);
step('Modellportfolio: Auswahl gefundener Modelle');

// Netzwerk-Test als Plattform-Vorlage mit Test-Ziel.
r = await admin('/api/catalog/templates?target=platform');
ok(r);
assert.ok(r.data.some((t) => t.key === 'network-isolation' && t.target === 'platform'), 'Vorlage Netzwerk-Isolation');
assert.equal((await admin('/api/catalog/packs')).status, 404, 'Pakete entfallen');
step('Vorlagen mit Test-Ziel, Pakete entfernt');

// ------------------------------------------------------------------ Audit-Log
r = await admin('/api/audit-log?q=approval');
ok(r);
assert.ok(r.data.rows.some((x) => x.action === 'approval.approve'));
assert.equal((await alice('/api/audit-log')).status, 403);
r = await admin('/api/audit-log?action=platform.lock');
assert.ok(r.data.rows.length >= 1);
step('Audit-Log enthält Freigaben und Kill-Switch');

// ------------------------------------------------------------------ 0.7.0: Läufe löschen, Dashboard, KI-Analyse nur für Admins
r = await admin(`/api/dashboard/platforms/${dev.id}`);
ok(r);
assert.ok(Array.isArray(r.data.speed) && 'gateway' in r.data.ttft_by_path && 'direct' in r.data.ttft_by_path, 'Dashboard: Geschwindigkeit je Modell und TTFT nach Weg');
assert.ok(r.data.vram.gpus >= 2 && r.data.vram.total_gb >= 160, 'Dashboard: VRAM aus den GPUs an Servern');
assert.equal((await alice('/api/settings/analysis')).status, 403, 'KI-Analyse-Einstellung nur für Administratoren');
ok(await admin('/api/settings/analysis'));
r = await admin('/api/runs?days=365');
ok(r);
const victim = r.data.runs.find((x) => ['passed', 'failed', 'error', 'cancelled'].includes(x.status));
assert.ok(victim, 'Es gibt einen beendeten Lauf');
assert.equal((await alice(`/api/runs/${victim.id}`, { method: 'DELETE' })).status, 403, 'Löschen nur für Administratoren');
ok(await admin(`/api/runs/${victim.id}`, { method: 'DELETE' }), 'Lauf löschen');
assert.equal((await admin(`/api/runs/${victim.id}`)).status, 404, 'Lauf samt Daten gelöscht');
r = await admin('/api/audit-log?action=run.delete');
assert.ok(r.data.rows.length >= 1, 'Löschen steht im Audit-Log');
step('Läufe löschen, Dashboard-Geschwindigkeit und VRAM, KI-Analyse nur für Admins');

// ------------------------------------------------------------------ 0.8.0
// Info, Branding
r = await admin('/api/info');
ok(r);
assert.ok('version' in r.data && 'copyright' in r.data, 'Info mit Version und Copyright');
for (const f of ['/favicon.png', '/company-logo.png']) {
  const img = await fetch(base + f);
  assert.equal(img.status, 200, `${f} ohne Anmeldung erreichbar`);
  assert.equal(img.headers.get('content-type'), 'image/png');
}
step('Info-API, Favicon und Firmenlogo');

// Komponenten: MCP mit Bearer Token, Version abfragen, Erreichbarkeit
r = await admin(`/api/endpoints?platform_id=${dev.id}`);
ok(r);
const mcp = r.data.find((e) => e.kind === 'mcp');
assert.ok(mcp, 'MCP im Seed');
assert.equal(mcp.spec.auth.type, 'bearer', 'MCP-Authentifizierung Bearer');
assert.equal(mcp.api_key_id ?? null, null, 'MCP hat keinen API-Key mehr');
assert.ok(!JSON.stringify(mcp).includes('sk-admin'), 'Bearer Token wird nie ausgeliefert');
assert.equal((await admin('/api/endpoints', { method: 'POST', body: { platform_id: dev.id, name: `mcp-x-${suffix}`, kind: 'mcp', base_url: mcp.base_url, spec: { auth: { type: 'basic' } } } })).status, 400, 'Ungültige MCP-Authentifizierung');
r = await admin('/api/endpoints', { method: 'POST', body: { platform_id: dev.id, name: `mcp-none-${suffix}`, kind: 'mcp', base_url: mcp.base_url, spec: { auth: { type: 'none' } } } });
ok(r);
await admin(`/api/endpoints/${r.data.endpoint.id}`, { method: 'DELETE' });
const gw = (await admin(`/api/endpoints?platform_id=${dev.id}`)).data.find((e) => e.kind === 'ai_proxy');
r = await admin('/api/endpoints/probe', { method: 'POST', body: { kind: 'ai_proxy', base_url: gw.base_url, api_key_id: gw.api_key_id } });
ok(r);
assert.equal(r.data.status, 'up', 'Probe erreicht das Gateway');
assert.equal((await admin('/api/endpoints/probe', { method: 'POST', body: { kind: 'gpu', base_url: 'http://x' } })).status, 400, 'Probe nur für Komponenten mit Endpunkt');
assert.equal((await alice('/api/endpoints/probe', { method: 'POST', body: { kind: 'ai_proxy', base_url: gw.base_url } })).status, 403, 'Probe nur für Verwalter');
r = await admin('/api/endpoints', { method: 'POST', body: { platform_id: dev.id, name: `vllm-v-${suffix}`, kind: 'llm', base_url: `${process.env.MOCK_URL ?? 'http://localhost:4000'}/vllm`, auto_discover: false, spec: { provider: 'vllm', reachability: 'gateway_only', version_override: '9.9.9' }, manual_models: [`qwen-neu-${suffix}`] } });
ok(r);
const vllmNew = r.data.endpoint;
assert.equal(vllmNew.spec.reachability, 'gateway_only', 'Erreichbarkeit gespeichert');
r = await admin(`/api/platforms/${dev.id}/status?force=1`);
ok(r);
assert.equal(r.data.components.find((c) => c.endpoint_id === vllmNew.id)?.version, '9.9.9', 'Eingetragene Version hat Vorrang');
r = await admin(`/api/platforms/${dev.id}/assessment`);
ok(r);
const checks = [...r.data.security.checks, ...r.data.sovereignty.goals.flatMap((g) => g.checks)];
assert.ok(checks.some((c) => c.id === 'mcp-auth'), 'MCP-Authentifizierung fließt in die Einstufung');
assert.ok(checks.some((c) => c.id === 'exposure'), 'Erreichbarkeit fließt in die Einstufung');
assert.ok(r.data.sovereignty.goals.find((g) => g.key === 'SOV-3').checks.some((c) => c.id === 'exposure'), 'Erreichbarkeit zählt für SOV-3');
step('Komponenten: MCP-Token, Version, Erreichbarkeit, Einstufung');

// Modellportfolio: KI-Vorbefüllung aus dem Namen
r = await admin('/api/portfolio', { method: 'POST', body: { name: `qwen-neu-${suffix}`, members: [{ endpoint_id: vllmNew.id, model_name: `qwen-neu-${suffix}` }] } });
ok(r);
assert.equal(r.data.provider, 'Alibaba Cloud', 'Anbieter von der KI');
assert.equal(r.data.origin, 'CN');
assert.equal(r.data.open_weights, true);
assert.equal(Number(r.data.parameters_b), 7);
assert.ok(r.data.capabilities.includes('tools'));
assert.ok(['provider', 'license', 'origin', 'open_weights', 'parameters_b', 'capabilities'].every((k) => r.data.ai_filled.includes(k)), 'KI-Markierung');
const aiModel = r.data;
r = await admin(`/api/portfolio/${aiModel.id}`, { method: 'PUT', body: { name: aiModel.name, provider: 'Eigener Anbieter', members: [{ endpoint_id: vllmNew.id, model_name: aiModel.name }] } });
ok(r);
assert.equal(r.data.provider, 'Eigener Anbieter');
assert.ok(!r.data.ai_filled.includes('provider') && r.data.ai_filled.includes('license'), 'Manuell geänderte Angabe verliert die KI-Markierung');
await admin(`/api/portfolio/${aiModel.id}`, { method: 'DELETE' });
await admin(`/api/endpoints/${vllmNew.id}`, { method: 'DELETE' });
step('Modellportfolio: KI-Vorbefüllung mit Markierung');

// Metriken
r = await admin('/api/settings/metrics');
ok(r);
assert.equal(r.data.settings.enabled, true);
assert.equal((await alice('/api/settings/metrics')).status, 403, 'Metrik-Einstellungen nur mit settings.manage');
assert.equal((await admin('/api/settings/metrics', { method: 'PUT', body: { enabled: true, interval_s: 5, retention_h: 24 } })).status, 400, 'Intervall wird geprüft');
ok(await admin('/api/settings/metrics', { method: 'PUT', body: { enabled: true, interval_s: 15, retention_h: 24 } }));
r = await admin('/api/settings/metrics/check', { method: 'POST' });
ok(r);
assert.ok(r.data.endpoints.length >= 1 && r.data.endpoints.every((e) => e.state?.ok), 'Alle Metrics-Endpunkte erreichbar');
r = await admin(`/api/metrics?platform_id=${dev.id}&minutes=60`);
ok(r);
assert.ok(r.data.components.some((c) => c.group === 'inference') && r.data.components.some((c) => c.group === 'gateway'), 'Dashboards für vLLM und LiteLLM');
step('Metriken: Einstellungen, Endpunktstatus, Dashboards');

// Dashboard: Empfehlungen
r = await admin(`/api/dashboard/platforms/${dev.id}`);
ok(r);
assert.ok(Array.isArray(r.data.recommendations) && r.data.recommendations.length <= 5, 'Top-5-Empfehlungen');
if (r.data.recommendations.length) assert.ok(r.data.recommendations[0].effects.length >= 1, 'Empfehlung mit Wirkung auf Ziele');
step('Dashboard: Top-5-Empfehlungen');

console.log('0.8.0 End-to-End-Prüfung erfolgreich');
