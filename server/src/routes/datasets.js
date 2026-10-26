// Datensätze: eigenständige, versionierte Objekte (Fälle, Dokumente, Bilder) mit Hash, Sprache und Sensitivität.
import { requirePermission } from '../auth.js';
import { logAudit } from '../audit.js';
import { hasPermission } from '../permissions.js';
import { many, one, tx } from '../db.js';
import { createVersion, fileInfo, KINDS, loadVersion, normalizeCases, parseCsv, parseJsonl, SENSITIVITIES } from '../datasets.js';
import { compare } from '../semver.js';

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const BIG = { bodyLimit: 48 * 1024 * 1024 };

// Angriffs-Payloads sind nur mit eigener Berechtigung sichtbar (Datensatz-Sensitivität "attack").
const mayReveal = (user, sensitivity) => sensitivity !== 'attack' || hasPermission(user, 'security.payloads');

// Rohzeilen aus dem Body: cases (Liste), csv, jsonl.
function rowsOf(b) {
  if (Array.isArray(b.cases)) return b.cases;
  if (typeof b.csv === 'string') return parseCsv(b.csv);
  if (typeof b.jsonl === 'string') return parseJsonl(b.jsonl);
  throw bad('Fälle fehlen (cases, csv oder jsonl)');
}

function prepare(kind, b) {
  const files = (b.files ?? []).map((f) => fileInfo(f.name, f.base64));
  const { cases, errors } = normalizeCases(kind, rowsOf(b), { fileNames: new Set(files.map((f) => f.name)) });
  return { files, cases, errors };
}

export default async function datasetRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const editor = { preHandler: requirePermission('tests.manage') };

  async function load(request) {
    const d = await one('select * from datasets where id = $1 and (tenant_id = $2 or tenant_id is null)', [request.params.id, request.user.tenant_id]);
    if (!d) throw bad('Datensatz nicht gefunden', 404);
    return d;
  }

  function assertMayWrite(user, d) {
    if (d.origin === 'official') throw bad('Offizielle Datensätze sind schreibgeschützt und kommen mit dem Release', 403);
    if (d.sensitivity === 'attack' && !hasPermission(user, 'security.payloads')) throw bad('Angriffs-Datensätze brauchen die Berechtigung security.payloads', 403);
  }

  app.get('/api/dataset-kinds', viewer, async () => Object.entries(KINDS).map(([key, v]) => ({ key, label: v.label, required: v.required, types: v.types })));

  app.get('/api/datasets', viewer, async (request) => {
    const rows = await many(
      `select d.*, v.version as latest_version, v.case_count, v.file_count, v.hash, v.created_at as version_created_at,
         (select count(*)::int from dataset_versions x where x.dataset_id = d.id) as versions,
         (select count(*)::int from template_versions tv join templates t on t.id = tv.template_id
          where tv.spec->'dataset'->>'key' = d.key and (t.tenant_id is null or t.tenant_id = $1)) as template_versions
       from datasets d
       join lateral (select * from dataset_versions where dataset_id = d.id order by string_to_array(version, '.')::int[] desc limit 1) v on true
       where d.tenant_id = $1 or d.tenant_id is null order by d.origin desc, d.name`,
      [request.user.tenant_id],
    );
    return rows.map((d) => ({ ...d, sufficient: d.case_count >= d.min_cases, official: d.origin === 'official' }));
  });

  app.get('/api/datasets/:id', viewer, async (request) => {
    const d = await load(request);
    const versions = await many('select id, version, hash, case_count, file_count, notes, created_at, created_by from dataset_versions where dataset_id = $1', [d.id]);
    versions.sort((a, b) => compare(b.version, a.version));
    return { ...d, official: d.origin === 'official', versions };
  });

  app.get('/api/datasets/:id/versions/:version', viewer, async (request) => {
    const d = await load(request);
    const v = await one('select id from dataset_versions where dataset_id = $1 and version = $2', [d.id, request.params.version]);
    if (!v) throw bad('Version nicht gefunden', 404);
    const full = await loadVersion(v.id);
    const reveal = mayReveal(request.user, d.sensitivity);
    return {
      ...d,
      version: full.version,
      hash: full.hash,
      notes: full.notes,
      created_at: full.created_at,
      hidden: !reveal,
      sufficient: full.cases.length >= d.min_cases,
      cases: full.cases.map((c) => (reveal ? c : { position: c.position, case_key: c.case_key, difficulty: c.difficulty, category: c.category, data: null })),
      files: full.files.map(({ content, ...f }) => f),
    };
  });

  app.get('/api/datasets/:id/versions/:version/files/:name', viewer, async (request, reply) => {
    const d = await load(request);
    if (!mayReveal(request.user, d.sensitivity)) throw bad('Berechtigung security.payloads erforderlich', 403);
    const f = await one(
      `select f.* from dataset_files f join dataset_versions v on v.id = f.version_id where v.dataset_id = $1 and v.version = $2 and f.name = $3`,
      [d.id, request.params.version, request.params.name],
    );
    if (!f) throw bad('Datei nicht gefunden', 404);
    return reply.type(f.content_type).header('content-disposition', `inline; filename="${f.name}"`).send(f.content);
  });

  // Trockenlauf: parsen und prüfen, ohne zu speichern.
  app.post('/api/datasets/validate', { ...editor, ...BIG }, async (request) => {
    const b = request.body ?? {};
    if (!KINDS[b.kind]) throw bad('Datensatzart fehlt oder ist unbekannt');
    const { files, cases, errors } = prepare(b.kind, b);
    return { ok: errors.length === 0, cases: cases.length, files: files.length, errors: errors.slice(0, 50), preview: cases.slice(0, 5).map((c) => ({ key: c.case_key, difficulty: c.difficulty, category: c.category })) };
  });

  async function save(request, existing) {
    const b = request.body ?? {};
    const kind = existing?.kind ?? b.kind;
    if (!KINDS[kind]) throw bad('Datensatzart fehlt oder ist unbekannt');
    const sensitivity = existing?.sensitivity ?? b.sensitivity ?? 'internal';
    if (!SENSITIVITIES.includes(sensitivity)) throw bad('Ungültige Sensitivität');
    if (sensitivity === 'attack' && !hasPermission(request.user, 'security.payloads')) throw bad('Angriffs-Datensätze brauchen die Berechtigung security.payloads', 403);
    if (!existing && !b.name?.trim()) throw bad('Name fehlt');
    const { files, cases, errors } = prepare(kind, b);
    if (errors.length) throw bad(`Schema-Prüfung fehlgeschlagen: ${errors.slice(0, 5).map((e) => `Zeile ${e.row}: ${e.message}`).join('; ')}${errors.length > 5 ? ` (und ${errors.length - 5} weitere)` : ''}`);
    const tenantId = request.user.tenant_id;
    const result = await tx(async (c) => {
      let dataset = existing;
      if (!dataset) {
        const key = (b.key ?? b.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
        dataset = (
          await c.query(
            `insert into datasets (tenant_id, key, name, description, kind, language, sensitivity, origin, min_cases, created_by)
             values ($1, $2, $3, $4, $5, $6, $7, 'tenant', $8, $9) returning *`,
            [tenantId, key, b.name.trim(), b.description ?? null, kind, (b.language ?? 'de').slice(0, 8), sensitivity, Math.max(1, Number(b.min_cases) || 30), request.user.id],
          )
        ).rows[0];
      }
      const version = await createVersion(c, dataset.id, { version: b.version, bumpKind: b.bump, cases, files, notes: b.notes, userId: request.user.id });
      return { dataset, version };
    });
    await logAudit(request, existing ? 'dataset.version' : 'dataset.create', 'dataset', result.dataset.id, { version: result.version.version, hash: result.version.hash });
    return { ...result.dataset, latest_version: result.version.version, hash: result.version.hash, case_count: result.version.case_count };
  }

  app.post('/api/datasets', { ...editor, ...BIG }, async (request) => save(request, null));

  app.post('/api/datasets/:id/versions', { ...editor, ...BIG }, async (request) => {
    const d = await load(request);
    assertMayWrite(request.user, d);
    return save(request, d);
  });

  app.put('/api/datasets/:id', editor, async (request) => {
    const d = await load(request);
    assertMayWrite(request.user, d);
    const b = request.body ?? {};
    const sensitivity = b.sensitivity ?? d.sensitivity;
    if (!SENSITIVITIES.includes(sensitivity)) throw bad('Ungültige Sensitivität');
    // Die Sensitivität darf nur angehoben werden (Angriff ist die höchste Stufe, öffentlich die niedrigste).
    if (SENSITIVITIES.indexOf(sensitivity) < SENSITIVITIES.indexOf(d.sensitivity) && !request.user.is_admin) throw bad('Die Sensitivität darf nur ein Administrator absenken', 403);
    await one(
      `update datasets set name = $2, description = $3, language = $4, sensitivity = $5, min_cases = $6, updated_at = now() where id = $1 returning id`,
      [d.id, b.name?.trim() || d.name, b.description ?? d.description, (b.language ?? d.language).slice(0, 8), sensitivity, Math.max(1, Number(b.min_cases) || d.min_cases)],
    );
    await logAudit(request, 'dataset.update', 'dataset', d.id, { sensitivity });
    return one('select * from datasets where id = $1', [d.id]);
  });

  app.delete('/api/datasets/:id', editor, async (request) => {
    const d = await load(request);
    assertMayWrite(request.user, d);
    const used = await one(`select count(*)::int as n from template_versions where spec->'dataset'->>'key' = $1`, [d.key]);
    if (used.n) throw bad('Der Datensatz wird von Vorlagen verwendet und kann nicht gelöscht werden');
    await one('delete from datasets where id = $1 returning id', [d.id]);
    await logAudit(request, 'dataset.delete', 'dataset', d.id, { name: d.name });
    return { ok: true };
  });
}
