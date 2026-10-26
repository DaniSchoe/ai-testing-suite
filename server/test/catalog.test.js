import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canEditTemplate, canSeeTemplate, parseDocument, SCHEMA, serialize, slug, specHash } from '../src/catalog.js';
import { evidenceHash, sha256 } from '../src/findings.js';

test('Sichtbarkeit im Katalog: offiziell für alle, privat nur für Besitzer, Team für Mitglieder, Reviewer sehen den Mandanten', async () => {
  const user = (extra = {}) => ({ id: 'u', tenant_id: 't1', teams: [], permissions: [], ...extra });
  const tpl = (extra = {}) => ({ origin: 'private', tenant_id: 't1', owner_id: 'o', team_id: null, ...extra });
  assert.equal(await canSeeTemplate(user(), { origin: 'official', tenant_id: null }), true);
  assert.equal(await canSeeTemplate(user(), tpl()), false);
  assert.equal(await canSeeTemplate(user({ id: 'o' }), tpl()), true);
  assert.equal(await canSeeTemplate(user({ is_admin: true }), tpl()), true);
  assert.equal(await canSeeTemplate(user({ permissions: ['catalog.publish'] }), tpl()), true, 'Reviewer');
  assert.equal(await canSeeTemplate(user({ is_admin: true }), tpl({ tenant_id: 't2' })), false, 'anderer Mandant');
  assert.equal(await canSeeTemplate(user({ teams: [{ id: 'x' }] }), tpl({ origin: 'team', team_id: 'x' })), true);
  assert.equal(await canSeeTemplate(user({ teams: [{ id: 'y' }] }), tpl({ origin: 'team', team_id: 'x' })), false);
  assert.equal(canEditTemplate(user({ id: 'o' }), tpl()), true);
  assert.equal(canEditTemplate(user({ is_admin: true }), { origin: 'official', tenant_id: null }), false, 'offiziell ist schreibgeschützt');
});

test('Hash einer Vorlagenversion hängt von Inhalt und Kategorien ab, nicht von deren Reihenfolge', () => {
  const spec = { config: { a: 1 } };
  assert.equal(specHash('quality', spec, ['b', 'a']), specHash('quality', spec, ['a', 'b']));
  assert.notEqual(specHash('quality', spec, ['a']), specHash('quality', { config: { a: 2 } }, ['a']));
  assert.notEqual(specHash('quality', spec, ['a']), specHash('security', spec, ['a']));
});

test('Export und Import: YAML und JSON, Schema und Version werden geprüft', () => {
  const doc = { schema: SCHEMA, kind: 'template', version: '1.2.0', template: { key: 'x', name: 'X', type: 'quality' }, spec: { config: {} } };
  for (const format of ['yaml', 'json']) {
    const text = serialize(doc, format);
    assert.deepEqual(parseDocument(text, format), doc);
  }
  assert.deepEqual(parseDocument(serialize(doc, 'json'), 'yaml'), doc, 'JSON wird auch bei Format yaml erkannt');
  assert.throws(() => parseDocument('schema: andere/v2\nkind: template', 'yaml'), /Schema/);
  assert.throws(() => parseDocument(serialize({ ...doc, kind: 'ding' }, 'yaml'), 'yaml'), /kind/);
  assert.throws(() => parseDocument(serialize({ ...doc, version: '1.2' }, 'yaml'), 'yaml'), /Version/);
  assert.throws(() => parseDocument('{ kaputt', 'json'), /nicht lesbar/);
});

test('Schlüssel aus Namen', () => {
  assert.equal(slug('Rechnen: Größe & Maße'), 'rechnen-groesse-masse');
  assert.equal(slug('  --  '), '');
});

test('Nachweis-Hash: unabhängig von der Reihenfolge der Schlüssel, ändert sich mit dem Inhalt', () => {
  const a = evidenceHash({ prompt: 'p', response: 'r', assessment: { ok: true, x: 1 } });
  const b = evidenceHash({ response: 'r', assessment: { x: 1, ok: true }, prompt: 'p' });
  assert.equal(a, b);
  assert.notEqual(a, evidenceHash({ prompt: 'p', response: 'r2', assessment: { ok: true, x: 1 } }));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(sha256('a'), sha256('a'));
});
