// Führt den Plan eines Laufs aus: Einzeltests nacheinander, Wiederholungen, Schwellwerte der Prüfung, Baseline-Vergleich,
// Nachweise, Findings, Plattform-Snapshot. Ergebnisse und Logs liegen in Postgres.
import { many, one, query } from '../db.js';
import { analyzeRun } from '../analysis.js';
import { platformSampler } from '../platform.js';
import { decrypt } from '../crypto.js';
import { testTypes } from '../testtypes/index.js';
import { aliasOf, authHeaders, llmClientFor, resolveModel } from '../models.js';
import { adaptDataset, findVersion, loadVersion } from '../datasets.js';
import { aggregateRepeats, compareToBaseline, evalThresholds, outcomeOf } from '../evaluate.js';
import { finalizeRetests, getRetention, recordFindings, sealRun, storeEvidence } from '../findings.js';
import { takeSnapshot } from '../snapshot.js';
import { ensureReport } from '../reports.js';
import { LlmClient, McpClient } from './clients.js';

export async function log(runId, resultId, level, message, data) {
  await query('insert into run_logs (run_id, result_id, level, message, data) values ($1, $2, $3, $4, $5)', [
    runId,
    resultId ?? null,
    level,
    message,
    data === undefined ? null : JSON.stringify(data),
  ]);
}

// Alle API-Key-Namen einsammeln, die in der Konfiguration referenziert werden ("apiKey").
function referencedKeys(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => referencedKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'apiKey' && typeof v === 'string' && v) out.add(v);
      else referencedKeys(v, out);
    }
  }
  return out;
}

async function loadEndpoints(platformId) {
  const rows = await many(
    `select e.*, k.secret_enc as api_key_enc, k.name as api_key_name from endpoints e left join api_keys k on k.id = e.api_key_id where e.platform_id = $1`,
    [platformId],
  );
  const models = await many('select m.* from endpoint_models m join endpoints e on e.id = m.endpoint_id where e.platform_id = $1 and m.portfolio_id is not null', [platformId]);
  return rows.map((e) => {
    const modelRows = models.filter((m) => m.endpoint_id === e.id);
    return { ...e, modelRows, models: modelRows.filter((m) => m.available).map((m) => m.name) };
  });
}

function buildContext({ run, atom, resultId, cfg, endpoint, endpointsByName, keysByName, keysById, signal }) {
  const flavor = endpoint.llm_flavor;
  const authByKey = new Map();
  for (const name of referencedKeys(cfg)) {
    const k = keysByName.get(name);
    if (!k) throw new Error(`API-Key "${name}" existiert nicht`);
    authByKey.set(name, authHeaders(flavor, decrypt(k.secret_enc)));
  }
  // Standard-Key: der des Einzeltests (Zuordnung in der Prüfung), sonst der des Laufs, sonst der des Endpoints.
  const defaultKey = keysById.get(atom.api_key_id) ?? keysById.get(run.api_key_id);
  const defaultAuth = defaultKey ? authHeaders(flavor, decrypt(defaultKey.secret_enc)) : authHeaders(flavor, decrypt(endpoint.api_key_enc));
  const headersFor = ({ apiKey, anonymous } = {}) => ({ ...endpoint.headers, ...(anonymous ? {} : apiKey ? authByKey.get(apiKey) : defaultAuth) });

  return {
    test: { id: null, name: atom.name, type: atom.type },
    config: cfg,
    endpoint: { ...endpoint, api_key_enc: undefined },
    apiKey: defaultKey ? { id: defaultKey.id, name: defaultKey.name } : endpoint.api_key_name ? { name: endpoint.api_key_name } : null,
    signal,
    // Modellnamen dürfen echte Namen oder Aliase sein; zurück kommt der Name am Endpoint.
    model() {
      const m = cfg.model || endpoint.default_model || endpoint.models?.[0];
      if (!m) throw new Error('Kein Modell konfiguriert');
      return resolveModel(endpoint.modelRows, m).name;
    },
    resolveModel: (name) => resolveModel(endpoint.modelRows, name).name,
    aliasOf: (name) => aliasOf(endpoint.modelRows, name),
    target(name) {
      const other = endpointsByName.get(name);
      if (!other) throw new Error(`Endpoint "${name}" existiert nicht`);
      return {
        endpoint: other,
        llm: () => llmClientFor(other, { timeoutMs: (cfg.requestTimeoutS ?? 120) * 1000 }),
        resolveModel: (m) => resolveModel(other.modelRows, m ?? other.default_model ?? other.models[0]),
      };
    },
    llm: (opts) => new LlmClient({ baseUrl: endpoint.base_url, headers: headersFor(opts), flavor, timeoutMs: (cfg.requestTimeoutS ?? 120) * 1000 }),
    mcp(opts = {}) {
      const url = `${endpoint.base_url.replace(/\/$/, '')}${opts.path ?? ''}`;
      return new McpClient({ url, headers: headersFor(opts) });
    },
    // Metriken der Plattform (DCGM, vLLM, LiteLLM) während des Tests mitschreiben; ohne konfigurierte Endpunkte passiert nichts.
    metricsSampler: () => platformSampler(run.platform_id).catch(() => null),
    log: (level, message, data) => log(run.id, resultId, level, message, data),
  };
}

// Datensatz der Vorlage laden und für die Testart aufbereiten.
async function datasetConfig(run, atom) {
  if (!atom.dataset) return { config: {}, info: null, sensitivity: atom.security || atom.type === 'security' ? 'attack' : 'internal' };
  const found = await findVersion(run.tenant_id, atom.dataset.key, atom.dataset.version);
  if (!found) throw new Error(`Datensatz „${atom.dataset.key}“ in Version ${atom.dataset.version ?? 'neueste'} nicht gefunden`);
  const ds = await loadVersion(found.id);
  const info = { key: ds.key, name: ds.name, version: ds.version, hash: ds.hash, cases: ds.cases.length, min_cases: ds.min_cases, small_sample: ds.cases.length < ds.min_cases };
  return { config: adaptDataset(atom.type, ds), info, sensitivity: ds.sensitivity };
}

async function baselineResult(auditBaselineRunId, atom) {
  if (!auditBaselineRunId) return null;
  return one(
    `select id, run_id, metrics, score from results
     where run_id = $1 and template_key = $2 and coalesce(model_alias, '') = coalesce($3, '') and coalesce(path, '') = coalesce($4, '')
       and coalesce(variant, '') = coalesce($5, '') and coalesce(endpoint_name, '') = coalesce($6, '') and status in ('passed', 'failed') limit 1`,
    [auditBaselineRunId, atom.template_key, atom.model ?? null, atom.path ?? null, atom.variant ?? null, atom.endpoint_name ?? null],
  );
}

async function runAtom({ run, audit, atom, endpoints, endpointsByName, keysByName, keysById, retention, failedFingerprints }) {
  const endpoint = endpoints.find((e) => e.id === atom.endpoint_id);
  const keyName = (keysById.get(atom.api_key_id) ?? keysById.get(run.api_key_id))?.name ?? endpoint?.api_key_name ?? null;
  const result = await one(
    `insert into results (run_id, test_name, type, endpoint_id, endpoint_name, api_key_name, status, template_version_id, template_key, template_version,
       audit_id, platform_id, variant, path, item_index, model_alias)
     values ($1, $2, $3, $4, $5, $6, 'running', $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
    [run.id, atom.name, atom.type, endpoint?.id ?? null, endpoint?.name ?? atom.endpoint_name ?? null, keyName, atom.template_version_id, atom.template_key, atom.template_version, run.audit_id, run.platform_id, atom.variant ?? null, atom.path ?? null, atom.item_index, atom.model ?? null],
  );
  const started = Date.now();

  if (!atom.applicable) {
    await log(run.id, result.id, 'info', `Nicht anwendbar: ${atom.name} (${atom.reason})`);
    await query(
      `update results set status = 'skipped', outcome = 'not_applicable', details = $2, duration_ms = 0, finished_at = now() where id = $1`,
      [result.id, JSON.stringify({ reason: atom.reason })],
    );
    return 'skipped';
  }

  const controller = new AbortController();
  const timeoutS = atom.config?.timeoutS ?? 900;
  const timer = setTimeout(() => controller.abort(), timeoutS * 1000);
  // Abbruch durch Anwender oder Kill-Switch während des Tests erkennen.
  const watch = setInterval(async () => {
    const state = await one('select r.status, p.locked from runs r left join platforms p on p.id = r.platform_id where r.id = $1', [run.id]).catch(() => null);
    if (state && (state.status === 'cancelled' || state.locked)) controller.abort();
  }, 2000);
  let outcome;
  try {
    const type = testTypes[atom.type];
    if (!type) throw new Error(`Unbekannter Testtyp "${atom.type}"`);
    if (!endpoint && !type.platformLevel) throw new Error('Kein Endpoint zugeordnet');
    const ds = await datasetConfig(run, atom);
    // Regeln (bestanden/nicht bestanden) legt die Prüfung über Schwellwerte fest; die Testart misst nur.
    const cfg = { ...structuredClone(type.defaults), ...structuredClone(atom.config), ...ds.config, model: atom.model ?? atom.config?.model ?? '' };
    if (atom.thresholds?.length) {
      cfg.minScore = 0;
      cfg.thresholds = {};
    }
    const ctx = endpoint
      ? buildContext({ run, atom, resultId: result.id, cfg, endpoint, endpointsByName, keysByName, keysById, signal: controller.signal })
      : { test: { id: null, name: atom.name, type: atom.type }, config: cfg, signal: controller.signal, log: (level, message, data) => log(run.id, result.id, level, message, data), aliasOf: (n) => n };
    await ctx.log('info', `Starte ${type.label}: ${atom.name}${atom.repeats > 1 ? ` (${atom.repeats} Wiederholungen)` : ''}`);
    const abortPromise = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Abgebrochen (Zeitlimit, Lauf abgebrochen oder Plattform gesperrt)'))));
    const attempts = [];
    for (let i = 0; i < (atom.repeats ?? 1); i += 1) {
      if (controller.signal.aborted) break;
      try {
        const res = await Promise.race([type.run(ctx), abortPromise]);
        attempts.push({ status: res.status, model: res.model, modelAlias: res.modelAlias ?? (res.model ? ctx.aliasOf(res.model) : null), score: res.score ?? null, metrics: res.metrics ?? {}, details: res.details ?? {} });
      } catch (err) {
        if (controller.signal.aborted) throw err;
        attempts.push({ status: 'error', metrics: {}, details: {}, error: err.message });
        await ctx.log('warn', `Durchlauf ${i + 1} fehlgeschlagen: ${err.message}`);
      }
    }
    if (!attempts.length) throw new Error('Kein Durchlauf ausgeführt');
    const agg = aggregateRepeats(attempts);
    if (agg.status === 'error') throw new Error(attempts.find((a) => a.error)?.error ?? 'Fehler');
    outcome = { ...agg, details: { ...agg.details, ...(ds.info ? { dataset: ds.info } : {}) }, sensitivity: ds.sensitivity };

    // Schwellwerte der Prüfung bestimmen das Ergebnis; ohne Schwellwerte gilt die Bewertung der Testart.
    if (atom.thresholds?.length) {
      const violations = evalThresholds(atom.thresholds, outcome.metrics, outcome.score);
      outcome.details.thresholds = { rules: atom.thresholds, violations };
      outcome.status = violations.length ? 'failed' : 'passed';
      // Falsch erlaubte Zugriffe sind unabhängig von Schwellwerten ein Fehler.
      if (atom.type === 'access' && outcome.metrics.false_allow > 0) outcome.status = 'failed';
    }
    if (ds.info?.small_sample) outcome.statistics = { ...outcome.statistics, small_sample: true, min_cases: ds.info.min_cases };

    const base = await baselineResult(audit?.baseline_run_id, atom);
    const regression = compareToBaseline(outcome, base, { tolerance: Number(audit?.regression_tolerance ?? 0.2), thresholds: atom.thresholds });
    if (regression) {
      outcome.details.regression = regression;
      if (regression.regressions.length) await ctx.log('warn', `Regression gegenüber Baseline: ${regression.regressions.map((r) => r.metric).join(', ')}`);
    }
    outcome.outcome = outcomeOf({ status: outcome.status, type: atom.type, security: atom.security });
    await ctx.log(outcome.status === 'passed' ? 'info' : 'warn', `Ergebnis: ${outcome.status}`);
  } catch (err) {
    outcome = { status: 'error', outcome: 'technical_error', metrics: {}, details: {}, error: err.message, sensitivity: atom.security ? 'attack' : 'internal' };
    await log(run.id, result.id, 'error', err.message, { stack: err.stack?.split('\n').slice(0, 5) });
  } finally {
    clearTimeout(timer);
    clearInterval(watch);
  }

  await query(
    `update results set status = $2, model = $3, score = $4, metrics = $5, details = $6, error = $7, duration_ms = $8, model_alias = $9,
       outcome = $10, attempts = $11, statistics = $12, sensitivity = $13, finished_at = now() where id = $1`,
    [
      result.id,
      outcome.status,
      outcome.model ?? null,
      outcome.score ?? null,
      JSON.stringify(outcome.metrics),
      JSON.stringify(outcome.details),
      outcome.error ?? null,
      Date.now() - started,
      outcome.modelAlias ?? outcome.model ?? atom.model ?? null,
      outcome.outcome,
      outcome.statistics?.attempts ?? atom.repeats ?? 1,
      outcome.statistics ? JSON.stringify(outcome.statistics) : null,
      outcome.sensitivity ?? 'internal',
      ],
  );
  if (outcome.status !== 'error') {
    try {
      await storeEvidence({ tenantId: run.tenant_id, runId: run.id, resultId: result.id, details: outcome.details, sensitivity: outcome.sensitivity ?? 'internal', retention });
      const fps = await recordFindings({ tenantId: run.tenant_id, run: { ...run, platform_id: run.platform_id }, atom: { ...atom, platform_id: run.platform_id }, details: outcome.details, outcome: outcome.outcome });
      for (const fp of fps) failedFingerprints.add(fp);
    } catch (err) {
      await log(run.id, result.id, 'warn', `Nachweise/Findings nicht gespeichert: ${err.message}`);
    }
  }
  return outcome.status;
}

// Vergleichsmodus: Ergebnis ist die Differenz zwischen Variante A und B je Vorlage.
async function computeComparison(run, audit) {
  const rows = await many(`select item_index, template_key, test_name, type, variant, model_alias, path, score, metrics, status from results where run_id = $1 and variant is not null order by item_index`, [run.id]);
  const items = new Map();
  for (const r of rows) {
    const it = items.get(r.item_index) ?? { template_key: r.template_key, name: r.test_name, type: r.type };
    it[r.variant.toLowerCase()] = { model: r.model_alias, path: r.path, status: r.status, score: r.score === null ? null : Number(r.score), metrics: r.metrics };
    items.set(r.item_index, it);
  }
  const list = [...items.values()].map((it) => {
    const diff = {};
    if (it.a && it.b) {
      const a = { ...it.a.metrics, score: it.a.score };
      const b = { ...it.b.metrics, score: it.b.score };
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (typeof a[k] === 'number' && typeof b[k] === 'number') diff[k] = { a: a[k], b: b[k], delta: b[k] - a[k], relative: a[k] ? (b[k] - a[k]) / Math.abs(a[k]) : null };
      }
    }
    return { ...it, diff };
  });
  return { kind: audit?.compare?.kind ?? 'models', items: list };
}

export async function executeRun(runId) {
  const run = await one(`update runs set status = 'running', started_at = now() where id = $1 and status = 'queued' returning *`, [runId]);
  if (!run) return; // bereits gelaufen oder abgebrochen
  await log(run.id, null, 'info', `Lauf gestartet: ${run.label} (${run.total} Einzeltests)`);

  const audit = run.audit_id ? await one('select * from audits where id = $1', [run.audit_id]) : null;
  const platform = run.platform_id ? await one('select id, name, locked, locked_reason from platforms where id = $1', [run.platform_id]) : null;
  if (platform?.locked) {
    await query(`update runs set status = 'cancelled', finished_at = now() where id = $1`, [run.id]);
    await log(run.id, null, 'warn', `Plattform gesperrt (Kill-Switch): ${platform.locked_reason ?? ''}`);
    return;
  }
  const endpoints = run.platform_id ? await loadEndpoints(run.platform_id) : [];
  const endpointsByName = new Map(endpoints.map((e) => [e.name, e]));
  const apiKeys = await many('select id, name, secret_enc from api_keys where tenant_id = $1', [run.tenant_id]);
  const keysByName = new Map(apiKeys.map((k) => [k.name, k]));
  const keysById = new Map(apiKeys.map((k) => [k.id, k]));
  const retention = await getRetention();

  // Zustand der Plattform festhalten (Versionen, Modell-Revisionen, Topologie) – Grundlage für Berichte und Trendmarkierungen.
  if (run.platform_id) {
    const snapshot = await takeSnapshot(run.platform_id, { previousRunId: run.id }).catch((err) => {
      log(run.id, null, 'warn', `Snapshot nicht erstellt: ${err.message}`);
      return null;
    });
    if (snapshot) await query('update runs set snapshot = $2 where id = $1', [run.id, JSON.stringify(snapshot)]);
  }

  const counts = { passed: 0, failed: 0, error: 0, skipped: 0 };
  const failedFingerprints = new Set();
  for (const atom of run.plan) {
    const current = await one('select r.status, p.locked from runs r left join platforms p on p.id = r.platform_id where r.id = $1', [run.id]);
    if (current.status === 'cancelled' || current.locked) {
      if (current.locked) await query(`update runs set status = 'cancelled', finished_at = now() where id = $1`, [run.id]);
      await log(run.id, null, 'warn', current.locked ? 'Lauf abgebrochen: Plattform gesperrt (Kill-Switch)' : 'Lauf abgebrochen');
      return;
    }
    const status = await runAtom({ run, audit, atom, endpoints, endpointsByName, keysByName, keysById, retention, failedFingerprints });
    counts[status] = (counts[status] ?? 0) + 1;
    await query('update runs set passed = $2, failed = $3, errored = $4 where id = $1', [run.id, counts.passed, counts.failed, counts.error]);
  }

  const outcomeRows = await many('select outcome, count(*)::int as n from results where run_id = $1 group by outcome', [run.id]);
  const outcomes = Object.fromEntries(outcomeRows.map((r) => [r.outcome ?? 'unknown', r.n]));
  const final = counts.error ? 'error' : counts.failed ? 'failed' : 'passed';
  const comparison = audit?.mode === 'compare' ? await computeComparison(run, audit) : null;
  await query(`update runs set status = $2, finished_at = now(), outcomes = $3, comparison = $4 where id = $1 and status = 'running'`, [run.id, final, JSON.stringify(outcomes), comparison ? JSON.stringify(comparison) : null]);
  await log(run.id, null, 'info', `Lauf beendet: ${counts.passed} bestanden, ${counts.failed} fehlgeschlagen, ${counts.error} Fehler, ${counts.skipped} nicht anwendbar`);

  await sealRun(run.id).catch(() => null);
  if (run.kind === 'retest') await finalizeRetests(run, failedFingerprints).catch((err) => log(run.id, null, 'warn', `Nachtest: ${err.message}`));
  // Der erste abgeschlossene Lauf einer Prüfung wird zur Baseline, sofern keine festgelegt ist.
  if (audit && audit.baseline_auto && !audit.baseline_run_id && !run.is_draft && run.kind === 'audit') {
    await query(`update audits set baseline_run_id = $2, baseline_set_at = now() where id = $1 and baseline_run_id is null`, [audit.id, run.id]);
    await log(run.id, null, 'info', 'Erster Lauf der Prüfung: als Baseline festgelegt');
  }
  if (run.audit_id && !run.is_draft) await ensureReport(run.id).catch((err) => log(run.id, null, 'warn', `Bericht nicht erstellt: ${err.message}`));
  // KI-Analyse nach dem Lauf; ein Fehler dort beeinflusst das Laufergebnis nicht.
  const analysis = await analyzeRun(run.id, console).catch(() => 'error');
  if (analysis !== 'skipped') {
    await log(run.id, null, analysis === 'done' ? 'info' : 'warn', analysis === 'done' ? 'KI-Analyse erstellt' : 'KI-Analyse fehlgeschlagen');
    if (run.audit_id && !run.is_draft) await ensureReport(run.id).catch(() => null);
  }
}
