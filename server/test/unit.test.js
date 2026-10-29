import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, findPii, looksLikeRefusal } from '../src/testtypes/assertions.js';
import { checkThresholds } from '../src/testtypes/performance.js';
import { percentile } from '../src/runner/clients.js';

test('percentile', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 100], 95), 100);
  assert.equal(percentile([], 95), null);
});

test('Schwellwerte', () => {
  const v = checkThresholds({ ttft_ms_p95: 900, error_rate: 0 }, { ttft_ms_p95: { max: 800 }, error_rate: { max: 0.05 }, tokens_per_s_avg: { min: 10 } });
  assert.equal(v.length, 2);
  assert.match(v[0], /ttft_ms_p95/);
  assert.match(v[1], /kein Messwert/);
});

test('Assertions', async () => {
  assert.equal((await check({ type: 'contains', value: 'berlin' }, 'Berlin')).ok, true);
  assert.equal((await check({ type: 'regex', value: '\\b391\\b' }, '381')).ok, false);
  assert.equal((await check({ type: 'json', required: ['a'] }, '```json\n{"a":1}\n```')).ok, true);
  assert.equal((await check({ type: 'no_pii' }, 'Mail an max@example.com')).ok, false);
});

test('PII- und Verweigerungserkennung', () => {
  assert.deepEqual(findPii('Karte 4111 1111 1111 1111', ['credit_card']), ['credit_card']);
  assert.deepEqual(findPii('IBAN DE89 3704 0044 0532 0130 00', ['iban']), ['iban']);
  assert.equal(looksLikeRefusal('Das kann ich nicht tun.'), true);
  assert.equal(looksLikeRefusal('Berlin'), false);
});

test('Deutsche Ablehnungen und Secret-Platzhalter', () => {
  assert.equal(looksLikeRefusal('Ich kann diese Anfrage nicht erfüllen. Ich bin darauf programmiert, hilfreich zu sein.'), true);
  assert.equal(looksLikeRefusal('Ich kann diese Anfrage nicht beantworten.'), true);
  assert.equal(looksLikeRefusal('Ich kann und darf keine sensiblen Daten speichern.'), true);
  assert.equal(looksLikeRefusal('Schritt 1: Besorge dir Aceton.'), false);
  assert.deepEqual(findPii('Format: sk-proj-' + 'X'.repeat(48), ['api_key']), []);
  assert.deepEqual(findPii('Key: sk-proj-' + 'aB3dE5gH7jK9mN1pQ3sT5vW7', ['api_key']), ['api_key']);
  // Offensichtliche Beispiele und abgeschnittene Keys sind kein Leak
  for (const example of ['z. B. `sk-abc123xyz789...`', 'sk-abc123def456ghi789jkl012mno345', 'sk-your-api-key-here-1234', 'sk-example1234567890abcdef', 'sk-aB3dE5gH7jK9mN1pQ3sT5vW7…', 'AKIAIOSFODNN7EXAMPLE']) {
    assert.deepEqual(findPii(example, ['api_key']), [], example);
  }
  assert.deepEqual(findPii('Hier: sk-aB3dE5gH7jK9mN1pQ3sT5vW7xZ und sk-abc123xyz789...', ['api_key']), ['api_key']);
});

test('Modell-Aliase auflösen', async () => {
  process.env.AUTH_MODE ??= 'dev';
  const { resolveModel, aliasOf } = await import('../src/models.js');
  const rows = [
    { name: 'Qwen/Qwen3-32B', alias: 'qwen3-32b' },
    { name: 'mock-small', alias: null },
  ];
  assert.deepEqual(resolveModel(rows, 'qwen3-32b'), { name: 'Qwen/Qwen3-32B', alias: 'qwen3-32b' });
  assert.deepEqual(resolveModel(rows, 'Qwen/Qwen3-32B'), { name: 'Qwen/Qwen3-32B', alias: 'qwen3-32b' });
  assert.deepEqual(resolveModel(rows, 'mock-small'), { name: 'mock-small', alias: 'mock-small' });
  assert.deepEqual(resolveModel(rows, 'unbekannt'), { name: 'unbekannt', alias: 'unbekannt' });
  assert.equal(aliasOf(rows, 'Qwen/Qwen3-32B'), 'qwen3-32b');
});

test('Berechtigungen und Admin per E-Mail', async () => {
  const { effectivePermissions, isEnvAdmin, PERMISSION_KEYS } = await import('../src/permissions.js');
  assert.deepEqual(effectivePermissions({ rolePermissions: ['runs.start', 'suite.view', 'unbekannt'] }), ['suite.view', 'runs.start']);
  assert.deepEqual(effectivePermissions({ hasAdminRole: true }), PERMISSION_KEYS);
  const admins = ['ops@example.com'];
  assert.equal(isEnvAdmin({ email: 'Ops@Example.com', email_verified: true }, admins), true);
  assert.equal(isEnvAdmin({ email: 'ops@example.com', email_verified: false }, admins), false, 'nur bestätigte E-Mail');
  assert.equal(isEnvAdmin({ email: 'dev@example.com', email_verified: true }, admins), false);
});

test('Sichtbarkeitsbereich', async () => {
  const { resolveScope } = await import('../src/scope.js');
  const viewer = { id: 'u1', permissions: ['suite.view'], teams: [{ id: 't1' }] };
  assert.equal(resolveScope(viewer, { scope: 'all' }).scope, 'me');
  assert.equal(resolveScope(viewer, { scope: 'team', teamId: 't1' }).scope, 'team');
  assert.throws(() => resolveScope(viewer, { scope: 'team', teamId: 't2' }), /Kein Mitglied/);
  const lead = { ...viewer, permissions: ['suite.view', 'results.view_all'] };
  assert.equal(resolveScope(lead, { scope: 'global' }).scope, 'all');
  assert.equal(resolveScope(lead, { scope: 'team', teamId: 't2' }).teamId, 't2');
});
