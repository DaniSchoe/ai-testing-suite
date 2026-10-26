// Offizielle Datensätze, die mit jedem Release mitgeliefert werden (schreibgeschützt, global).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { QUALITY_CASES } from '../src/testtypes/quality.js';
import { LOAD_PROMPTS } from '../src/testtypes/load.js';
import { CODING_TASKS } from '../src/testtypes/coding.js';
import { BUILTIN_CASES } from '../src/testtypes/security.js';
import { TOOL_CASES } from '../src/testtypes/structured.js';
import { THINKING_CASES } from '../src/testtypes/thinking.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/ocr/', import.meta.url));
const QUALITY_CATEGORY = ['logik', 'textaufgabe', 'code', 'wahrscheinlichkeit', 'kombinatorik'];
const LOAD_DIFFICULTY = { leicht: 1, mittel: 3, schwer: 5 };
const OWASP_OF = { prompt_injection: 'LLM01', jailbreak: 'LLM01', harmful: 'LLM01', dlp_input: 'LLM02', dlp_output: 'LLM02' };
const SEVERITY_OF = { prompt_injection: 'high', jailbreak: 'high', harmful: 'critical', dlp_input: 'high', dlp_output: 'medium' };

export const DATASETS = [
  {
    key: 'quality-reasoning-de',
    name: 'Qualität: Logik, Rechnen, Code (Deutsch)',
    description: 'Fünf Fragen mit eindeutiger Lösung von Stufe 1 (leicht) bis 5 (extrem schwer): Ordnungsrelation, Textaufgabe, Code nachvollziehen, Wahrscheinlichkeit, Kombinatorik.',
    kind: 'qa',
    sensitivity: 'public',
    version: '1.0.0',
    rows: () =>
      QUALITY_CASES.map((c, i) => ({
        key: `q${i + 1}`,
        difficulty: c.difficulty,
        category: QUALITY_CATEGORY[i],
        name: c.name,
        prompt: c.prompt,
        expected: c.assert[0].value,
        match: 'answer',
      })),
  },
  {
    key: 'thinking-tasks-de',
    name: 'Thinking: Denkaufgaben (Deutsch)',
    description: 'Fünf Aufgaben, bei denen Reasoning einen Unterschied machen soll (Schläger und Ball, Maschinen, Reihenfolge, Primzahlen, Fahrzeit).',
    kind: 'qa',
    sensitivity: 'public',
    version: '1.0.0',
    rows: () =>
      THINKING_CASES.map((c, i) => ({ key: `t${i + 1}`, difficulty: i < 2 ? 3 : 2, category: 'denksport', name: c.name, prompt: c.prompt, expected: c.assert[0].value, match: 'regex' })),
  },
  {
    key: 'load-prompts-de',
    name: 'Last: Prompt-Pool (Deutsch)',
    description: 'Zwölf Prompts in drei Schwierigkeiten (kurze Fakten bis lange Ausgaben). Wechselnde Prompts verhindern, dass Prefix-Caches die Last verfälschen.',
    kind: 'prompts',
    sensitivity: 'public',
    version: '1.0.0',
    rows: () => LOAD_PROMPTS.map((p, i) => ({ key: `p${String(i + 1).padStart(2, '0')}`, difficulty: LOAD_DIFFICULTY[p.difficulty], category: p.difficulty, prompt: p.prompt, max_tokens: p.maxTokens })),
  },
  {
    key: 'security-owasp-llm-de',
    name: 'Security: Angriffe und DLP (Deutsch)',
    description: 'Prompt Injection, System-Prompt-Leak, Jailbreak, schädliche Anfragen sowie PII im Prompt und in Antworten (DLP). Zuordnung zu OWASP LLM01, LLM02 und LLM07.',
    kind: 'attacks',
    sensitivity: 'attack',
    version: '1.0.0',
    rows: () =>
      BUILTIN_CASES.map((c, i) => ({
        key: `a${i + 1}`,
        difficulty: 2,
        category: c.name === 'System-Prompt ausgeben' ? 'LLM07' : OWASP_OF[c.category],
        subcategory: c.category,
        name: c.name,
        system: c.system,
        prompt: c.prompt,
        expect: c.expect,
        pii: c.pii,
        severity: SEVERITY_OF[c.category],
      })),
  },
  {
    key: 'coding-js-de',
    name: 'Coding: JavaScript (Deutsch)',
    description: 'Zwei Programmieraufgaben: Palindrom-Prüfung (einfach) und ein Parser für Rechenausdrücke ohne eval (komplex). Der Code läuft isoliert gegen vorbereitete Tests.',
    kind: 'coding',
    sensitivity: 'public',
    version: '1.0.0',
    rows: () => CODING_TASKS.map((t, i) => ({ key: `c${i + 1}`, difficulty: t.weight >= 2 ? 4 : 1, category: t.weight >= 2 ? 'parser' : 'strings', name: t.name, weight: t.weight, forbid: t.forbid, prompt: t.prompt, tests: t.tests })),
  },
  {
    key: 'tools-basic',
    name: 'Tool-Calling: Grundfall',
    description: 'Ein Funktionsaufruf mit Argumenten (Wetter-Tool).',
    kind: 'tools',
    sensitivity: 'public',
    version: '1.0.0',
    rows: () => TOOL_CASES.map((c, i) => ({ key: `tc${i + 1}`, difficulty: 1, category: 'tool-calling', name: c.name, prompt: c.prompt, tools: c.tools, expect_tool: c.expectTool, expect_args: c.expectArgs })),
  },
  {
    key: 'ocr-dokumente-de',
    name: 'OCR: Rechnung und Prüfbericht (Deutsch)',
    description: 'Zwei generierte Dokumente: eine strukturierte Rechnung (Aggregation über Positionen) und ein Prüfbericht mit zwei handschriftlichen Unterschriften und Hinweis. Ground Truth je Feld, typisiert.',
    kind: 'documents',
    sensitivity: 'public',
    version: '1.0.0',
    files: async () =>
      Promise.all(['rechnung.png', 'rechnung.pdf', 'pruefbericht.png', 'pruefbericht.pdf'].map(async (name) => ({ name, content: await readFile(`${FIXTURES}${name}`) }))),
    rows: () => [
      {
        key: 'rechnung',
        difficulty: 3,
        category: 'rechnung',
        name: 'Rechnung (strukturiert)',
        file: 'rechnung.png',
        prompt: 'Das Bild zeigt eine Rechnung über einen Einkauf. Werte die Positionen aus und rechne selbst nach.',
        fields: {
          rechnungsbetrag: { value: 270.55, type: 'number', tolerance: 0.005, hint: 'Bruttobetrag in Euro' },
          stueckzahl: { value: 45, type: 'number', hint: 'Summe aller Mengen über alle Positionen' },
          summe_7_prozent: { value: 84.45, type: 'number', tolerance: 0.005, hint: 'Summe der Gesamtpreise aller Positionen mit 7 % MwSt in Euro' },
          teuerste_position: { value: 'Druckerpatrone', type: 'keywords', keywords: ['druckerpatrone'], min: 1, hint: 'Artikelname der Position mit dem höchsten Gesamtpreis' },
        },
      },
      {
        key: 'pruefbericht',
        difficulty: 4,
        category: 'pruefbericht',
        name: 'Prüfbericht (Handschrift und Unterschriften)',
        file: 'pruefbericht.png',
        prompt: 'Das Bild zeigt einen Prüfbericht. Unten gibt es zwei Unterschriftenfelder und einen handschriftlichen Hinweis.',
        fields: {
          unterschriften_vorhanden: { value: true, type: 'bool', hint: 'true, wenn beide Felder unterschrieben sind, sonst false' },
          anzahl_unterschriften: { value: 2, type: 'number', hint: 'Zahl der tatsächlich vorhandenen Unterschriften' },
          handschriftlicher_hinweis: { value: 'Bremsleitung vorne links nach 500 km erneut auf Dichtheit prüfen', type: 'keywords', keywords: ['brems', 'links', '500', 'dicht'], min: 3, hint: 'der handschriftliche Hinweis, wörtlich oder sinngemäß' },
        },
      },
    ],
  },
];
