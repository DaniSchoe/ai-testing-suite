import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adaptDataset, contentHash, fileInfo, normalizeCases, parseCsv, parseJsonl } from '../src/datasets.js';
import { bump, compare, isSemver } from '../src/semver.js';

test('CSV: Semikolon, Anführungszeichen, Zeilenumbrüche in Feldern, BOM', () => {
  const rows = parseCsv('﻿key;prompt;expected\n1;"Sag ""Hallo""\nund tschüss";ok\n2;zwei;ok');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].prompt, 'Sag "Hallo"\nund tschüss');
  assert.equal(parseCsv('a,b\n1,2')[0].b, '2');
  assert.throws(() => parseCsv('nur eine Zeile'), /Kopfzeile/);
});

test('JSONL: Zeilen mit Fehlernummer', () => {
  assert.equal(parseJsonl('{"a":1}\n{"a":2}\n').length, 2);
  assert.throws(() => parseJsonl('{"a":1}\n{kaputt'), /Zeile 2/);
});

test('Schema-Prüfung: difficulty, category und Pflichtfelder je Art', () => {
  const ok = normalizeCases('qa', [{ difficulty: 2, category: 'x', prompt: 'p', expected: 'e' }]);
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.cases[0].case_key, '001');
  const bad = normalizeCases('qa', [{ prompt: 'p' }, { difficulty: 9, category: 'x', prompt: 'p', expected: 'e' }]);
  assert.ok(bad.errors.some((e) => e.row === 1 && /difficulty/.test(e.message)));
  assert.ok(bad.errors.some((e) => e.row === 1 && /expected/.test(e.message)));
  assert.ok(bad.errors.some((e) => e.row === 2 && /difficulty/.test(e.message)));
  assert.ok(normalizeCases('qa', []).errors[0].message.includes('keine Fälle'));
  const dup = normalizeCases('qa', [{ key: 'a', difficulty: 1, category: 'c', prompt: 'p', expected: 'e' }, { key: 'a', difficulty: 1, category: 'c', prompt: 'p', expected: 'e' }]);
  assert.ok(dup.errors.some((e) => /doppelt/.test(e.message)));
});

test('Schema-Prüfung: Angriffe, Coding und Dokumente mit Ground Truth', () => {
  assert.ok(normalizeCases('attacks', [{ difficulty: 1, category: 'jailbreak', prompt: 'p', expect: 'egal' }]).errors.length);
  assert.equal(normalizeCases('attacks', [{ difficulty: 1, category: 'jailbreak', prompt: 'p', expect: 'refuse' }]).errors.length, 0);
  assert.ok(normalizeCases('coding', [{ difficulty: 1, category: 'c', prompt: 'p', tests: 'kaputt' }]).errors.length);
  const doc = (fields) => normalizeCases('documents', [{ difficulty: 1, category: 'rechnung', file: 'a.png', fields }], { fileNames: new Set(['a.png']) });
  assert.equal(doc({ betrag: { type: 'number', value: '10,5' } }).errors.length, 1, 'Zahl mit Komma ist keine Zahl');
  assert.equal(doc({ betrag: { type: 'number', value: 10.5, tolerance: 0.01 }, datum: { type: 'date', value: '2026-10-12' } }).errors.length, 0);
  assert.ok(doc({ d: { type: 'date', value: 'gestern' } }).errors.length);
  assert.ok(doc({ x: { type: 'unbekannt', value: 1 } }).errors.length);
  assert.ok(normalizeCases('documents', [{ difficulty: 1, category: 'r', file: 'fehlt.png', fields: { a: { type: 'exact', value: 'x' } } }]).errors.some((e) => /nicht hochgeladen/.test(e.message)));
});

test('Dateien: erlaubte Typen und Größe', () => {
  assert.equal(fileInfo('a.png', Buffer.from('x').toString('base64')).content_type, 'image/png');
  assert.throws(() => fileInfo('a.exe', 'eA=='), /erlaubt/);
  assert.throws(() => fileInfo('../a.png', 'eA=='), /erlaubt/);
  assert.throws(() => fileInfo('a.png', ''), /leer/);
});

test('Hash: gleicher Inhalt gleicher Hash, Reihenfolge der Schlüssel egal, Änderung ändert den Hash', () => {
  const a = [{ case_key: '1', difficulty: 1, category: 'c', data: { prompt: 'p', expected: 'e' } }];
  const b = [{ case_key: '1', difficulty: 1, category: 'c', data: { expected: 'e', prompt: 'p' } }];
  assert.equal(contentHash(a, []), contentHash(b, []));
  assert.notEqual(contentHash(a, []), contentHash([{ ...a[0], data: { prompt: 'q', expected: 'e' } }], []));
  const f = fileInfo('a.png', Buffer.from('bild').toString('base64'));
  assert.notEqual(contentHash(a, []), contentHash(a, [f]));
});

test('Datensatz → Konfiguration der Testart', () => {
  const ds = { cases: [{ case_key: 'q1', difficulty: 3, category: 'logik', data: { prompt: 'Frage', expected: '42', match: 'answer' } }], files: [] };
  const q = adaptDataset('quality', ds);
  assert.deepEqual(q.cases[0].assert, [{ type: 'answer', value: '42' }]);
  assert.equal(q.cases[0].difficulty, 3);
  const doc = adaptDataset('ocr', {
    cases: [{ case_key: 'd1', difficulty: 1, category: 'rechnung', data: { file: 'r.png', fields: { a: { type: 'exact', value: 'x' } } } }],
    files: [{ name: 'r.png', content_type: 'image/png', content: Buffer.from('png') }],
  });
  assert.match(doc.documents[0].dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(adaptDataset('smoke', ds), {});
});

test('Semantische Versionen', () => {
  assert.ok(isSemver('1.10.0') && !isSemver('1.0') && !isSemver('v1.0.0'));
  assert.equal(compare('1.10.0', '1.9.0'), 1);
  assert.equal(bump('1.2.3', 'minor'), '1.3.0');
  assert.equal(bump('1.2.3', 'major'), '2.0.0');
  assert.equal(bump('1.2.3', 'patch'), '1.2.4');
  assert.throws(() => bump('x', 'minor'), /Ungültige Version/);
});
