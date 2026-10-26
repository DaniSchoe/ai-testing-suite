// Führt einen Testlauf aus: Tests nacheinander, Ergebnisse und Logs in Postgres, Regressionsvergleich.
import { many, one, query } from '../db.js';
import { decrypt } from '../crypto.js';
import { getPersonaToken } from '../auth.js';
import { testTypes } from '../testtypes/index.js';
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

// Alle Persona-Namen einsammeln, die irgendwo in der Testkonfiguration referenziert werden.
function referencedPersonas(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => referencedPersonas(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'persona' && typeof v === 'string' && v) out.add(v);
      else referencedPersonas(v, out);
    }
  }
  return out;
}

async function authHeaderFor(persona) {
  if (!persona || persona.auth_type === 'none') return {};
  const secret = decrypt(persona.secret_enc);
  if (persona.auth_type === 'api_key') return { authorization: `Bearer ${secret}` };
  if (persona.auth_type === 'keycloak_password') {
    return { authorization: `Bearer ${await getPersonaToken(persona.username, secret)}` };
  }
  return {};
}

async function buildContext({ runId, resultId, test, endpoint, personasByName, signal }) {
  const type = testTypes[test.type];
  const cfg = { ...structuredClone(type.defaults), ...test.config };
  const defaultPersona = test.persona_id ? [...personasByName.values()].find((p) => p.id === test.persona_id) : null;

  const authByPersona = new Map();
  for (const name of referencedPersonas(cfg)) {
    const p = personasByName.get(name);
    if (!p) throw new Error(`Persona "${name}" existiert nicht`);
    authByPersona.set(name, await authHeaderFor(p));
  }
  const endpointKey = decrypt(endpoint.api_key_enc);
  const defaultAuth = defaultPersona
    ? await authHeaderFor(defaultPersona)
    : endpointKey
      ? { authorization: `Bearer ${endpointKey}` }
      : {};

  const headersFor = ({ persona, anonymous } = {}) => ({
    ...endpoint.headers,
    ...(anonymous ? {} : persona ? authByPersona.get(persona) : defaultAuth),
  });

  return {
    test,
    config: cfg,
    endpoint: { ...endpoint, api_key_enc: undefined },
    persona: defaultPersona ? { id: defaultPersona.id, name: defaultPersona.name } : null,
    signal,
    model() {
      const m = cfg.model || endpoint.default_model || endpoint.models?.[0];
      if (!m) throw new Error('Kein Modell konfiguriert (Test oder Endpoint)');
      return m;
    },
    llm(opts) {
      return new LlmClient({ baseUrl: endpoint.base_url, headers: headersFor(opts), timeoutMs: (cfg.requestTimeoutS ?? 120) * 1000 });
    },
    mcp(opts = {}) {
      const url = `${endpoint.base_url.replace(/\/$/, '')}${opts.path ?? ''}`;
      return new McpClient({ url, headers: headersFor(opts) });
    },
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

async function runOne({ run, test, endpoint, personasByName }) {
  const result = await one(
    `insert into results (run_id, test_id, test_name, type, endpoint_id, endpoint_name, persona_name, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'running') returning id`,
    [
      run.id,
      test.id,
      test.name,
      test.type,
      endpoint?.id,
      endpoint?.name,
      test.persona_id ? [...personasByName.values()].find((p) => p.id === test.persona_id)?.name : null,
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
    const ctx = await buildContext({ runId: run.id, resultId: result.id, test, endpoint, personasByName, signal: controller.signal });
    await ctx.log('info', `Starte ${type.label}: ${test.name}`);
    const res = await Promise.race([
      type.run(ctx),
      new Promise((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error(`Timeout nach ${timeoutS}s`))),
      ),
    ]);
    outcome = { status: res.status, model: res.model, score: res.score ?? null, metrics: res.metrics ?? {}, details: res.details ?? {} };
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
       duration_ms = $8, finished_at = now() where id = $1`,
    [
      result.id,
      outcome.status,
      outcome.model ?? null,
      outcome.score,
      JSON.stringify(outcome.metrics),
      JSON.stringify(outcome.details),
      outcome.error ?? null,
      Date.now() - started,
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
  const endpoints = new Map((await many('select * from endpoints')).map((e) => [e.id, e]));
  const personasByName = new Map((await many('select * from personas')).map((p) => [p.name, p]));

  const counts = { passed: 0, failed: 0, error: 0 };
  for (const testId of run.test_ids) {
    const current = await one('select status from runs where id = $1', [run.id]);
    if (current.status === 'cancelled') {
      await log(run.id, null, 'warn', 'Lauf abgebrochen');
      return;
    }
    const test = byId.get(testId);
    if (!test) continue;
    const status = await runOne({ run, test, endpoint: endpoints.get(test.endpoint_id), personasByName });
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
}
