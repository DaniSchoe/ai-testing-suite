import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, normalizeAnswer, toNumber } from '../src/testtypes/assertions.js';
import { CODING_TASKS, extractCode, runSandboxed } from '../src/testtypes/coding.js';
import { LOAD_PROMPTS, pickPrompt } from '../src/testtypes/load.js';
import { OCR_DOCUMENTS } from '../src/testtypes/ocr.js';
import { QUALITY_CASES } from '../src/testtypes/quality.js';
import { briefResult } from '../src/analysisBrief.js';
import { toClaudeRequest } from '../src/runner/clients.js';
import { testTypes } from '../src/testtypes/index.js';

test('Testarten: Vergleich und Rate-Limit sind entfernt, Coding und OCR neu', () => {
  assert.equal(testTypes.comparison, undefined);
  assert.equal(testTypes.ratelimit, undefined);
  assert.ok(testTypes.coding && testTypes.ocr);
});

test('Antwort-Assertion liest die letzte "Antwort:"-Zeile und normalisiert', async () => {
  const a = { type: 'answer', value: '2016' };
  assert.equal((await check(a, 'Rechnung…\nAntwort: 2.016')).ok, true);
  assert.equal((await check(a, 'Antwort: **2016**.')).ok, true);
  assert.equal((await check(a, 'Antwort: 1800\nAntwort: 2016')).ok, true);
  assert.equal((await check(a, 'Es sind 2016')).ok, false);
  assert.equal((await check({ type: 'answer', value: '15/28' }, 'Antwort: 15 / 28')).ok, true);
  assert.equal(normalizeAnswer(' Carla. '), 'carla');
});

test('Qualität: fünf Fragen, Schwierigkeit 1 bis 5', () => {
  assert.deepEqual(QUALITY_CASES.map((c) => c.difficulty), [1, 2, 3, 4, 5]);
  assert.ok(QUALITY_CASES.every((c) => c.assert[0].type === 'answer'));
});

test('JSON-Felder prüfen (Zahl, Wahrheitswert, Stichwörter)', async () => {
  const doc = OCR_DOCUMENTS[0];
  const good = '```json\n{"rechnungsbetrag": "270,55 €", "stueckzahl": 45, "summe_7_prozent": 84.45, "teuerste_position": "Druckerpatrone schwarz"}\n```';
  const r = await check({ type: 'json_match', expect: doc.expect }, good);
  assert.equal(r.ok, true);
  const bad = await check({ type: 'json_match', expect: doc.expect }, good.replace('45,', '44,'));
  assert.deepEqual(bad.fields.filter((f) => !f.ok).map((f) => f.field), ['stueckzahl']);
  const report = OCR_DOCUMENTS[1];
  const ok = await check(
    { type: 'json_match', expect: report.expect },
    '{"unterschriften_vorhanden": "ja", "anzahl_unterschriften": 2, "handschriftlicher_hinweis": "Bremsleitung vorne links nach 500 km prüfen"}',
  );
  assert.equal(ok.ok, true);
  assert.equal((await check({ type: 'json_match', expect: report.expect }, 'kein json')).ok, false);
  assert.equal(toNumber('1.234,50 €'), 1234.5);
});

test('Lastprompts: Mischung nach Schwierigkeit, alle Stufen vorhanden', () => {
  const levels = new Set(LOAD_PROMPTS.map((p) => p.difficulty));
  assert.deepEqual([...levels].sort(), ['leicht', 'mittel', 'schwer']);
  const counts = { leicht: 0, mittel: 0, schwer: 0 };
  for (let i = 0; i < 3000; i++) counts[pickPrompt(LOAD_PROMPTS).difficulty] += 1;
  assert.ok(counts.leicht > 1000 && counts.mittel > 1000 && counts.schwer > 300 && counts.schwer < 900, JSON.stringify(counts));
  assert.equal(pickPrompt(LOAD_PROMPTS, { schwer: 1 }).difficulty, 'schwer');
  assert.ok(new Set(Array.from({ length: 200 }, () => pickPrompt(LOAD_PROMPTS).prompt)).size > 8, 'wechselnde Prompts');
});

const PALINDROME = 'function isPalindrome(t){const s=t.toLowerCase().replace(/[^a-z0-9]/g,"");return s===[...s].reverse().join("");}';

test('Coding: Code aus der Antwort ausführen, Fehlschläge und Sandbox', async () => {
  const task = CODING_TASKS[0];
  const tests = task.tests.map((t) => ({ ...t, name: t.expr }));
  const good = await runSandboxed({ code: extractCode('Hier:\n```js\n' + PALINDROME + '\nmodule.exports = { isPalindrome };\n```'), tests });
  assert.equal(good.filter((o) => o.ok).length, tests.length);
  const wrong = await runSandboxed({ code: 'function isPalindrome(t){return t === t.split("").reverse().join("");}', tests });
  assert.ok(wrong.some((o) => !o.ok));
  // Endlosschleife, Dateizugriff und Prozesszugriff dürfen nichts bewirken
  const hostile = await runSandboxed({
    code: 'function isPalindrome(t){ if (t === "") { while (true) {} } return typeof require === "function" || typeof process === "object"; }',
    tests: [{ name: 'loop', expr: "isPalindrome('')", expect: true }, { name: 'env', expr: "isPalindrome('x')", expect: false }],
  });
  assert.equal(hostile[0].ok, false);
  assert.match(hostile[0].error, /timed out/);
  assert.equal(hostile[1].ok, true, 'weder require noch process sind im Kontext sichtbar');
  const broken = await runSandboxed({ code: 'function (', tests });
  assert.match(broken[0].error, /nicht ausführbar/);
});

test('Coding: komplexe Aufgabe verbietet eval', () => {
  assert.ok(new RegExp(CODING_TASKS[1].forbid).test('return eval(x)'));
  assert.ok(!new RegExp(CODING_TASKS[1].forbid).test('const evaluated = 1; evaluate(x)'));
});

test('KI-Analyse: Ergebnis wird für den Prompt verkürzt', () => {
  const brief = briefResult({
    test_name: 'T', type: 'load', endpoint_name: 'E', model_alias: 'm', status: 'failed', score: null, duration_ms: 12000,
    metrics: { error_rate: 0.123456, name: 'x' },
    details: { stages: [{ concurrency: 5, requests_per_s: 3.456, error_rate: 0.1, latency_ms_p95: 1234.5, rate_limited: 2, by_difficulty: { leicht: { latency_ms_p95: 400 } } }], regression: { regressions: [{ metric: 'ttft_ms_p95', baseline: 100, current: 150 }] } },
  });
  assert.equal(brief.kennzahlen.error_rate, 0.12);
  assert.equal(brief.kennzahlen.name, undefined);
  assert.equal(brief.laststufen[0].gedrosselt_429, 2);
  assert.equal(brief.regression[0].jetzt, 150);
});

test('Claude-Übersetzung: Bilder werden zu Anthropic-Blöcken', () => {
  const body = toClaudeRequest({
    model: 'c',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Was siehst du?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
  });
  assert.deepEqual(body.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
});
