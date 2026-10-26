// Testkatalog: Kategorien, Vorlagen und Prüfpakete mit Versionen, Freigabeprozess, Nutzungsstatistik, Testläufen und Import/Export.
import { logAudit } from '../audit.js';
import { hasPermission, requirePermission } from '../auth.js';
import { many, one, query, tx } from '../db.js';
import { bad, canEditTemplate, canSeeTemplate, parseDocument, packDoc, serialize, slug, specHash, templateDoc, USE_CASES, validateSpec, validateUseCases } from '../catalog.js';
import { createVersion, fileInfo, KINDS, normalizeCases, SENSITIVITIES } from '../datasets.js';
import { createDraftRun } from '../runs.js';
import { bump, compare, isSemver } from '../semver.js';

const byVersionDesc = (a, b) => compare(b.version, a.version);

export default async function catalogRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const editor = { preHandler: requirePermission('tests.manage') };
  const publisher = { preHandler: requirePermission('catalog.publish') };
  const starter = { preHandler: requirePermission('runs.start') };

  // ------------------------------------------------------------------ Kategorien
  app.get('/api/catalog/categories', viewer, async (request) =>
    many('select * from categories where tenant_id = $1 or tenant_id is null order by framework, key', [request.user.tenant_id]),
  );

  const categoryAdmin = async (request) => {
    if (!request.user.is_admin && !hasPermission(request.user, 'catalog.publish')) throw bad('Nur Administratoren oder Reviewer pflegen Kategorien', 403);
  };

  app.post('/api/catalog/categories', { preHandler: [requirePermission('suite.view'), categoryAdmin] }, async (request) => {
    const b = request.body ?? {};
    if (!b.framework?.trim() || !b.key?.trim() || !b.name?.trim()) throw bad('Rahmenwerk, Schlüssel und Name sind Pflicht');
    const row = await one(
      `insert into categories (tenant_id, framework, key, name, description) values ($1, $2, $3, $4, $5) returning *`,
      [request.user.tenant_id, b.framework.trim(), b.key.trim(), b.name.trim(), b.description ?? null],
    );
    await logAudit(request, 'category.create', 'category', row.id, { framework: row.framework, key: row.key });
    return row;
  });

  app.put('/api/catalog/categories/:id', { preHandler: [requirePermission('suite.view'), categoryAdmin] }, async (request) => {
    const b = request.body ?? {};
    const row = await one(
      `update categories set name = coalesce($3, name), description = coalesce($4, description) where id = $1 and tenant_id = $2 and not builtin returning *`,
      [request.params.id, request.user.tenant_id, b.name?.trim() || null, b.description ?? null],
    );
    if (!row) throw bad('Kategorie nicht gefunden oder schreibgeschützt', 404);
    return row;
  });

  app.delete('/api/catalog/categories/:id', { preHandler: [requirePermission('suite.view'), categoryAdmin] }, async (request) => {
    const used = await one('select count(*)::int as n from template_version_categories where category_id = $1', [request.params.id]);
    if (used.n) throw bad('Die Kategorie wird von Vorlagen verwendet', 409);
    const row = await one('delete from categories where id = $1 and tenant_id = $2 and not builtin returning id', [request.params.id, request.user.tenant_id]);
    if (!row) throw bad('Kategorie nicht gefunden oder schreibgeschützt', 404);
    return { ok: true };
  });

  async function resolveCategories(user, ids = []) {
    if (!Array.isArray(ids)) throw bad('Kategorien müssen eine Liste sein');
    if (!ids.length) return [];
    const rows = await many('select id from categories where id = any($1::uuid[]) and (tenant_id = $2 or tenant_id is null)', [ids, user.tenant_id]);
    if (rows.length !== new Set(ids).size) throw bad('Unbekannte Kategorie');
    return rows.map((r) => r.id);
  }

  async function categoryKeys(ids) {
    return ids.length ? (await many('select framework, key from categories where id = any($1::uuid[])', [ids])).map((c) => `${c.framework}/${c.key}`) : [];
  }

  // ------------------------------------------------------------------ Vorlagen
  // Entwürfe und Versionen im Review sehen nur Besitzer, Administratoren und Reviewer.
  const seesDrafts = (user, t) => user.is_admin || hasPermission(user, 'catalog.publish') || t.owner_id === user.id;
  const visibleVersions = (user, t, versions) => (seesDrafts(user, t) ? versions : versions.filter((v) => ['published', 'deprecated'].includes(v.status)));

  async function usage(tenantId) {
    const rows = await many(
      `select res.template_key as key, count(distinct r.id)::int as runs, count(*)::int as results, count(distinct r.audit_id)::int as audits,
         max(res.finished_at) as last_used, avg(case when res.status = 'passed' then 1.0 when res.status = 'failed' then 0.0 end)::float as pass_rate
       from results res join runs r on r.id = res.run_id
       where r.tenant_id = $1 and not r.is_draft and res.template_key is not null and res.status in ('passed', 'failed') group by res.template_key`,
      [tenantId],
    );
    return new Map(rows.map((r) => [r.key, r]));
  }

  app.get('/api/catalog/templates', viewer, async (request) => {
    const user = request.user;
    const q = request.query;
    const [templates, versions, cats, use] = await Promise.all([
      many('select * from templates where tenant_id = $1 or tenant_id is null order by name', [user.tenant_id]),
      many('select id, template_id, version, status, spec, changelog, created_at, published_at, hash from template_versions'),
      many(`select tc.version_id, c.id, c.framework, c.key, c.name from template_version_categories tc join categories c on c.id = tc.category_id`),
      usage(user.tenant_id),
    ]);
    const out = [];
    for (const t of templates) {
      if (!(await canSeeTemplate(user, t))) continue;
      const all = visibleVersions(user, t, versions.filter((v) => v.template_id === t.id)).sort(byVersionDesc);
      if (!all.length) continue;
      const latest = all.find((v) => v.status === 'published') ?? all[0];
      const categories = cats.filter((c) => c.version_id === latest.id).map(({ version_id, ...c }) => c);
      const u = use.get(t.key);
      const row = {
        ...t,
        latest: { id: latest.id, version: latest.version, status: latest.status, requires: latest.spec.requires ?? [], load: Boolean(latest.spec.load), dataset: latest.spec.dataset },
        versions: all.map((v) => ({ id: v.id, version: v.version, status: v.status, published_at: v.published_at })),
        categories,
        usage: u ?? { runs: 0, results: 0, audits: 0, last_used: null, pass_rate: null },
        can_edit: canEditTemplate(user, t),
      };
      if (q.type && row.type !== q.type) continue;
      if (q.origin && row.origin !== q.origin) continue;
      if (q.use_case && !row.use_cases.includes(q.use_case)) continue;
      if (q.category && !categories.some((c) => c.id === q.category || `${c.framework}/${c.key}` === q.category)) continue;
      if (q.status && !all.some((v) => v.status === q.status)) continue;
      if (q.requires && !(row.latest.requires ?? []).includes(q.requires)) continue;
      if (q.q && !`${t.name} ${t.description ?? ''} ${t.key} ${t.tags.join(' ')}`.toLowerCase().includes(String(q.q).toLowerCase())) continue;
      out.push(row);
    }
    return out;
  });

  async function loadTemplate(request, id = request.params.id) {
    const t = await one('select * from templates where id = $1', [id]);
    if (!t || !(await canSeeTemplate(request.user, t))) throw bad('Vorlage nicht gefunden', 404);
    return t;
  }

  app.get('/api/catalog/templates/:id', viewer, async (request) => {
    const user = request.user;
    const t = await loadTemplate(request);
    const versions = visibleVersions(user, t, await many('select * from template_versions where template_id = $1', [t.id])).sort(byVersionDesc);
    const cats = await many(
      `select tc.version_id, c.id, c.framework, c.key, c.name from template_version_categories tc join categories c on c.id = tc.category_id where tc.version_id = any($1::uuid[])`,
      [versions.map((v) => v.id)],
    );
    const names = await many('select id, coalesce(display_name, username) as name from users where id = any($1::uuid[])', [[...new Set(versions.flatMap((v) => [v.created_by, v.submitted_by, v.reviewed_by, v.security_reviewed_by].filter(Boolean)))]]);
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    const u = (await usage(user.tenant_id)).get(t.key) ?? { runs: 0, results: 0, audits: 0, last_used: null, pass_rate: null };
    // Zuletzt gemessen: Kennzahlen je Modell aus Prüfungen des Mandanten (ohne Rohdaten).
    const recent = await many(
      `select res.model_alias as model, res.path, res.template_version as version, res.status, res.score, res.metrics, res.finished_at
       from results res join runs r on r.id = res.run_id
       where r.tenant_id = $1 and not r.is_draft and res.template_key = $2 and res.status in ('passed', 'failed') order by res.finished_at desc limit 8`,
      [user.tenant_id, t.key],
    );
    const usedBy = await many(
      `select distinct a.id, a.name from audits a, jsonb_array_elements(a.items) i
       where a.tenant_id = $1 and (i->>'template_version_id')::uuid = any($2::uuid[]) order by a.name`,
      [user.tenant_id, versions.map((v) => v.id)],
    );
    const owner = t.owner_id ? await one('select coalesce(display_name, username) as name from users where id = $1', [t.owner_id]) : null;
    return {
      ...t,
      owner_name: owner?.name ?? null,
      can_edit: canEditTemplate(user, t),
      usage: u,
      recent_results: recent,
      used_by_audits: usedBy,
      versions: versions.map((v) => ({
        ...v,
        categories: cats.filter((c) => c.version_id === v.id).map(({ version_id, ...c }) => c),
        created_by_name: nameOf.get(v.created_by) ?? null,
        submitted_by_name: nameOf.get(v.submitted_by) ?? null,
        reviewed_by_name: nameOf.get(v.reviewed_by) ?? null,
        security_reviewed_by_name: nameOf.get(v.security_reviewed_by) ?? null,
      })),
    };
  });

  async function prepareVersion(user, type, body, base) {
    const spec = await validateSpec(user, type, body.spec ?? base?.spec);
    const categoryIds = body.category_ids ? await resolveCategories(user, body.category_ids) : base?.category_ids ?? [];
    const hash = specHash(type, spec, await categoryKeys(categoryIds));
    return { spec, categoryIds, hash };
  }

  async function insertVersion(client, templateId, { version, spec, categoryIds, hash, changelog, userId }) {
    const { rows } = await client.query(
      `insert into template_versions (template_id, version, status, spec, changelog, hash, created_by) values ($1, $2, 'draft', $3, $4, $5, $6) returning *`,
      [templateId, version, JSON.stringify(spec), changelog ?? null, hash, userId],
    );
    for (const id of categoryIds) await client.query('insert into template_version_categories values ($1, $2)', [rows[0].id, id]);
    return rows[0];
  }

  app.post('/api/catalog/templates', editor, async (request) => {
    const user = request.user;
    const b = request.body ?? {};
    if (!b.name?.trim()) throw bad('Name fehlt');
    const origin = b.origin ?? 'private';
    if (!['private', 'team'].includes(origin)) throw bad('Herkunft muss private oder team sein (offizielle Vorlagen kommen mit dem Release)');
    if (origin === 'team' && !(user.teams ?? []).some((x) => x.id === b.team_id) && !user.is_admin) throw bad('Team nicht gefunden', 403);
    const { spec, categoryIds, hash } = await prepareVersion(user, b.type, b, null);
    const dsSecurity = spec.dataset ? (await one(`select sensitivity from datasets where key = $1 and (tenant_id = $2 or tenant_id is null) order by tenant_id nulls last limit 1`, [spec.dataset.key, user.tenant_id]))?.sensitivity === 'attack' : false;
    const key = slug(b.key || b.name);
    if (!key) throw bad('Schlüssel ungültig');
    const version = isSemver(b.version) ? b.version : '1.0.0';
    return tx(async (c) => {
      const { rows } = await c.query(
        `insert into templates (key, tenant_id, origin, team_id, owner_id, name, description, type, tags, use_cases, security)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
        [key, user.tenant_id, origin, origin === 'team' ? b.team_id : null, user.id, b.name.trim(), b.description ?? null, b.type, (b.tags ?? []).map(String), validateUseCases(b.use_cases), Boolean(b.security) || dsSecurity],
      );
      const v = await insertVersion(c, rows[0].id, { version, spec, categoryIds, hash, changelog: b.changelog, userId: user.id });
      await logAudit(request, 'template.create', 'template', rows[0].id, { key, version });
      return { ...rows[0], version: v };
    });
  });

  app.put('/api/catalog/templates/:id', editor, async (request) => {
    const t = await loadTemplate(request);
    if (!canEditTemplate(request.user, t)) throw bad('Nur Besitzer oder Administratoren dürfen die Vorlage ändern (offizielle Vorlagen sind schreibgeschützt)', 403);
    const b = request.body ?? {};
    const origin = b.origin ?? t.origin;
    if (!['private', 'team'].includes(origin)) throw bad('Herkunft muss private oder team sein');
    if (origin === 'team' && !(request.user.teams ?? []).some((x) => x.id === (b.team_id ?? t.team_id)) && !request.user.is_admin) throw bad('Team nicht gefunden', 403);
    return one(
      `update templates set name = $2, description = $3, tags = $4, use_cases = $5, origin = $6, team_id = $7, updated_at = now() where id = $1 returning *`,
      [t.id, b.name?.trim() || t.name, b.description ?? t.description, b.tags ?? t.tags, b.use_cases ? validateUseCases(b.use_cases) : t.use_cases, origin, origin === 'team' ? (b.team_id ?? t.team_id) : null],
    );
  });

  app.delete('/api/catalog/templates/:id', editor, async (request) => {
    const t = await loadTemplate(request);
    if (!canEditTemplate(request.user, t)) throw bad('Keine Berechtigung', 403);
    const used = await one(
      `select count(*)::int as n from audits a, jsonb_array_elements(a.items) i
       where (i->>'template_version_id')::uuid in (select id from template_versions where template_id = $1)`,
      [t.id],
    );
    if (used.n) throw bad('Die Vorlage wird von Prüfungen verwendet', 409);
    await query('delete from templates where id = $1', [t.id]);
    await logAudit(request, 'template.delete', 'template', t.id, { key: t.key });
    return { ok: true };
  });

  // Neue Version (Entwurf) auf Basis der neuesten Version.
  app.post('/api/catalog/templates/:id/versions', editor, async (request) => {
    const t = await loadTemplate(request);
    if (!canEditTemplate(request.user, t)) throw bad('Keine Berechtigung (offizielle Vorlagen sind schreibgeschützt)', 403);
    const b = request.body ?? {};
    const versions = await many('select * from template_versions where template_id = $1', [t.id]);
    const top = versions.map((v) => v.version).sort(compare).at(-1);
    const baseRow = versions.sort(byVersionDesc)[0];
    const baseCats = baseRow ? (await many('select category_id from template_version_categories where version_id = $1', [baseRow.id])).map((c) => c.category_id) : [];
    const next = isSemver(b.version) ? b.version : bump(top ?? '1.0.0', ['major', 'minor', 'patch'].includes(b.bump) ? b.bump : 'minor');
    if (versions.some((v) => v.version === next)) throw bad(`Version ${next} existiert bereits`, 409);
    if (versions.some((v) => v.status === 'draft' || v.status === 'review')) throw bad('Es gibt bereits einen offenen Entwurf; bitte diesen bearbeiten oder verwerfen', 409);
    const prepared = await prepareVersion(request.user, t.type, b, { spec: baseRow?.spec, category_ids: baseCats });
    return tx(async (c) => {
      const v = await insertVersion(c, t.id, { version: next, ...prepared, changelog: b.changelog, userId: request.user.id });
      await logAudit(request, 'template.version_create', 'template', t.id, { version: next });
      return v;
    });
  });

  async function loadVersionOf(request, { statuses } = {}) {
    const t = await loadTemplate(request);
    const v = await one('select * from template_versions where template_id = $1 and version = $2', [t.id, request.params.version]);
    if (!v || !visibleVersions(request.user, t, [v]).length) throw bad('Version nicht gefunden', 404);
    if (statuses && !statuses.includes(v.status)) throw bad(`Die Version hat den Status „${v.status}“`, 409);
    return { t, v };
  }

  app.put('/api/catalog/templates/:id/versions/:version', editor, async (request) => {
    const { t, v } = await loadVersionOf(request, { statuses: ['draft'] });
    if (!canEditTemplate(request.user, t)) throw bad('Keine Berechtigung', 403);
    const b = request.body ?? {};
    const baseCats = (await many('select category_id from template_version_categories where version_id = $1', [v.id])).map((c) => c.category_id);
    const { spec, categoryIds, hash } = await prepareVersion(request.user, t.type, b, { spec: v.spec, category_ids: baseCats });
    await tx(async (c) => {
      await c.query('update template_versions set spec = $2, changelog = $3, hash = $4, review_note = null where id = $1', [v.id, JSON.stringify(spec), b.changelog ?? v.changelog, hash]);
      await c.query('delete from template_version_categories where version_id = $1', [v.id]);
      for (const id of categoryIds) await c.query('insert into template_version_categories values ($1, $2)', [v.id, id]);
    });
    return one('select * from template_versions where id = $1', [v.id]);
  });

  app.delete('/api/catalog/templates/:id/versions/:version', editor, async (request) => {
    const { t, v } = await loadVersionOf(request, { statuses: ['draft', 'review'] });
    if (!canEditTemplate(request.user, t)) throw bad('Keine Berechtigung', 403);
    await query('delete from template_versions where id = $1', [v.id]);
    return { ok: true };
  });

  app.post('/api/catalog/templates/:id/versions/:version/submit', editor, async (request) => {
    const { t, v } = await loadVersionOf(request, { statuses: ['draft'] });
    if (!canEditTemplate(request.user, t)) throw bad('Keine Berechtigung', 403);
    await validateSpec(request.user, t.type, v.spec);
    await query(`update template_versions set status = 'review', submitted_by = $2, submitted_at = now(), review_note = null, reviewed_by = null, reviewed_at = null, security_reviewed_by = null, security_reviewed_at = null where id = $1`, [v.id, request.user.id]);
    await logAudit(request, 'template.submit', 'template', t.id, { version: v.version });
    return one('select * from template_versions where id = $1', [v.id]);
  });

  // Freigabe nach dem Vier-Augen-Prinzip. Security-Vorlagen durchlaufen eine zweite Stufe mit security.payloads.
  app.post('/api/catalog/templates/:id/versions/:version/approve', publisher, async (request) => {
    const { t, v } = await loadVersionOf(request, { statuses: ['review'] });
    const user = request.user;
    if (t.origin === 'official') throw bad('Offizielle Vorlagen kommen mit dem Release', 403);
    if (v.submitted_by === user.id) throw bad('Vier-Augen-Prinzip: Eingereichtes kann nicht selbst freigegeben werden', 403);
    if (t.security && !v.reviewed_by) {
      await query('update template_versions set reviewed_by = $2, reviewed_at = now(), review_note = $3 where id = $1', [v.id, user.id, request.body?.note ?? null]);
      await logAudit(request, 'template.review_stage1', 'template', t.id, { version: v.version });
      return { ...(await one('select * from template_versions where id = $1', [v.id])), awaiting: 'security' };
    }
    if (t.security) {
      if (!hasPermission(user, 'security.payloads')) throw bad('Die Sicherheitsfreigabe braucht die Berechtigung security.payloads', 403);
      if (v.reviewed_by === user.id) throw bad('Die Sicherheitsfreigabe muss eine andere Person erteilen als die fachliche Prüfung', 403);
      await query('update template_versions set security_reviewed_by = $2, security_reviewed_at = now() where id = $1', [v.id, user.id]);
    } else {
      await query('update template_versions set reviewed_by = $2, reviewed_at = now(), review_note = $3 where id = $1', [v.id, user.id, request.body?.note ?? null]);
    }
    await query(`update template_versions set status = 'published', published_at = now() where id = $1`, [v.id]);
    await logAudit(request, 'template.publish', 'template', t.id, { version: v.version });
    return one('select * from template_versions where id = $1', [v.id]);
  });

  app.post('/api/catalog/templates/:id/versions/:version/reject', publisher, async (request) => {
    const { t, v } = await loadVersionOf(request, { statuses: ['review'] });
    if (!request.body?.note?.trim()) throw bad('Bitte eine Begründung angeben');
    await query(`update template_versions set status = 'draft', review_note = $2, reviewed_by = $3, reviewed_at = now(), security_reviewed_by = null where id = $1`, [v.id, request.body.note.slice(0, 1000), request.user.id]);
    await logAudit(request, 'template.reject', 'template', t.id, { version: v.version });
    return one('select * from template_versions where id = $1', [v.id]);
  });

  app.post('/api/catalog/templates/:id/versions/:version/deprecate', editor, async (request) => {
    const { t, v } = await loadVersionOf(request, { statuses: ['published'] });
    if (t.origin === 'official') throw bad('Offizielle Vorlagen kommen mit dem Release', 403);
    if (!canEditTemplate(request.user, t) && !hasPermission(request.user, 'catalog.publish')) throw bad('Keine Berechtigung', 403);
    await query(`update template_versions set status = 'deprecated' where id = $1`, [v.id]);
    await logAudit(request, 'template.deprecate', 'template', t.id, { version: v.version });
    return { ok: true };
  });

  // Testlauf (auch für Entwürfe): zählt nicht in Historie und Dashboard.
  app.post('/api/catalog/templates/:id/versions/:version/test-run', { preHandler: [requirePermission('runs.start'), requirePermission('tests.manage')] }, async (request) => {
    const { v } = await loadVersionOf(request);
    const b = request.body ?? {};
    return createDraftRun({ user: request.user, templateVersionId: v.id, platformId: b.platform_id, models: b.models, thresholds: b.thresholds ?? [], repeats: b.repeats ?? 1 });
  });

  // ------------------------------------------------------------------ Pakete
  async function itemsOf(user, raw) {
    if (!Array.isArray(raw) || !raw.length) throw bad('Ein Paket braucht mindestens eine Vorlage');
    const out = [];
    for (const r of raw) {
      let row;
      if (r.template_version_id) row = await one('select v.id, v.version, v.status, t.key, t.name, t.tenant_id, t.origin, t.team_id, t.owner_id from template_versions v join templates t on t.id = v.template_id where v.id = $1', [r.template_version_id]);
      else if (r.template_key) {
        row = await one(
          `select v.id, v.version, v.status, t.key, t.name, t.tenant_id, t.origin, t.team_id, t.owner_id from template_versions v join templates t on t.id = v.template_id
           where t.key = $1 and (t.tenant_id = $2 or t.tenant_id is null) and ($3::text is null or v.version = $3) and v.status = 'published'
           order by (t.tenant_id is not null) desc, string_to_array(v.version, '.')::int[] desc limit 1`,
          [r.template_key, user.tenant_id, r.version ?? null],
        );
      }
      if (!row || !(await canSeeTemplate(user, row))) throw bad(`Vorlage nicht gefunden: ${r.template_key ?? r.template_version_id}`, 404);
      out.push({ template_key: row.key, template_version_id: row.id, version: row.version });
    }
    return out;
  }

  app.get('/api/catalog/packs', viewer, async (request) => {
    const user = request.user;
    const [packs, versions] = await Promise.all([many('select * from packs where tenant_id = $1 or tenant_id is null order by name', [user.tenant_id]), many('select id, pack_id, version, status, items, published_at from pack_versions')]);
    const out = [];
    for (const p of packs) {
      if (!(await canSeeTemplate(user, p))) continue;
      const all = visibleVersions(user, p, versions.filter((v) => v.pack_id === p.id)).sort(byVersionDesc);
      if (!all.length) continue;
      const latest = all.find((v) => v.status === 'published') ?? all[0];
      out.push({ ...p, latest: { id: latest.id, version: latest.version, status: latest.status, items: latest.items }, versions: all.map((v) => ({ id: v.id, version: v.version, status: v.status })), can_edit: canEditTemplate(user, p) });
    }
    return out;
  });

  async function loadPack(request) {
    const p = await one('select * from packs where id = $1', [request.params.id]);
    if (!p || !(await canSeeTemplate(request.user, p))) throw bad('Paket nicht gefunden', 404);
    return p;
  }

  app.get('/api/catalog/packs/:id', viewer, async (request) => {
    const p = await loadPack(request);
    const versions = visibleVersions(request.user, p, await many('select * from pack_versions where pack_id = $1', [p.id])).sort(byVersionDesc);
    return { ...p, can_edit: canEditTemplate(request.user, p), versions };
  });

  app.post('/api/catalog/packs', editor, async (request) => {
    const user = request.user;
    const b = request.body ?? {};
    if (!b.name?.trim()) throw bad('Name fehlt');
    const origin = b.origin ?? 'private';
    if (!['private', 'team'].includes(origin)) throw bad('Herkunft muss private oder team sein');
    if (origin === 'team' && !(user.teams ?? []).some((x) => x.id === b.team_id) && !user.is_admin) throw bad('Team nicht gefunden', 403);
    const items = await itemsOf(user, b.items);
    return tx(async (c) => {
      const { rows } = await c.query(
        `insert into packs (key, tenant_id, origin, team_id, owner_id, name, description, framework) values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [slug(b.key || b.name), user.tenant_id, origin, origin === 'team' ? b.team_id : null, user.id, b.name.trim(), b.description ?? null, b.framework ?? null],
      );
      await c.query(`insert into pack_versions (pack_id, version, status, items, changelog, hash, created_by) values ($1, '1.0.0', 'draft', $2, $3, $4, $5)`, [rows[0].id, JSON.stringify(items), b.changelog ?? null, specHash('pack', items, []), user.id]);
      await logAudit(request, 'pack.create', 'pack', rows[0].id, { key: rows[0].key });
      return rows[0];
    });
  });

  app.put('/api/catalog/packs/:id', editor, async (request) => {
    const p = await loadPack(request);
    if (!canEditTemplate(request.user, p)) throw bad('Keine Berechtigung', 403);
    const b = request.body ?? {};
    return one(`update packs set name = $2, description = $3, framework = $4, updated_at = now() where id = $1 returning *`, [p.id, b.name?.trim() || p.name, b.description ?? p.description, b.framework ?? p.framework]);
  });

  app.delete('/api/catalog/packs/:id', editor, async (request) => {
    const p = await loadPack(request);
    if (!canEditTemplate(request.user, p)) throw bad('Keine Berechtigung', 403);
    await query('delete from packs where id = $1', [p.id]);
    return { ok: true };
  });

  app.post('/api/catalog/packs/:id/versions', editor, async (request) => {
    const p = await loadPack(request);
    if (!canEditTemplate(request.user, p)) throw bad('Keine Berechtigung', 403);
    const b = request.body ?? {};
    const versions = await many('select * from pack_versions where pack_id = $1', [p.id]);
    if (versions.some((v) => ['draft', 'review'].includes(v.status))) throw bad('Es gibt bereits einen offenen Entwurf', 409);
    const top = versions.map((v) => v.version).sort(compare).at(-1);
    const next = isSemver(b.version) ? b.version : bump(top ?? '1.0.0', ['major', 'minor', 'patch'].includes(b.bump) ? b.bump : 'minor');
    const items = await itemsOf(request.user, b.items ?? versions.sort(byVersionDesc)[0]?.items);
    const row = await one(`insert into pack_versions (pack_id, version, status, items, changelog, hash, created_by) values ($1, $2, 'draft', $3, $4, $5, $6) returning *`, [p.id, next, JSON.stringify(items), b.changelog ?? null, specHash('pack', items, []), request.user.id]);
    return row;
  });

  async function packVersion(request, statuses) {
    const p = await loadPack(request);
    const v = await one('select * from pack_versions where pack_id = $1 and version = $2', [p.id, request.params.version]);
    if (!v || !visibleVersions(request.user, p, [v]).length) throw bad('Version nicht gefunden', 404);
    if (statuses && !statuses.includes(v.status)) throw bad(`Die Version hat den Status „${v.status}“`, 409);
    return { p, v };
  }

  app.put('/api/catalog/packs/:id/versions/:version', editor, async (request) => {
    const { p, v } = await packVersion(request, ['draft']);
    if (!canEditTemplate(request.user, p)) throw bad('Keine Berechtigung', 403);
    const items = await itemsOf(request.user, request.body?.items);
    return one('update pack_versions set items = $2, changelog = $3, hash = $4 where id = $1 returning *', [v.id, JSON.stringify(items), request.body?.changelog ?? v.changelog, specHash('pack', items, [])]);
  });

  app.post('/api/catalog/packs/:id/versions/:version/submit', editor, async (request) => {
    const { p, v } = await packVersion(request, ['draft']);
    if (!canEditTemplate(request.user, p)) throw bad('Keine Berechtigung', 403);
    await query(`update pack_versions set status = 'review', submitted_by = $2, submitted_at = now(), review_note = null where id = $1`, [v.id, request.user.id]);
    return one('select * from pack_versions where id = $1', [v.id]);
  });

  app.post('/api/catalog/packs/:id/versions/:version/approve', publisher, async (request) => {
    const { p, v } = await packVersion(request, ['review']);
    if (p.origin === 'official') throw bad('Offizielle Pakete kommen mit dem Release', 403);
    if (v.submitted_by === request.user.id) throw bad('Vier-Augen-Prinzip: Eingereichtes kann nicht selbst freigegeben werden', 403);
    const pending = await one(`select count(*)::int as n from template_versions where id = any($1::uuid[]) and status not in ('published', 'deprecated')`, [v.items.map((i) => i.template_version_id)]);
    if (pending.n) throw bad('Alle Vorlagen des Pakets müssen veröffentlicht sein', 409);
    await query(`update pack_versions set status = 'published', published_at = now(), reviewed_by = $2, reviewed_at = now(), review_note = $3 where id = $1`, [v.id, request.user.id, request.body?.note ?? null]);
    await logAudit(request, 'pack.publish', 'pack', p.id, { version: v.version });
    return one('select * from pack_versions where id = $1', [v.id]);
  });

  app.post('/api/catalog/packs/:id/versions/:version/reject', publisher, async (request) => {
    const { v } = await packVersion(request, ['review']);
    if (!request.body?.note?.trim()) throw bad('Bitte eine Begründung angeben');
    await query(`update pack_versions set status = 'draft', review_note = $2, reviewed_by = $3, reviewed_at = now() where id = $1`, [v.id, request.body.note.slice(0, 1000), request.user.id]);
    return one('select * from pack_versions where id = $1', [v.id]);
  });

  app.post('/api/catalog/packs/:id/versions/:version/deprecate', editor, async (request) => {
    const { p, v } = await packVersion(request, ['published']);
    if (p.origin === 'official') throw bad('Offizielle Pakete kommen mit dem Release', 403);
    if (!canEditTemplate(request.user, p) && !hasPermission(request.user, 'catalog.publish')) throw bad('Keine Berechtigung', 403);
    await query(`update pack_versions set status = 'deprecated' where id = $1`, [v.id]);
    return { ok: true };
  });

  // ------------------------------------------------------------------ Export und Import
  app.get('/api/catalog/templates/:id/versions/:version/export', viewer, async (request, reply) => {
    const { t, v } = await loadVersionOf(request);
    const format = request.query.format === 'json' ? 'json' : 'yaml';
    const doc = await templateDoc(request.user, v.id, { datasets: request.query.datasets === '1' });
    await logAudit(request, 'catalog.export', 'template', t.id, { version: v.version });
    reply.header('content-type', format === 'json' ? 'application/json' : 'application/yaml').header('content-disposition', `attachment; filename="${t.key}-${v.version}.${format === 'json' ? 'json' : 'yaml'}"`);
    return serialize(doc, format);
  });

  app.get('/api/catalog/packs/:id/versions/:version/export', viewer, async (request, reply) => {
    const { p, v } = await packVersion(request);
    const format = request.query.format === 'json' ? 'json' : 'yaml';
    const doc = await packDoc(request.user, v.id, { datasets: request.query.datasets === '1' });
    await logAudit(request, 'catalog.export', 'pack', p.id, { version: v.version });
    reply.header('content-type', format === 'json' ? 'application/json' : 'application/yaml').header('content-disposition', `attachment; filename="${p.key}-${v.version}.${format === 'json' ? 'json' : 'yaml'}"`);
    return serialize(doc, format);
  });

  async function importDatasets(c, user, docs = [], summary) {
    const mapped = new Map();
    for (const d of docs) {
      if (d.skipped) {
        summary.warnings.push(`Datensatz ${d.key}: ${d.skipped}`);
        continue;
      }
      if (!KINDS[d.kind]) throw bad(`Datensatz ${d.key}: unbekannte Art „${d.kind}“`);
      const sensitivity = SENSITIVITIES.includes(d.sensitivity) ? d.sensitivity : 'internal';
      if (sensitivity === 'attack' && !hasPermission(user, 'security.payloads')) throw bad(`Datensatz ${d.key}: Angriffs-Datensätze brauchen security.payloads`, 403);
      const files = (d.files ?? []).map((f) => fileInfo(f.name, f.base64));
      const { cases, errors } = normalizeCases(d.kind, d.cases ?? [], { fileNames: new Set(files.map((f) => f.name)) });
      if (errors.length) throw bad(`Datensatz ${d.key}: ${errors.slice(0, 3).map((e) => `Zeile ${e.row}: ${e.message}`).join('; ')}`);
      const key = slug(d.key || d.name);
      let ds = (await c.query('select * from datasets where tenant_id = $1 and key = $2', [user.tenant_id, key])).rows[0];
      if (!ds) {
        ds = (await c.query(`insert into datasets (tenant_id, key, name, description, kind, language, sensitivity, origin, min_cases, created_by) values ($1, $2, $3, $4, $5, $6, $7, 'tenant', $8, $9) returning *`, [user.tenant_id, key, d.name ?? key, d.description ?? null, d.kind, (d.language ?? 'de').slice(0, 8), sensitivity, Math.max(1, Number(d.min_cases) || 30), user.id])).rows[0];
      }
      const { contentHash } = await import('../datasets.js');
      const hash = contentHash(cases, files);
      const same = (await c.query('select version from dataset_versions where dataset_id = $1 and hash = $2', [ds.id, hash])).rows[0];
      const version = same ? same.version : (await createVersion(c, ds.id, { version: undefined, bumpKind: 'minor', cases, files, notes: 'Import', userId: user.id })).version;
      mapped.set(`${d.key}@${d.version}`, { key, version });
      mapped.set(d.key, { key, version });
      summary.datasets.push({ key, version, reused: Boolean(same) });
    }
    return mapped;
  }

  async function importTemplate(c, user, doc, datasetMap, summary) {
    const tpl = doc.template ?? {};
    if (!tpl.name || !tpl.type) throw bad('Vorlage: name und type sind Pflicht');
    const spec0 = structuredClone(doc.spec ?? {});
    // Eben importierte Datensätze liegen noch in der Transaktion und sind für die Prüfung außerhalb nicht sichtbar.
    const mapped = spec0.dataset ? (datasetMap.get(`${spec0.dataset.key}@${spec0.dataset.version}`) ?? datasetMap.get(spec0.dataset.key)) : null;
    if (mapped) delete spec0.dataset;
    const spec = await validateSpec(user, tpl.type, spec0);
    if (mapped) spec.dataset = mapped;
    const catRows = [];
    for (const cat of tpl.categories ?? []) {
      let row = (await c.query('select id from categories where framework = $1 and key = $2 and (tenant_id = $3 or tenant_id is null) order by tenant_id nulls last limit 1', [cat.framework, cat.key, user.tenant_id])).rows[0];
      if (!row) {
        row = (await c.query(`insert into categories (tenant_id, framework, key, name) values ($1, $2, $3, $4) returning id`, [user.tenant_id, cat.framework, cat.key, cat.name ?? cat.key])).rows[0];
        summary.warnings.push(`Kategorie ${cat.framework}/${cat.key} neu angelegt`);
      }
      catRows.push(row.id);
    }
    const key = slug(tpl.key || tpl.name);
    let t = (await c.query('select * from templates where tenant_id = $1 and key = $2', [user.tenant_id, key])).rows[0];
    if (t && !canEditTemplate(user, t)) throw bad(`Vorlage ${key} existiert und gehört jemand anderem`, 403);
    if (!t) {
      t = (await c.query(`insert into templates (key, tenant_id, origin, owner_id, name, description, type, tags, use_cases, security) values ($1, $2, 'private', $3, $4, $5, $6, $7, $8, $9) returning *`, [key, user.tenant_id, user.id, tpl.name, tpl.description ?? null, tpl.type, tpl.tags ?? [], validateUseCases(tpl.use_cases), Boolean(tpl.security)])).rows[0];
    }
    const versions = (await c.query('select version, hash from template_versions where template_id = $1', [t.id])).rows;
    const hash = specHash(tpl.type, spec, catRows.length ? await categoryKeys(catRows) : []);
    if (versions.some((v) => v.hash === hash)) {
      summary.templates.push({ key, version: versions.find((v) => v.hash === hash).version, unchanged: true });
      return (await c.query('select id, version from template_versions where template_id = $1 and hash = $2', [t.id, hash])).rows[0];
    }
    const top = versions.map((v) => v.version).sort(compare).at(-1);
    const version = !versions.some((v) => v.version === doc.version) && isSemver(doc.version) ? doc.version : bump(top ?? '1.0.0', 'minor');
    const v = await insertVersion(c, t.id, { version: top ? version : (isSemver(doc.version) ? doc.version : '1.0.0'), spec, categoryIds: catRows, hash, changelog: doc.changelog ?? 'Import', userId: user.id });
    summary.templates.push({ key, version: v.version, status: 'draft' });
    return v;
  }

  // Import: legt Datensätze, Vorlagen und Pakete als Entwürfe an; sie durchlaufen den normalen Freigabeprozess.
  app.post('/api/catalog/import', { ...editor, bodyLimit: 48 * 1024 * 1024 }, async (request) => {
    const b = request.body ?? {};
    if (typeof b.content !== 'string' || !b.content.trim()) throw bad('Inhalt fehlt');
    const doc = parseDocument(b.content, b.format);
    const summary = { datasets: [], templates: [], pack: null, warnings: [] };
    await tx(async (c) => {
      const datasetMap = await importDatasets(c, request.user, doc.datasets, summary);
      if (doc.kind === 'template') await importTemplate(c, request.user, doc, datasetMap, summary);
      else {
        const items = [];
        for (const t of doc.templates ?? []) {
          const v = await importTemplate(c, request.user, t, datasetMap, summary);
          const key = slug(t.template?.key || t.template?.name);
          items.push({ template_key: key, template_version_id: v.id, version: v.version });
        }
        if (!items.length) throw bad('Das Paket enthält keine Vorlagen');
        const p = doc.pack ?? {};
        if (!p.name) throw bad('Paket: name fehlt');
        const key = slug(p.key || p.name);
        let pack = (await c.query('select * from packs where tenant_id = $1 and key = $2', [request.user.tenant_id, key])).rows[0];
        if (pack && !canEditTemplate(request.user, pack)) throw bad(`Paket ${key} existiert und gehört jemand anderem`, 403);
        if (!pack) pack = (await c.query(`insert into packs (key, tenant_id, origin, owner_id, name, description, framework) values ($1, $2, 'private', $3, $4, $5, $6) returning *`, [key, request.user.tenant_id, request.user.id, p.name, p.description ?? null, p.framework ?? null])).rows[0];
        const versions = (await c.query('select version, hash from pack_versions where pack_id = $1', [pack.id])).rows;
        const hash = specHash('pack', items, []);
        if (versions.some((v) => v.hash === hash)) summary.pack = { key, unchanged: true };
        else {
          const top = versions.map((v) => v.version).sort(compare).at(-1);
          const version = top ? bump(top, 'minor') : isSemver(doc.version) ? doc.version : '1.0.0';
          await c.query(`insert into pack_versions (pack_id, version, status, items, changelog, hash, created_by) values ($1, $2, 'draft', $3, $4, $5, $6)`, [pack.id, version, JSON.stringify(items), doc.changelog ?? 'Import', hash, request.user.id]);
          summary.pack = { key, version, status: 'draft' };
        }
      }
    });
    await logAudit(request, 'catalog.import', doc.kind, null, { templates: summary.templates.length, datasets: summary.datasets.length });
    return summary;
  });

  app.get('/api/catalog/use-cases', viewer, async () => USE_CASES);
}
