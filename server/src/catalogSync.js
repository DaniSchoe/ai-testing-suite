// Offizielle Inhalte (Kategorien, Datensätze, Vorlagen) mit dem Release in die Datenbank übernehmen.
// Läuft nach den Migrationen und ist idempotent: nur geänderte Inhalte erzeugen eine neue Version; Prüfungen bleiben auf ihrer Version.
import { createHash } from 'node:crypto';
import { CATEGORIES } from '../catalog/categories.js';
import { DATASETS } from '../catalog/datasets.js';
import { TEMPLATES } from '../catalog/templates.js';
import { contentHash, createVersion, fileInfo, normalizeCases } from './datasets.js';
import { bump, compare } from './semver.js';

const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const top = (rows) => rows.map((r) => r.version).sort(compare).at(-1);

async function syncCategories(db) {
  for (const c of CATEGORIES) {
    await db.query(
      `insert into categories (tenant_id, framework, key, name, builtin) values (null, $1, $2, $3, true)
       on conflict (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), framework, key) do update set name = excluded.name, builtin = true`,
      [c.framework, c.key, c.name],
    );
  }
}

async function syncDatasets(db) {
  const latest = new Map();
  for (const def of DATASETS) {
    const existing = (await db.query('select id from datasets where tenant_id is null and key = $1', [def.key])).rows[0];
    const dataset =
      existing ??
      (
        await db.query(
          `insert into datasets (tenant_id, key, name, description, kind, language, sensitivity, origin, min_cases)
           values (null, $1, $2, $3, $4, 'de', $5, 'official', $6) returning id`,
          [def.key, def.name, def.description, def.kind, def.sensitivity, def.min_cases ?? 30],
        )
      ).rows[0];
    await db.query('update datasets set name = $2, description = $3, sensitivity = $4 where id = $1', [dataset.id, def.name, def.description, def.sensitivity]);
    const files = def.files ? (await def.files()).map((f) => fileInfo(f.name, f.content.toString('base64'))) : [];
    const { cases, errors } = normalizeCases(def.kind, def.rows(), { fileNames: new Set(files.map((f) => f.name)) });
    if (errors.length) throw new Error(`Offizieller Datensatz ${def.key}: ${errors.map((e) => `Zeile ${e.row}: ${e.message}`).join('; ')}`);
    const hash = contentHash(cases, files);
    const versions = (await db.query('select version, hash from dataset_versions where dataset_id = $1', [dataset.id])).rows;
    const current = versions.find((v) => v.hash === hash);
    if (current) latest.set(def.key, current.version);
    else {
      const v = await createVersion(db, dataset.id, { bumpKind: 'minor', cases, files, notes: 'Release', version: versions.length ? bump(top(versions), 'minor') : def.version });
      latest.set(def.key, v.version);
    }
  }
  return latest;
}

async function syncTemplates(db, datasetVersions) {
  // Vor Migration 017 (Alt-Migration 014 gleicht den Katalog schon ab) gibt es die Spalte target noch nicht.
  const hasTarget = (await db.query("select 1 from information_schema.columns where table_name = 'templates' and column_name = 'target'")).rowCount > 0;
  const latest = new Map();
  for (const def of TEMPLATES) {
    const spec = structuredClone(def.spec);
    if (spec.dataset) spec.dataset = { key: spec.dataset.key, version: datasetVersions.get(spec.dataset.key) };
    const categories = def.categories.map((c) => `${c.framework}/${c.key}`).sort();
    const hash = sha({ type: def.type, spec, categories });
    let template = (await db.query('select id from templates where tenant_id is null and key = $1', [def.key])).rows[0];
    if (template) {
      await db.query('update templates set name = $2, description = $3, use_cases = $4, updated_at = now() where id = $1', [template.id, def.name, def.description, def.use_cases ?? []]);
      if (hasTarget) await db.query('update templates set target = $2 where id = $1', [template.id, def.target ?? 'llm']);
    } else {
      template = (
        await db.query(
          `insert into templates (key, tenant_id, origin, name, description, type, use_cases) values ($1, null, 'official', $2, $3, $4, $5) returning id`,
          [def.key, def.name, def.description, def.type, def.use_cases ?? []],
        )
      ).rows[0];
      if (hasTarget) await db.query('update templates set target = $2 where id = $1', [template.id, def.target ?? 'llm']);
    }
    const versions = (await db.query('select id, version, hash from template_versions where template_id = $1', [template.id])).rows;
    const same = versions.find((v) => v.hash === hash);
    if (same) {
      latest.set(def.key, { id: same.id, version: same.version });
      continue;
    }
    const version = versions.length ? bump(top(versions), 'minor') : '1.0.0';
    const v = (
      await db.query(
        `insert into template_versions (template_id, version, status, spec, changelog, hash, published_at)
         values ($1, $2, 'published', $3, $4, $5, now()) returning id`,
        [template.id, version, JSON.stringify(spec), versions.length ? 'Aktualisierung mit dem Release' : 'Erstveröffentlichung', hash],
      )
    ).rows[0];
    await db.query(`update template_versions set status = 'deprecated' where template_id = $1 and id <> $2 and status = 'published'`, [template.id, v.id]);
    await db.query(
      `insert into template_version_categories (version_id, category_id)
       select $1, c.id from categories c join jsonb_to_recordset($2::jsonb) as x(framework text, key text) on x.framework = c.framework and x.key = c.key
       where c.tenant_id is null`,
      [v.id, JSON.stringify(def.categories)],
    );
    latest.set(def.key, { id: v.id, version });
  }
  return latest;
}

export async function syncOfficialCatalog(db) {
  await syncCategories(db);
  const datasets = await syncDatasets(db);
  await syncTemplates(db, datasets);
}
