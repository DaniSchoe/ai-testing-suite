// Testkatalog: Sichtbarkeit, Spezifikations-Prüfung, Hash sowie Export und Import (YAML/JSON, auch ohne Internet).
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { hasPermission } from './permissions.js';
import { many, one } from './db.js';
import { loadVersion, findVersion } from './datasets.js';
import { validateThresholds } from './evaluate.js';
import { isSemver } from './semver.js';
import { testTypes } from './testtypes/index.js';

export const SCHEMA = 'ai-testing-suite/v1';
export const REQUIREMENTS = ['vision', 'tools', 'reasoning', 'mcp', 'json'];
export const USE_CASES = ['chat', 'coding', 'ocr', 'agent'];
// Was eine Vorlage prüft: die Plattform selbst, das Sprachmodell, Daten oder Prozesse.
export const TARGETS = ['platform', 'llm', 'data', 'process'];

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export { bad };

// Offizielle Inhalte sehen alle. Eigene (private) Inhalte nur Besitzer und Administratoren, Team-Inhalte die Teammitglieder;
// Reviewer (catalog.publish) sehen alle Inhalte ihres Mandanten, damit sie freigeben können.
export async function canSeeTemplate(user, t) {
  if (t.origin === 'official' || !t.tenant_id) return true;
  if (t.tenant_id !== user.tenant_id) return false;
  if (user.is_admin || hasPermission(user, 'catalog.publish') || t.owner_id === user.id) return true;
  if (t.origin === 'team') return (user.teams ?? []).some((x) => x.id === t.team_id);
  return false;
}
export const canEditTemplate = (user, t) => t.origin !== 'official' && t.tenant_id === user.tenant_id && (user.is_admin || t.owner_id === user.id);

export const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const specHash = (type, spec, categoryKeys) => sha({ type, spec, categories: [...categoryKeys].sort() });

export const slug = (s) => String(s).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// Spezifikation einer Vorlagenversion prüfen und bereinigen.
export async function validateSpec(user, type, spec) {
  if (!testTypes[type]) throw bad(`Unbekannter Testtyp „${type}“`);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw bad('Spezifikation muss ein Objekt sein');
  const out = {};
  if (spec.config !== undefined) {
    if (typeof spec.config !== 'object' || Array.isArray(spec.config)) throw bad('config muss ein Objekt sein');
    out.config = spec.config;
  } else out.config = {};
  if (spec.params !== undefined) {
    if (typeof spec.params !== 'object' || Array.isArray(spec.params)) throw bad('params muss ein Objekt sein');
    out.params = spec.params;
  }
  if (spec.dataset) {
    if (!spec.dataset.key) throw bad('dataset.key fehlt');
    const found = await findVersion(user.tenant_id, spec.dataset.key, spec.dataset.version ?? null);
    if (!found) throw bad(`Datensatz „${spec.dataset.key}${spec.dataset.version ? `@${spec.dataset.version}` : ''}“ nicht gefunden`);
    if (found.sensitivity === 'attack' && !hasPermission(user, 'security.payloads')) throw bad('Angriffs-Datensätze brauchen die Berechtigung security.payloads', 403);
    out.dataset = { key: found.key, version: found.version };
  } else out.dataset = null;
  const requires = spec.requires ?? [];
  if (!Array.isArray(requires) || requires.some((r) => !REQUIREMENTS.includes(r))) throw bad(`requires: erlaubt sind ${REQUIREMENTS.join(', ')}`);
  out.requires = requires;
  if (spec.repeats !== undefined) {
    const n = Number(spec.repeats);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw bad('repeats: 1 bis 20');
    out.repeats = n;
  }
  if (spec.load !== undefined) out.load = Boolean(spec.load);
  out.suggested_thresholds = validateThresholds(spec.suggested_thresholds ?? []);
  for (const k of ['scoring', 'output', 'prompt', 'example_result', 'invalid_json', 'notes', 'source']) if (spec[k] !== undefined) out[k] = spec[k];
  return out;
}

export function validateTarget(target) {
  const v = target ?? 'llm';
  if (!TARGETS.includes(v)) throw bad(`Test-Ziel: erlaubt sind ${TARGETS.join(', ')}`);
  return v;
}

export function validateUseCases(list) {
  const v = list ?? [];
  if (!Array.isArray(v) || v.some((x) => !USE_CASES.includes(x))) throw bad(`Einsatzprofile: erlaubt sind ${USE_CASES.join(', ')}`);
  return v;
}

// --- Export ------------------------------------------------------------------------------------------------------------------------------

async function datasetDoc(user, key, version, includeFiles = true) {
  const found = await findVersion(user.tenant_id, key, version);
  if (!found) return null;
  if (found.sensitivity === 'attack' && !hasPermission(user, 'security.payloads')) return { key, version, skipped: 'Angriffs-Datensatz: Berechtigung security.payloads fehlt' };
  const ds = await loadVersion(found.id);
  return {
    key: ds.key,
    name: ds.name,
    kind: ds.kind,
    language: ds.language,
    sensitivity: ds.sensitivity,
    min_cases: ds.min_cases,
    version: ds.version,
    hash: ds.hash,
    cases: ds.cases.map((c) => ({ key: c.case_key, difficulty: c.difficulty, category: c.category, ...c.data })),
    files: includeFiles ? ds.files.map((f) => ({ name: f.name, base64: f.content.toString('base64') })) : [],
  };
}

export async function templateDoc(user, versionId, { datasets = false } = {}) {
  const v = await one(
    `select v.*, t.key, t.name, t.description, t.type, t.tags, t.use_cases, t.target, t.origin from template_versions v join templates t on t.id = v.template_id where v.id = $1`,
    [versionId],
  );
  if (!v) return null;
  const categories = await many(`select c.framework, c.key from template_version_categories tc join categories c on c.id = tc.category_id where tc.version_id = $1 order by 1, 2`, [versionId]);
  const doc = {
    schema: SCHEMA,
    kind: 'template',
    template: { key: v.key, name: v.name, description: v.description, type: v.type, tags: v.tags, use_cases: v.use_cases, target: v.target, categories },
    version: v.version,
    changelog: v.changelog,
    hash: v.hash,
    spec: v.spec,
  };
  if (datasets && v.spec?.dataset) {
    const d = await datasetDoc(user, v.spec.dataset.key, v.spec.dataset.version);
    if (d) doc.datasets = [d];
  }
  return doc;
}

export const serialize = (doc, format) => (format === 'json' ? JSON.stringify(doc, null, 2) : YAML.stringify(doc, { lineWidth: 0 }));

export function parseDocument(content, format) {
  let doc;
  try {
    doc = format === 'json' || /^\s*[{[]/.test(content) ? JSON.parse(content) : YAML.parse(content);
  } catch (e) {
    throw bad(`Datei nicht lesbar: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object') throw bad('Leeres oder ungültiges Dokument');
  if (doc.schema !== SCHEMA) throw bad(`Unbekanntes Schema „${doc.schema ?? 'fehlt'}“ (erwartet ${SCHEMA})`);
  if (doc.kind !== 'template') throw bad('kind muss template sein (Pakete gibt es seit 0.5.0 nicht mehr)');
  if (doc.version && !isSemver(doc.version)) throw bad(`Ungültige Version „${doc.version}“`);
  return doc;
}
