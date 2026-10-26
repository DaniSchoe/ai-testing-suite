// Führt einen Testlauf aus: Tests nacheinander, Ergebnisse und Logs in Postgres, Regressionsvergleich.
import { many, one, query } from '../db.js';
import { analyzeRun } from '../analysis.js';
import { platformSampler } from '../platform.js';
import { decrypt } from '../crypto.js';
import { testTypes } from '../testtypes/index.js';
import { aliasOf, authHeaders, ENDPOINT_SELECT, endpointHeaders, llmClientFor, resolveModel } from '../models.js';
import { LlmClient, McpClient } from './clients.js';

// Kennzahlen, bei denen "höher" schlechter ist bzw. "niedriger" schlechter ist.
const LOWER_IS_BETTER = ['ttft_ms_p95', 'ttft_ms_p50', 'latency_ms_p95', 'latency_ms_p50', 'latency_ms_avg', 'error_rate'];
const HIGHER_IS_BETTER = ['tokens_per_s_avg', 'throughput_tokens_per_s', 'peak_requests_per_s', 'score'];

export async function log(runId, resultId, level, message, data) {
  await query('insert into run_logs (run_id, result_id, level, message, data) values ($1, $2, $3, $4, $5)', [
    runId,
    resultId ?? null,
    level,
    message,
    data === undefined ? null : JSON.stringify(data),
  ]);
}

// Alle API-Key-Namen einsammeln, die in der Testkonfiguration referenziert werden ("apiKey", früher "persona").
const KEY_FIELDS = ['apiKey', 'persona'];
function referencedKeys(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => referencedKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (KEY_FIELDS.includes(k) && typeof v === 'string' && v) out.add(v);
      else referencedKeys(v, out);
    }
  }
  return out;
}

async function buildContext({ runId, resultId, test, endpoint, endpointsByName, keysByName, keysById, runKeyId, signal }) {
  const type = testTypes[test.type];
  const cfg = { ...structuredClone(type.defaults), ...test.config };
  const flavor = endpoint.llm_flavor;

  const authByKey = new Map();
  for (const name of referencedKeys(cfg)) {
    const k = keysByName.get(name);
    if (!k) throw new Error(`API-Key "${name}" existiert nicht`);
    authByKey.set(name, authHeaders(flavor, decrypt(k.secret_enc)));
  }
  // Standard-Key: der des Laufs (z. B. eigener Key aus dem Marketplace), sonst der des Tests, sonst der des Endpoints.
  const defaultKey = keysById.get(runKeyId) ?? keysById.get(test.api_key_id);
  const defaultAuth = defaultKey ? authHeaders(flavor, decrypt(defaultKey.secret_enc)) : authHeaders(flavor, decrypt(endpoint.api_key_enc));

  const headersFor = ({ apiKey, persona, anonymous } = {}) => {
    const name = apiKey ?? persona;
    return { ...endpoint.headers, ...(anonymous ? {} : name ? authByKey.get(name) : defaultAuth) };
  };

  return {
    test,
    config: cfg,
    endpoint: { ...endpoint, api_key_enc: undefined },
    apiKey: defaultKey ? { id: defaultKey.id, name: defaultKey.name } : endpoint.api_key_name ? { name: endpoint.api_key_name } : null,
    signal,
    // Modellnamen dürfen echte Namen oder Aliase sein; zurück kommt der Name am Endpoint.
    model() {
      const m = cfg.model || endpoint.default_model || endpoint.models?.[0];
      if (!m) throw new Error('Kein Modell konfiguriert (Test oder Endpoint)');
      return resolveModel(endpoint.modelRows, m).name;
    },
    resolveModel: (name) => resolveModel(endpoint.modelRows, name).name,
    aliasOf: (name) => aliasOf(endpoint.modelRows, name),
    // Anderer Endpoint als Ziel, z. B. LiteLLM gegen vLLM direkt. Nutzt dessen eigenen Key.
    target(name) {
      const other = endpointsByName.get(name);
      if (!other) throw new Error(`Endpoint "${name}" existiert nicht`);
      return {
        endpoint: other,
        llm: () => llmClientFor(other, { timeoutMs: (cfg.requestTimeoutS ?? 120) * 1000 }),
        resolveModel: (m) => resolveModel(other.modelRows, m ?? other.default_model ?? other.models[0]),
      };
    },
    llm(opts) {
      return new LlmClient({ baseUrl: endpoint.base_url, headers: headersFor(opts), flavor, timeoutMs: (cfg.requestTimeoutS ?? 120) * 1000 });
    },
    mcp(opts = {}) {
      const url = `${endpoint.base_url.replace(/\/$/, '')}${opts.path ?? ''}`;
      return new McpClient({ url, headers: headersFor(opts) });
    },
    // Metriken der Plattform (DCGM, vLLM, LiteLLM) während des Tests mitschreiben; ohne konfigurierte Endpunkte passiert nichts.
    metricsSampler: () => platformSampler().catch(() => null),
    log: (level, message, data) => log(runId, resultId, level, message, data),
  };
}

// Vergleich mit dem letzten bestandenen Ergebnis derselben Testdefinition.
async function regressionCheck(test, metrics, score) {
  const baseline = await one(
    `select id, run_id, metrics, score, finished_at from results
     where test_id = $1 and status = 'passed' and finished_at is not null
     order by finished_at desc limit 1`,
    [test.id],
  );
  if (!baseline) return null;
  const tolerance = test.config?.regressionTolerance ?? 0.2;
  const current = { ...metrics, score };
  const base = { ...baseline.metrics, score: baseline.score };
  const deltas = {};
  const regressions = [];
  for (const key of [...LOWER_IS_BETTER, ...HIGHER_IS_BETTER]) {
    const a = base[key];
    const b = current[key];
    if (typeof a !== 'number' || typeof b !== 'number' || a === 0) continue;
    const change = (b - a) / Math.abs(a);
    deltas[key] = change;
    const worse = LOWER_IS_BETTER.includes(key) ? change > tolerance : change < -tolerance;
    if (worse) regressions.push({ metric: key, baseline: a, current: b, change });
  }
  return { baselineResultId: baseline.id, baselineRunId: baseline.run_id, tolerance, deltas, regressions };
}

async function runOne({ run, test, endpoint, endpointsByName, keysByName, keysById }) {
  const result = await one(
    `insert into results (run_id, test_id, test_name, type, endpoint_id, endpoint_name, api_key_name, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'running') returning id`,
    [
      run.id,
      test.id,
      test.name,
      test.type,
      endpoint?.id,
      endpoint?.name,
      (keysById.get(run.api_key_id) ?? keysById.get(test.api_key_id))?.name ?? endpoint?.api_key_name ?? null,
    ],
  );
  const started = Date.now();
  const controller = new AbortController();
  const timeoutS = test.config?.timeoutS ?? 900;
  const timer = setTimeout(() => controller.abort(), timeoutS * 1000);
  let outcome;
  try {
    const type = testTypes[test.type];
    if (!type) throw new Error(`Unbekannter Testtyp "${test.type}"`);
    if (!endpoint) throw new Error('Kein Endpoint zugeordnet');
    if (!endpoint.enabled) throw new Error(`Endpoint "${endpoint.name}" ist deaktiviert`);
    const ctx = await buildContext({
      runId: run.id,
      resultId: result.id,
      test,
      endpoint,
      endpointsByName,
      keysByName,
      keysById,
      runKeyId: run.api_key_id,
      signal: controller.signal,
    });
    await ctx.log('info', `Starte ${type.label}: ${test.name}`);
    const res = await Promise.race([
      type.run(ctx),
      new Promise((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error(`Timeout nach ${timeoutS}s`))),
      ),
    ]);
    outcome = { status: res.status, model: res.model, modelAlias: res.modelAlias ?? (res.model ? ctx.aliasOf(res.model) : null), score: res.score ?? null, metrics: res.metrics ?? {}, details: res.details ?? {} };
    const regression = await regressionCheck(test, outcome.metrics, outcome.score);
    if (regression) {
      outcome.details.regression = regression;
      if (regression.regressions.length) {
        await ctx.log('warn', `Regression gegenüber Baseline: ${regression.regressions.map((r) => r.metric).join(', ')}`);
        if (test.config?.failOnRegression) outcome.status = 'failed';
      }
    }
    await ctx.log(outcome.status === 'passed' ? 'info' : 'warn', `Ergebnis: ${outcome.status}`);
  } catch (err) {
    outcome = { status: 'error', metrics: {}, details: {}, error: err.message };
    await log(run.id, result.id, 'error', err.message, { stack: err.stack?.split('\n').slice(0, 5) });
  } finally {
    clearTimeout(timer);
  }
  await query(
    `update results set status = $2, model = $3, score = $4, metrics = $5, details = $6, error = $7,
       duration_ms = $8, model_alias = $9, finished_at = now() where id = $1`,
    [
      result.id,
      outcome.status,
      outcome.model ?? null,
      outcome.score,
      JSON.stringify(outcome.metrics),
      JSON.stringify(outcome.details),
      outcome.error ?? null,
      Date.now() - started,
      outcome.modelAlias ?? outcome.model ?? null,
    ],
  );
  return outcome.status;
}

export async function executeRun(runId) {
  const run = await one(`update runs set status = 'running', started_at = now() where id = $1 and status = 'queued' returning *`, [
    runId,
  ]);
  if (!run) return; // bereits gelaufen oder abgebrochen
  await log(run.id, null, 'info', `Lauf gestartet: ${run.label} (${run.total} Tests)`);

  const tests = await many('select * from test_definitions where id = any($1)', [run.test_ids]);
  const byId = new Map(tests.map((t) => [t.id, t]));
  const modelRows = await many('select * from endpoint_models');
  const endpointList = (await many(ENDPOINT_SELECT)).map((e) => {
    const rows = modelRows.filter((m) => m.endpoint_id === e.id);
    return { ...e, modelRows: rows, models: rows.filter((m) => m.available).map((m) => m.name) };
  });
  const endpoints = new Map(endpointList.map((e) => [e.id, e]));
  const endpointsByName = new Map(endpointList.map((e) => [e.name, e]));
  const apiKeys = await many('select id, name, secret_enc from api_keys');
  const keysByName = new Map(apiKeys.map((k) => [k.name, k]));
  const keysById = new Map(apiKeys.map((k) => [k.id, k]));

  const counts = { passed: 0, failed: 0, error: 0 };
  for (const testId of run.test_ids) {
    const current = await one('select status from runs where id = $1', [run.id]);
    if (current.status === 'cancelled') {
      await log(run.id, null, 'warn', 'Lauf abgebrochen');
      return;
    }
    const test = byId.get(testId);
    if (!test) continue;
    const status = await runOne({ run, test, endpoint: endpoints.get(test.endpoint_id), endpointsByName, keysByName, keysById });
    counts[status === 'error' ? 'error' : status] = (counts[status === 'error' ? 'error' : status] ?? 0) + 1;
    await query('update runs set passed = $2, failed = $3, errored = $4 where id = $1', [
      run.id,
      counts.passed,
      counts.failed,
      counts.error,
    ]);
  }
  const final = counts.error ? 'error' : counts.failed ? 'failed' : 'passed';
  await query(`update runs set status = $2, finished_at = now() where id = $1 and status = 'running'`, [run.id, final]);
  await log(run.id, null, 'info', `Lauf beendet: ${counts.passed} bestanden, ${counts.failed} fehlgeschlagen, ${counts.error} Fehler`);
  // KI-Analyse nach dem Lauf; ein Fehler dort beeinflusst das Laufergebnis nicht.
  const analysis = await analyzeRun(run.id, console).catch(() => 'error');
  if (analysis !== 'skipped') await log(run.id, null, analysis === 'done' ? 'info' : 'warn', analysis === 'done' ? 'KI-Analyse erstellt' : 'KI-Analyse fehlgeschlagen');
}
