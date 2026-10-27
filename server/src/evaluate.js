// Bewertung eines Einzeltests: Schwellwerte der Prüfung, Wiederholungen (Aggregation), Ergebnisart, Statistik, Baseline-Vergleich.

// Typen, deren Fehlschläge als Sicherheitsfinding gelten.
export const SECURITY_TYPES = ['security', 'access', 'mcp', 'network'];

const OPS = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '==': (a, b) => a === b,
};
export const OPERATORS = Object.keys(OPS);

// Richtung je Kennzahl für Baseline-Vergleiche; Schwellwerte der Prüfung überschreiben sie.
export const LOWER_IS_BETTER = ['ttft_ms_p95', 'ttft_ms_p50', 'latency_ms_p95', 'latency_ms_p50', 'latency_ms_avg', 'error_rate', 'false_allow', 'false_deny'];
export const HIGHER_IS_BETTER = ['tokens_per_s_avg', 'throughput_tokens_per_s', 'peak_requests_per_s', 'score', 'passed'];

export function directionOf(metric, thresholds = []) {
  const t = thresholds.find((x) => x.metric === metric);
  if (t) return t.op.startsWith('<') ? 'lower' : t.op.startsWith('>') ? 'higher' : null;
  if (LOWER_IS_BETTER.includes(metric)) return 'lower';
  if (HIGHER_IS_BETTER.includes(metric) || metric.startsWith('pass_rate:')) return 'higher';
  return null;
}

export function validateThresholds(thresholds) {
  if (thresholds === undefined || thresholds === null) return [];
  if (!Array.isArray(thresholds)) throw Object.assign(new Error('Schwellwerte müssen eine Liste sein'), { statusCode: 400 });
  return thresholds.map((t) => {
    if (!t?.metric || typeof t.metric !== 'string') throw Object.assign(new Error('Schwellwert ohne Kennzahl'), { statusCode: 400 });
    if (!OPS[t.op]) throw Object.assign(new Error(`Ungültiger Operator „${t.op}“`), { statusCode: 400 });
    const value = Number(t.value);
    if (!Number.isFinite(value)) throw Object.assign(new Error(`Schwellwert für ${t.metric} ist keine Zahl`), { statusCode: 400 });
    return { metric: t.metric, op: t.op, value };
  });
}

export function evalThresholds(thresholds, metrics, score) {
  const violations = [];
  for (const t of thresholds ?? []) {
    const actual = t.metric === 'score' ? (score ?? metrics?.score) : metrics?.[t.metric];
    if (typeof actual !== 'number' || Number.isNaN(actual)) violations.push({ ...t, actual: null, message: `${t.metric}: kein Messwert` });
    else if (!OPS[t.op](actual, t.value)) violations.push({ ...t, actual, message: `${t.metric} = ${Math.round(actual * 1000) / 1000}, erwartet ${t.op} ${t.value}` });
  }
  return violations;
}

// Ergebnisart: bestanden, Qualitätsabweichung, Sicherheitsfinding, technischer Fehler oder nicht anwendbar.
export function outcomeOf({ status, type, security }) {
  if (status === 'skipped') return 'not_applicable';
  if (status === 'error') return 'technical_error';
  if (status === 'passed') return 'passed';
  return security || SECURITY_TYPES.includes(type) ? 'security_finding' : 'quality_deviation';
}

export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262];

// Konfidenzintervall des Mittelwerts (t-Verteilung für kleine n).
export function meanCi(values) {
  const v = values.filter((x) => typeof x === 'number');
  const n = v.length;
  if (!n) return null;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, sd: 0, ci95: [mean, mean] };
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const half = (T95[n - 2] ?? 1.96) * (sd / Math.sqrt(n));
  return { n, mean, sd, ci95: [mean - half, mean + half] };
}

// Wilson-Intervall für Anteile (Bestehensquote): auch bei wenigen Fällen belastbar.
export function wilson(passed, total, z = 1.96) {
  if (!total) return null;
  const p = passed / total;
  const denom = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return { n: total, passed, rate: p, ci95: [Math.max(0, centre - half), Math.min(1, centre + half)] };
}

// Wiederholungen zusammenfassen: Kennzahlen als Median, Score als Median, Details des schwächsten Durchlaufs
// (so geht ein Sicherheitsfehler in einer Wiederholung nicht verloren).
export function aggregateRepeats(runs) {
  const ok = runs.filter((r) => r.status !== 'error');
  if (!ok.length) return { ...runs[0], statistics: { n: 0, attempts: runs.length } };
  if (ok.length === 1 && runs.length === 1) return { ...ok[0], statistics: caseStatistics(ok[0]) };
  const keys = new Set(ok.flatMap((r) => Object.keys(r.metrics ?? {})));
  const metrics = {};
  const perMetric = {};
  for (const k of keys) {
    const vals = ok.map((r) => r.metrics?.[k]).filter((x) => typeof x === 'number');
    if (!vals.length) continue;
    metrics[k] = median(vals);
    perMetric[k] = { median: metrics[k], min: Math.min(...vals), max: Math.max(...vals) };
  }
  const scores = ok.map((r) => r.score).filter((x) => typeof x === 'number');
  const worst = ok.reduce((a, b) => ((b.score ?? Infinity) < (a.score ?? Infinity) ? b : a), ok[0]);
  const statuses = ok.map((r) => r.status);
  return {
    status: statuses.every((s) => s === 'passed') ? 'passed' : 'failed',
    model: ok[0].model,
    modelAlias: ok[0].modelAlias,
    score: scores.length ? median(scores) : null,
    metrics,
    details: { ...worst.details, repeats: ok.map((r) => ({ status: r.status, score: r.score, metrics: r.metrics })) },
    statistics: { n: ok.length, attempts: runs.length, errors: runs.length - ok.length, score: meanCi(scores), metrics: perMetric, ...caseStatistics(worst) },
  };
}

// Anteil bestandener Fälle mit Konfidenzintervall, sofern der Testtyp Einzelfälle liefert.
export function caseStatistics(res) {
  const cases = res?.details?.cases;
  if (!Array.isArray(cases) || !cases.length || typeof cases[0]?.ok !== 'boolean') return {};
  const passed = cases.filter((c) => c.ok).length;
  return { cases: wilson(passed, cases.length) };
}

// Vergleich mit dem Ergebnis der Baseline (gleiche Vorlage, Modell, Pfad, Variante).
export function compareToBaseline(current, baseline, { tolerance = 0.2, thresholds = [] } = {}) {
  if (!baseline) return null;
  const cur = { ...current.metrics, score: current.score };
  const base = { ...baseline.metrics, score: baseline.score };
  const deltas = {};
  const regressions = [];
  for (const key of new Set([...Object.keys(cur), ...Object.keys(base)])) {
    const a = base[key];
    const b = cur[key];
    const dir = directionOf(key, thresholds);
    if (!dir || typeof a !== 'number' || typeof b !== 'number' || a === 0) continue;
    const change = (b - a) / Math.abs(a);
    deltas[key] = change;
    if (dir === 'lower' ? change > tolerance : change < -tolerance) regressions.push({ metric: key, baseline: a, current: b, change });
  }
  return { baselineResultId: baseline.id, baselineRunId: baseline.run_id, tolerance, deltas, regressions };
}

// Gepoolte Perzentile über Rohwerte (nicht Mittel von Perzentilen).
export function percentile(values, p) {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (p / 100) * (v.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
}
