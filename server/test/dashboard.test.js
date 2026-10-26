import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envFilter, NORMALIZATION, scale, scorecard, sealFromRate, sloOf, suitability } from '../src/dashboard.js';

const row = (extra) => ({ status: 'passed', score: 1, metrics: {}, samples: null, dataset: null, statistics: null, cases_total: null, cases_passed: null, ...extra });

test('Normalisierung ist versioniert und dokumentiert', () => {
  assert.equal(NORMALIZATION.version, '1');
  for (const dim of ['quality', 'security', 'performance', 'efficiency', 'sovereignty']) assert.ok(NORMALIZATION.dimensions[dim].description.length > 20, dim);
  assert.deepEqual(Object.keys(NORMALIZATION.profiles).sort(), ['agent', 'chat', 'coding', 'ocr']);
});

test('Skalierung: linear zwischen voll und null, begrenzt auf 0 bis 100', () => {
  const s = NORMALIZATION.dimensions.performance.scales.latency_ms_p95;
  assert.equal(scale(1000, s), 100);
  assert.equal(scale(30000, s), 0);
  assert.equal(scale(500, s), 100);
  assert.equal(scale(99999, s), 0);
  assert.ok(Math.abs(scale(15500, s) - 50) < 1);
  assert.equal(scale(null, s), null);
  assert.equal(scale(0.1, NORMALIZATION.dimensions.performance.scales.error_rate), 50);
});

test('Scorecard: Qualität gepoolt über Fälle, nicht über Mittel der Scores', () => {
  const rows = [
    row({ type: 'quality', cases_total: 90, cases_passed: 90, score: 1 }),
    row({ type: 'ocr', cases_total: 10, cases_passed: 0, score: 0, status: 'failed' }),
  ];
  const q = scorecard(rows).dimensions.quality;
  assert.equal(q.value, 90, '90 von 100 Fällen, nicht (100 + 0) / 2');
  assert.equal(q.n, 100);
  assert.ok(q.ci95[0] < 90 && q.ci95[1] > 90);
});

test('Scorecard: Performance aus gepoolten Proben, fehlende Dimensionen bleiben leer', () => {
  const fast = Array.from({ length: 80 }, () => 200);
  const slow = Array.from({ length: 20 }, () => 20_000);
  const card = scorecard([
    row({ type: 'performance', metrics: { tokens_per_s_avg: 50, error_rate: 0 }, samples: { ttft_ms: fast, latency_ms: [...fast, ...slow] } }),
  ]);
  assert.ok(card.dimensions.performance.value > 0 && card.dimensions.performance.value < 100);
  assert.ok(card.dimensions.performance.raw.latency_ms_p95 >= 200);
  assert.equal(card.dimensions.efficiency.value, 50);
  assert.equal(card.dimensions.security, undefined, 'ohne Security-Tests keine Bewertung statt 0');
  assert.equal(card.dimensions.quality, undefined);
});

test('Scorecard: kleine Stichprobe wird markiert, Souveränität aus Modell-Metadaten', () => {
  const card = scorecard([row({ type: 'security', cases_total: 3, cases_passed: 3, dataset: { small_sample: true } })], { model: { open_weights: true, license: 'Apache-2.0', origin: 'DE', revision: 'abc' } });
  assert.equal(card.dimensions.security.low_confidence, true);
  assert.equal(card.low_confidence, true);
  assert.equal(card.dimensions.sovereignty.value, 100);
  assert.equal(scorecard([], { model: { open_weights: false } }).dimensions.sovereignty.value, 0);
});

test('Eignungsprofile: Gewichte, Abdeckung, Vision für OCR', () => {
  const rows = [row({ type: 'quality', score: 0.9 }), row({ type: 'coding', score: 0.9 }), row({ type: 'performance', metrics: { error_rate: 0 }, samples: { ttft_ms: [300], latency_ms: [1000] } })];
  const card = scorecard(rows);
  const byKey = Object.fromEntries(suitability(rows, card, ['tools']).map((p) => [p.key, p]));
  assert.equal(byKey.coding.rating, 'suitable');
  assert.equal(byKey.ocr.rating, 'not_applicable', 'Modell ohne Vision');
  assert.equal(byKey.agent.rating, 'incomplete', 'ohne Tool-Calling und Security zu wenig Messwerte');
  assert.ok(byKey.chat.coverage < 1 && byKey.chat.rating !== 'incomplete');
});

test('SEAL-Stufe aus der Bestehensquote, SLO-Erfüllung, Umgebungsfilter', () => {
  assert.equal(sealFromRate(1), 4);
  assert.equal(sealFromRate(0.85), 3);
  assert.equal(sealFromRate(0.65), 2);
  assert.equal(sealFromRate(0.35), 1);
  assert.equal(sealFromRate(0.1), 0);
  assert.equal(sealFromRate(null), null);
  const slo = sloOf([{ rules: [{}], status: 'passed' }, { rules: [{}], status: 'failed' }, { rules: [], status: 'passed' }]);
  assert.equal(slo.total, 2);
  assert.equal(slo.rate, 0.5);
  assert.equal(envFilter({}), 'prod');
  assert.equal(envFilter({ environment: 'all' }), null);
  assert.equal(envFilter({ environment: 'dev' }), 'dev');
});
