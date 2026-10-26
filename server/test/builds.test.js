import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atomPlan, canEditBuild, canSeeBuild } from '../src/builds.js';

test('atomPlan: Testart × Modell je nach modelMode', () => {
  const plan = atomPlan({
    name: 'T',
    types: ['smoke', 'performance', 'access', 'mcp'],
    models: ['a', 'b'],
    configs: { performance: { requests: 3 } },
  });
  assert.deepEqual(
    plan.map((p) => [p.type, p.key]),
    [['smoke', ''], ['performance', 'a'], ['performance', 'b'], ['access', ''], ['mcp', '']],
  );
  assert.deepEqual(plan[0].config.models, ['a', 'b']);
  assert.equal(plan[1].config.model, 'a');
  assert.equal(plan[1].config.requests, 3);
  assert.equal(plan[3].config.model, 'a');
  assert.equal(plan[4].config.model, undefined);
});

test('atomPlan: ohne Modelle ein Einzeltest je Testart, Name nur bei einem Einzeltest unverändert', () => {
  assert.equal(atomPlan({ name: 'Nur einer', types: ['quality'], models: [], configs: {} })[0].name, 'Nur einer');
  const two = atomPlan({ name: 'T', types: ['quality', 'load'], models: [], configs: {} });
  assert.equal(two.length, 2);
  assert.ok(two.every((p) => p.name.startsWith('T · ')));
});

test('Sichtbarkeit von Tests', () => {
  const build = { created_by: 'u1', maintainer_id: 'u2', visibility: 'private', teamIds: [] };
  const user = (id, extra = {}) => ({ id, teams: [], ...extra });
  assert.ok(canSeeBuild(user('u1'), build));
  assert.ok(canSeeBuild(user('u2'), build));
  assert.ok(canSeeBuild(user('x', { is_admin: true }), build));
  assert.ok(!canSeeBuild(user('x'), build));
  assert.ok(canSeeBuild(user('x'), { ...build, visibility: 'global' }));
  assert.ok(canSeeBuild(user('x', { teams: [{ id: 't' }] }), { ...build, visibility: 'teams', teamIds: ['t'] }));
  assert.ok(!canSeeBuild(user('x', { teams: [{ id: 'o' }] }), { ...build, visibility: 'teams', teamIds: ['t'] }));
  assert.ok(!canEditBuild(user('x'), { ...build, visibility: 'global' }));
  assert.ok(canEditBuild(user('u2'), build));
});
