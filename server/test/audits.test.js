import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canEditAudit, canSeeAudit } from '../src/audits.js';
import { capLoadConfig, validateModels } from '../src/plan.js';
import { approvalNeeds, effectiveLimits } from '../src/runs.js';

test('Sichtbarkeit von Prüfungen', () => {
  const audit = { created_by: 'u1', maintainer_id: 'u2', visibility: 'private', teamIds: [] };
  const user = (id, extra = {}) => ({ id, teams: [], ...extra });
  assert.ok(canSeeAudit(user('u1'), audit));
  assert.ok(canSeeAudit(user('u2'), audit));
  assert.ok(canSeeAudit(user('x', { is_admin: true }), audit));
  assert.ok(!canSeeAudit(user('x'), audit));
  assert.ok(canSeeAudit(user('x'), { ...audit, visibility: 'global' }));
  assert.ok(canSeeAudit(user('x', { teams: [{ id: 't' }] }), { ...audit, visibility: 'teams', teamIds: ['t'] }));
  assert.ok(!canSeeAudit(user('x', { teams: [{ id: 'o' }] }), { ...audit, visibility: 'teams', teamIds: ['t'] }));
  assert.ok(!canEditAudit(user('x'), { ...audit, visibility: 'global' }));
  assert.ok(canEditAudit(user('u2'), audit));
});

test('Lastgrenzen: Parallelität und Gesamtdauer werden begrenzt', () => {
  const cfg = { stages: [{ durationS: 20, concurrency: 5 }, { durationS: 20, concurrency: 20 }, { durationS: 20, concurrency: 50 }] };
  const capped = capLoadConfig(cfg, { max_concurrency: 10, max_duration_s: 30 });
  assert.deepEqual(capped.stages, [{ durationS: 20, concurrency: 5 }, { durationS: 10, concurrency: 10 }]);
  assert.equal(capLoadConfig(cfg, {}), cfg, 'ohne Grenzen unverändert');
  assert.deepEqual(effectiveLimits({ max_concurrency: 20, max_duration_s: 60 }, { max_concurrency: 10 }, undefined), { max_concurrency: 10, max_duration_s: 60 }, 'die engere Grenze gilt');
  assert.deepEqual(effectiveLimits({ max_concurrency: 0 }), {});
});

test('Freigabebedarf: Prod-Plattform und Lasttests', () => {
  assert.deepEqual(approvalNeeds({ environment: 'dev' }, [{ applicable: true }]), []);
  assert.deepEqual(approvalNeeds({ environment: 'prod' }, [{ applicable: true }]), ['Prod-Plattform']);
  assert.deepEqual(approvalNeeds({ environment: 'dev' }, [{ applicable: true, load: true }]), ['Lasttest']);
  assert.deepEqual(approvalNeeds({ environment: 'dev' }, [{ applicable: false, load: true }]), [], 'nicht anwendbare Lasttests zählen nicht');
});

test('Modelle mit Pfad prüfen', () => {
  assert.deepEqual(validateModels(['a', { alias: 'b', path: 'both' }, { alias: 'c', path: 'direct', api_key_id: 'k' }]), [
    { alias: 'a', path: 'gateway' },
    { alias: 'b', path: 'both' },
    { alias: 'c', path: 'direct', api_key_id: 'k' },
  ]);
  assert.throws(() => validateModels([{ alias: 'x', path: 'seitlich' }]), /Pfad/);
  assert.throws(() => validateModels([{ path: 'direct' }]), /ohne Namen/);
  assert.throws(() => validateModels('x'), /Liste/);
});
