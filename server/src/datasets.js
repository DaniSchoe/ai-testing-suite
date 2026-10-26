// Datensätze: Parsen (CSV, JSONL), Schema-Prüfung je Art, Versionen mit Hash und Aufbereitung für die Testarten.
import { createHash } from 'node:crypto';
import { many, one } from './db.js';
import { bump, compare, isSemver } from './semver.js';

export const KINDS = {
  qa: { label: 'Fragen und Antworten', required: ['prompt', 'expected'], types: ['quality', 'thinking'] },
  prompts: { label: 'Prompt-Pool', required: ['prompt'], types: ['load', 'performance'] },
  attacks: { label: 'Angriffe und DLP', required: ['prompt', 'expect'], types: ['security'] },
  coding: { label: 'Programmieraufgaben', required: ['prompt', 'tests'], types: ['coding'] },
  tools: { label: 'Tool-Calling', required: ['prompt'], types: ['structured'] },
  documents: { label: 'Dokumente und Bilder (OCR, RAG)', required: ['file', 'fields'], types: ['ocr'] },
};
export const SENSITIVITIES = ['public', 'internal', 'customer', 'attack'];
export const FIELD_TYPES = ['exact', 'text', 'number', 'date', 'iban', 'bool', 'keywords'];
const MATCHES = ['answer', 'contains', 'equals', 'regex'];
const EXPECTS = ['refuse', 'no_leak', 'blocked'];
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const FILE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown' };

const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });

// --- Parser ---------------------------------------------------------------------------------------------------------------------------

// CSV nach RFC 4180: Komma oder Semikolon als Trenner, Anführungszeichen mit "" als Escape, Zeilenumbrüche in Feldern.
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const delimiter = (src.split('\n')[0].match(/;/g) ?? []).length > (src.split('\n')[0].match(/,/g) ?? []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  if (rows.length < 2) throw bad('CSV braucht eine Kopfzeile und mindestens eine Datenzeile');
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export function parseJsonl(text) {
  const out = [];
  for (const [i, line] of String(text).split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      throw bad(`Zeile ${i + 1}: kein gültiges JSON`);
    }
  }
  return out;
}

// CSV-Zellen, die wie JSON aussehen (Listen, Objekte), als JSON lesen.
function cell(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}

// --- Schema-Prüfung ---------------------------------------------------------------------------------------------------------------

// Rohzeilen (aus CSV/JSONL/JSON) in Fälle überführen und je Art prüfen. Liefert { cases, errors }; Fehler nennen die Zeile.
export function normalizeCases(kind, rows, { fileNames = new Set() } = {}) {
  const spec = KINDS[kind];
  if (!spec) throw bad(`Unbekannte Datensatzart "${kind}"`);
  const cases = [];
  const errors = [];
  const keys = new Set();
  rows.forEach((raw, i) => {
    const line = i + 1;
    const err = (message) => errors.push({ row: line, message });
    const { difficulty, category, key, case_key, data: nested, ...flat } = raw ?? {};
    const data = Object.fromEntries(Object.entries({ ...flat, ...(nested && typeof nested === 'object' ? nested : {}) }).map(([k, v]) => [k, cell(v)]));
    if (data.question !== undefined && data.prompt === undefined) {
      data.prompt = data.question;
      delete data.question;
    }
    const d = Number(difficulty);
    if (!Number.isInteger(d) || d < 1 || d > 5) err('difficulty fehlt oder ist keine Zahl von 1 bis 5');
    const cat = String(category ?? '').trim();
    if (!cat) err('category fehlt');
    for (const field of spec.required) if (data[field] === undefined || data[field] === '' || data[field] === null) err(`Feld "${field}" fehlt`);
    if (kind === 'qa' && data.match && !MATCHES.includes(data.match)) err(`match muss eine von ${MATCHES.join(', ')} sein`);
    if (kind === 'attacks' && data.expect && !EXPECTS.includes(data.expect)) err(`expect muss eine von ${EXPECTS.join(', ')} sein`);
    if (kind === 'coding') {
      if (!Array.isArray(data.tests) || !data.tests.length || !data.tests.every((t) => t && typeof t.expr === 'string' && ('expect' in t || t.throws))) {
        err('tests muss eine Liste aus { expr, expect | throws } sein');
      }
    }
    if (kind === 'tools' && data.tools !== undefined && !Array.isArray(data.tools)) err('tools muss eine Liste sein');
    if (kind === 'documents') {
      if (!fileNames.has(data.file)) err(`Datei "${data.file}" wurde nicht hochgeladen`);
      const fields = data.fields;
      if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) err('fields muss ein Objekt mit Ground Truth sein');
      else {
        for (const [name, f] of Object.entries(fields)) {
          if (!f || typeof f !== 'object' || !('value' in f)) err(`Feld "${name}": value fehlt`);
          else if (!FIELD_TYPES.includes(f.type)) err(`Feld "${name}": type muss einer von ${FIELD_TYPES.join(', ')} sein`);
          else if (f.type === 'number' && !Number.isFinite(Number(f.value))) err(`Feld "${name}": value ist keine Zahl`);
          else if (f.type === 'bool' && typeof f.value !== 'boolean') err(`Feld "${name}": value muss true oder false sein`);
          else if (f.type === 'date' && Number.isNaN(Date.parse(String(f.value)))) err(`Feld "${name}": value ist kein Datum (ISO, z. B. 2026-10-12)`);
        }
      }
    }
    const caseKey = String(key ?? case_key ?? '').trim() || `${String(i + 1).padStart(3, '0')}`;
    if (keys.has(caseKey)) err(`Fall-Schlüssel "${caseKey}" kommt doppelt vor`);
    keys.add(caseKey);
    cases.push({ position: i, case_key: caseKey, difficulty: d, category: cat, data });
  });
  if (!cases.length) errors.push({ row: 0, message: 'Der Datensatz enthält keine Fälle' });
  return { cases, errors };
}

export function fileInfo(name, base64) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (!/^[\w.-]{1,120}$/.test(name) || !FILE_TYPES[ext]) throw bad(`Datei "${name}": erlaubt sind PNG, JPG, PDF, TXT und MD mit einem einfachen Dateinamen`);
  const content = Buffer.from(String(base64 ?? ''), 'base64');
  if (!content.length) throw bad(`Datei "${name}" ist leer`);
  if (content.length > MAX_FILE_BYTES) throw bad(`Datei "${name}" ist größer als ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  return { name, content_type: FILE_TYPES[ext], size: content.length, content, hash: createHash('sha256').update(content).digest('hex') };
}

// Hash über Fälle und Dateien: derselbe Inhalt ergibt immer denselben Hash (Reihenfolge der Fälle zählt).
export function contentHash(cases, files) {
  const h = createHash('sha256');
  h.update(JSON.stringify(cases.map((c) => [c.case_key, c.difficulty, c.category, sortKeys(c.data)])));
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) h.update(`${f.name}:${f.hash}`);
  return h.digest('hex');
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

// --- Speichern und Laden ------------------------------------------------------------------------------------------------------

// Neue unveränderliche Version anlegen. `version` ist eine explizite x.y.z oder ein Sprung (major | minor | patch) auf Basis der höchsten.
export async function createVersion(client, datasetId, { version, bumpKind, cases, files = [], notes, userId }) {
  const { rows: existing } = await client.query('select version, hash from dataset_versions where dataset_id = $1', [datasetId]);
  const top = existing.map((e) => e.version).sort(compare).at(-1);
  const next = isSemver(version) ? version : top ? bump(top, bumpKind ?? 'minor') : '1.0.0';
  if (existing.some((e) => e.version === next)) throw bad(`Version ${next} existiert bereits`);
  const hash = contentHash(cases, files);
  const { rows } = await client.query(
    `insert into dataset_versions (dataset_id, version, hash, case_count, file_count, notes, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [datasetId, next, hash, cases.length, files.length, notes ?? null, userId ?? null],
  );
  const v = rows[0];
  for (const c of cases) {
    await client.query('insert into dataset_cases (version_id, position, case_key, difficulty, category, data) values ($1, $2, $3, $4, $5, $6)', [
      v.id, c.position, c.case_key, c.difficulty, c.category, JSON.stringify(c.data),
    ]);
  }
  for (const f of files) {
    await client.query('insert into dataset_files (version_id, name, content_type, size, hash, content) values ($1, $2, $3, $4, $5, $6)', [
      v.id, f.name, f.content_type, f.size, f.hash, f.content,
    ]);
  }
  await client.query('update datasets set updated_at = now() where id = $1', [datasetId]);
  return v;
}

// Datensatz per Schlüssel und Version finden: eigener Mandant vor global (offiziell).
export async function findVersion(tenantId, key, version) {
  return one(
    `select v.*, d.id as dataset_id, d.key, d.name, d.kind, d.language, d.sensitivity, d.min_cases, d.tenant_id, d.origin
     from datasets d join dataset_versions v on v.dataset_id = d.id
     where d.key = $1 and (d.tenant_id = $2 or d.tenant_id is null) and ($3::text is null or v.version = $3)
     order by (d.tenant_id is not null) desc, string_to_array(v.version, '.')::int[] desc limit 1`,
    [key, tenantId, version ?? null],
  );
}

export async function loadVersion(versionId) {
  const v = await one(
    `select v.*, d.key, d.name, d.kind, d.language, d.sensitivity, d.min_cases, d.tenant_id, d.origin
     from dataset_versions v join datasets d on d.id = v.dataset_id where v.id = $1`,
    [versionId],
  );
  if (!v) return null;
  const [cases, files] = await Promise.all([
    many('select position, case_key, difficulty, category, data from dataset_cases where version_id = $1 order by position', [versionId]),
    many('select name, content_type, size, hash, content from dataset_files where version_id = $1 order by name', [versionId]),
  ]);
  return { ...v, cases, files };
}

// --- Aufbereitung für die Testarten ---------------------------------------------------------------------------------------

const LEVEL = (d) => (d <= 2 ? 'leicht' : d === 3 ? 'mittel' : 'schwer');

// Konfiguration, die eine Testart aus einem Datensatz bezieht. Ergänzt (überschreibt) die Konfiguration der Vorlage.
export function adaptDataset(type, ds) {
  const cases = ds.cases;
  switch (type) {
    case 'quality':
    case 'thinking':
      return {
        cases: cases.map((c) => {
          const match = c.data.match ?? 'answer';
          return {
            name: c.data.name ?? `Stufe ${c.difficulty} · ${c.category}`,
            difficulty: c.difficulty,
            category: c.category,
            system: c.data.system,
            prompt: c.data.prompt,
            assert: [{ type: match, value: c.data.expected }],
          };
        }),
      };
    case 'load':
    case 'performance':
      return {
        prompts: cases.map((c) => ({ difficulty: LEVEL(c.difficulty), category: c.category, maxTokens: Number(c.data.max_tokens) || 128, prompt: c.data.prompt })),
      };
    case 'security':
      return {
        useBuiltin: false,
        categories: [],
        cases: cases.map((c) => ({ category: c.category, name: c.data.name ?? c.case_key, system: c.data.system, prompt: c.data.prompt, expect: c.data.expect, pii: c.data.pii, severity: c.data.severity, difficulty: c.difficulty })),
      };
    case 'coding':
      return {
        tasks: cases.map((c) => ({ name: c.data.name ?? c.case_key, weight: Number(c.data.weight) || (c.difficulty >= 3 ? 2 : 1), forbid: c.data.forbid, prompt: c.data.prompt, tests: c.data.tests })),
      };
    case 'structured':
      return {
        cases: cases.map((c) => ({ name: c.data.name ?? c.case_key, prompt: c.data.prompt, tools: c.data.tools, expectTool: c.data.expect_tool ?? c.data.expectTool, expectArgs: c.data.expect_args ?? c.data.expectArgs, responseFormat: c.data.response_format })),
      };
    case 'ocr': {
      const byName = new Map(ds.files.map((f) => [f.name, f]));
      return {
        documents: cases.map((c) => {
          const f = byName.get(c.data.file);
          return {
            name: c.data.name ?? c.data.file,
            category: c.category,
            file: c.data.file,
            dataUrl: f && f.content_type.startsWith('image/') ? `data:${f.content_type};base64,${f.content.toString('base64')}` : null,
            prompt: c.data.prompt ?? '',
            fields: c.data.fields,
          };
        }),
      };
    }
    default:
      return {};
  }
}
