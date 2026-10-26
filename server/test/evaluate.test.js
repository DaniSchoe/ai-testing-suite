import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateRepeats, caseStatistics, compareToBaseline, directionOf, evalThresholds, meanCi, median, outcomeOf, percentile, validateThresholds, wilson } from '../src/evaluate.js';

test('Schwellwerte: Operatoren, fehlende Messwerte, Score', () => {
  const rules = [{ metric: 'latency_ms_p95', op: '<', value: 8000 }, { metric: 'score', op: '>=', value: 0.95 }, { metric: 'error_rate', op: '<=', value: 0 }];
  assert.equal(evalThresholds(rules, { latency_ms_p95: 7000, error_rate: 0 }, 0.96).length, 0);
  const v = evalThresholds(rules, { latency_ms_p95: 8000 }, 0.9);
  assert.deepEqual(v.map((x) => x.metric), ['latency_ms_p95', 'score', 'error_rate']);
  assert.match(v[2].message, /kein Messwert/);
  assert.equal(evalThresholds([], {}, null).length, 0);
});

test('Schwellwerte prüfen und bereinigen', () => {
  assert.deepEqual(validateThresholds([{ metric: 'score', op: '>=', value: '0.9' }]), [{ metric: 'score', op: '>=', value: 0.9 }]);
  assert.throws(() => validateThresholds([{ metric: 'score', op: '=>', value: 1 }]), /Operator/);
  assert.throws(() => validateThresholds([{ metric: 'score', op: '>=', value: 'viel' }]), /Zahl/);
  assert.throws(() => validateThresholds('x'), /Liste/);
  assert.deepEqual(validateThresholds(undefined), []);
});

test('Ergebnisarten: bestanden, Qualitätsabweichung, Sicherheitsfinding, technischer Fehler, nicht anwendbar', () => {
  assert.equal(outcomeOf({ status: 'passed', type: 'quality' }), 'passed');
  assert.equal(outcomeOf({ status: 'failed', type: 'quality' }), 'quality_deviation');
  assert.equal(outcomeOf({ status: 'failed', type: 'security' }), 'security_finding');
  assert.equal(outcomeOf({ status: 'failed', type: 'access' }), 'security_finding');
  assert.equal(outcomeOf({ status: 'failed', type: 'performance', security: true }), 'security_finding');
  assert.equal(outcomeOf({ status: 'error', type: 'security' }), 'technical_error');
  assert.equal(outcomeOf({ status: 'skipped', type: 'ocr' }), 'not_applicable');
});

test('Statistik: Median, t-Intervall, Wilson-Intervall', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  const ci = meanCi([0.8, 0.9, 1.0]);
  assert.ok(Math.abs(ci.mean - 0.9) < 1e-9);
  assert.ok(ci.ci95[0] < 0.9 && ci.ci95[1] > 0.9 && ci.ci95[1] - ci.ci95[0] > 0.2, 'wenige Wiederholungen: breites Intervall');
  assert.equal(meanCi([0.5]).ci95[0], 0.5);
  const w = wilson(9, 10);
  assert.ok(w.ci95[0] > 0.55 && w.ci95[1] < 1 && w.rate === 0.9);
  assert.ok(wilson(0, 5).ci95[1] > 0.3, 'null Treffer bei fünf Fällen sind kein Beweis für Null');
  assert.equal(wilson(0, 0), null);
  assert.ok(wilson(90, 100).ci95[1] - wilson(90, 100).ci95[0] < w.ci95[1] - w.ci95[0], 'mehr Fälle, engeres Intervall');
});

test('Wiederholungen: Median der Kennzahlen, schwächster Durchlauf liefert die Details', () => {
  const runs = [
    { status: 'passed', score: 1, metrics: { latency_ms_p95: 100 }, details: { cases: [{ ok: true }, { ok: true }] } },
    { status: 'failed', score: 0.5, metrics: { latency_ms_p95: 300 }, details: { cases: [{ ok: true }, { ok: false }] } },
    { status: 'passed', score: 1, metrics: { latency_ms_p95: 200 }, details: { cases: [{ ok: true }, { ok: true }] } },
  ];
  const agg = aggregateRepeats(runs);
  assert.equal(agg.metrics.latency_ms_p95, 200);
  assert.equal(agg.score, 1);
  assert.equal(agg.status, 'failed', 'ein fehlgeschlagener Durchlauf zählt');
  assert.equal(agg.details.cases.filter((c) => !c.ok).length, 1, 'Fehlerfall bleibt sichtbar');
  assert.equal(agg.statistics.n, 3);
  assert.equal(agg.statistics.metrics.latency_ms_p95.max, 300);
  const withError = aggregateRepeats([{ status: 'error', metrics: {}, details: {}, error: 'x' }, runs[0]]);
  assert.equal(withError.statistics.errors, 1);
  assert.equal(aggregateRepeats([{ status: 'error', metrics: {}, details: {} }]).status, 'error');
  assert.equal(caseStatistics({ details: { cases: [{ ok: true }, { ok: false }] } }).cases.passed, 1);
  assert.deepEqual(caseStatistics({ details: {} }), {});
});

test('Baseline: Richtung je Kennzahl, Toleranz, Schwellwert bestimmt die Richtung', () => {
  assert.equal(directionOf('latency_ms_p95'), 'lower');
  assert.equal(directionOf('score'), 'higher');
  assert.equal(directionOf('pass_rate:jailbreak'), 'higher');
  assert.equal(directionOf('eigene_kennzahl'), null);
  assert.equal(directionOf('eigene_kennzahl', [{ metric: 'eigene_kennzahl', op: '<', value: 5 }]), 'lower');
  const base = { id: 'b', run_id: 'r0', score: 0.9, metrics: { latency_ms_p95: 100, tokens_per_s_avg: 50 } };
  const better = compareToBaseline({ score: 0.95, metrics: { latency_ms_p95: 90, tokens_per_s_avg: 60 } }, base, { tolerance: 0.2 });
  assert.equal(better.regressions.length, 0);
  const worse = compareToBaseline({ score: 0.6, metrics: { latency_ms_p95: 150, tokens_per_s_avg: 49 } }, base, { tolerance: 0.2 });
  assert.deepEqual(worse.regressions.map((r) => r.metric).sort(), ['latency_ms_p95', 'score']);
  assert.equal(compareToBaseline({ score: 1, metrics: {} }, null), null);
});

test('Perzentile über Rohwerte statt Mittel von Perzentilen', () => {
  const a = Array.from({ length: 95 }, () => 100);
  const b = Array.from({ length: 5 }, () => 10_000);
  const p95 = percentile([...a, ...b], 95);
  assert.ok(p95 > 100 && p95 < 1000, 'p95 über alle 100 Proben interpoliert zwischen den Gruppen');
  const pooled = percentile([...a, ...b], 99);
  assert.ok(pooled > 5000);
  // Mittelwert der p95 beider Teilmengen wäre (100 + 10000) / 2 und damit falsch.
  assert.ok(Math.abs((percentile(a, 95) + percentile(b, 95)) / 2 - percentile([...a, ...b], 95)) > 2000);
});
