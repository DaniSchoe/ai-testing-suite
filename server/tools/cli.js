#!/usr/bin/env node
// Kommandozeile für CI/CD: Prüfung starten, auf das Ergebnis warten und mit Exit-Code 0 (bestanden) oder 1 (nicht bestanden) enden.
//   node tools/cli.js run <Prüfung (Name oder ID)> [--wait] [--timeout 1800] [--junit ergebnis.xml]
//   node tools/cli.js gate <Lauf-ID> [--wait]
//   node tools/cli.js audits
// Zugang: --url oder SAT_URL, --token oder SAT_TOKEN (Service-Token "sat_…" aus Verwaltung → Zugangsdaten), --tenant oder SAT_TENANT.
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith('--') ? 2 : 1);
  return v && !v.startsWith('--') ? v : true;
};
const url = (flag('url', process.env.SAT_URL) ?? 'http://localhost:8080').replace(/\/$/, '');
const token = flag('token', process.env.SAT_TOKEN);
const tenant = flag('tenant', process.env.SAT_TENANT);
const wait = flag('wait', false);
const timeoutS = Number(flag('timeout', 1800));
const junit = flag('junit');
const [command, target] = args;

if (!token) {
  console.error('Service-Token fehlt (--token oder SAT_TOKEN)');
  process.exit(2);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(tenant ? { 'x-tenant-id': tenant } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`${method} ${path}: ${res.status} ${data?.error ?? ''}`);
    process.exit(res.status === 409 || res.status === 423 ? 3 : 2);
  }
  return data;
}

async function waitFor(runId) {
  const until = Date.now() + timeoutS * 1000;
  for (;;) {
    const run = await api(`/api/runs/${runId}`);
    if (!['queued', 'running'].includes(run.status)) return run;
    if (Date.now() > until) {
      console.error(`Zeitüberschreitung nach ${timeoutS}s (Lauf ${runId} läuft noch)`);
      process.exit(2);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

function report(run, gate) {
  console.log(`Lauf ${run.id}: ${run.status} · ${run.passed} bestanden, ${run.failed} fehlgeschlagen, ${run.errored} Fehler`);
  for (const r of run.results) console.log(`  ${r.outcome?.padEnd(18) ?? r.status.padEnd(18)} ${r.test_name}${r.score !== null ? ` (${Number(r.score).toFixed(2)})` : ''}`);
  console.log(gate.pass ? 'Gate: bestanden' : `Gate: NICHT bestanden (${gate.reasons.map((x) => `${x.outcome}: ${x.count}`).join(', ') || gate.status})`);
  if (junit) {
    const cases = run.results.map((r) => `<testcase name="${esc(r.test_name)}" classname="${esc(r.type)}" time="${((r.duration_ms ?? 0) / 1000).toFixed(1)}">${r.outcome === 'passed' ? '' : r.outcome === 'not_applicable' ? '<skipped/>' : `<failure message="${esc(r.outcome)}">${esc(r.error ?? r.details?.thresholds?.violations?.map((v) => v.message).join('; '))}</failure>`}</testcase>`);
    writeFileSync(junit, `<?xml version="1.0" encoding="UTF-8"?><testsuite name="${esc(run.label)}" tests="${run.results.length}" failures="${run.results.filter((r) => ['security_finding', 'quality_deviation', 'technical_error'].includes(r.outcome)).length}">${cases.join('')}</testsuite>`);
  }
}

if (command === 'audits') {
  for (const a of await api('/api/audits')) console.log(`${a.id}  ${a.name}  (${a.platform_name}, ${a.platform_environment})`);
} else if (command === 'run' && target) {
  const audits = await api('/api/audits');
  const audit = audits.find((a) => a.id === target) ?? audits.find((a) => a.name === target);
  if (!audit) {
    console.error(`Prüfung „${target}“ nicht gefunden`);
    process.exit(2);
  }
  const run = await api(`/api/audits/${audit.id}/run`, { method: 'POST', body: {} });
  console.log(`Lauf gestartet: ${run.id}`);
  if (!wait) process.exit(0);
  const done = await waitFor(run.id);
  const gate = await api(`/api/runs/${run.id}/gate`);
  report(done, gate);
  process.exit(gate.pass ? 0 : 1);
} else if (command === 'gate' && target) {
  const run = wait ? await waitFor(target) : await api(`/api/runs/${target}`);
  const gate = await api(`/api/runs/${target}/gate`);
  report(run, gate);
  process.exit(gate.pass ? 0 : gate.finished ? 1 : 2);
} else {
  console.error('Aufruf: cli.js run <Prüfung> [--wait] | gate <Lauf-ID> [--wait] | audits   (siehe Kopfzeile)');
  process.exit(2);
}
