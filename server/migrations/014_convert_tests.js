// 0.4.0: Bestehende Tests (Test-Builder) in Prüfungen, Vorlagen und Plattformbezug überführen.
// Die IDs der Tests bleiben als Prüfungs-IDs erhalten, damit Läufe, Einzeltests und Zeitpläne verknüpft bleiben.
import { createHash } from 'node:crypto';
import { syncOfficialCatalog } from '../src/catalogSync.js';

const OFFICIAL_OF = {
  smoke: 'smoke-health',
  performance: 'performance-streaming',
  load: 'load-ramp',
  quality: 'quality-reasoning',
  coding: 'coding-js',
  ocr: 'ocr-documents',
  security: 'security-owasp',
  access: 'access-keys',
  mcp: 'mcp-tools',
  structured: 'structured-tools',
  thinking: 'thinking-compare',
};

// Eigene Konfigurationsteile, die nicht aus dem Datensatz der Vorlage kommen sollen: Pass/Fail-Regeln wandern in die Schwellwerte der Prüfung.
const THRESHOLD_KEYS = ['minScore', 'minAccuracy', 'thresholds', 'regressionTolerance', 'failOnRegression', 'model', 'models'];
const INLINE_DATA = ['cases', 'prompts', 'tasks', 'documents'];

function thresholdsOf(cfg, suggested) {
  const out = [];
  if (cfg.thresholds && typeof cfg.thresholds === 'object') {
    for (const [metric, rule] of Object.entries(cfg.thresholds)) {
      if (rule?.max !== undefined) out.push({ metric, op: '<=', value: Number(rule.max) });
      if (rule?.min !== undefined) out.push({ metric, op: '>=', value: Number(rule.min) });
    }
  }
  if (typeof cfg.minScore === 'number') out.push({ metric: 'score', op: '>=', value: cfg.minScore });
  return out.length ? out : (suggested ?? []);
}

export async function up(client, { log = console } = {}) {
  await syncOfficialCatalog(client);

  const official = new Map();
  for (const [type, key] of Object.entries(OFFICIAL_OF)) {
    const { rows } = await client.query(
      `select t.id as template_id, v.id as version_id, v.version, v.spec from templates t
       join template_versions v on v.template_id = t.id where t.tenant_id is null and t.key = $1
       order by string_to_array(v.version, '.')::int[] desc limit 1`,
      [key],
    );
    if (rows[0]) official.set(type, { key, ...rows[0] });
  }

  const { rows: audits } = await client.query('select * from audits');
  for (const a of audits) {
    const ep = a.endpoint_id ? (await client.query('select id, platform_id, kind, default_model from endpoints where id = $1', [a.endpoint_id])).rows[0] : null;
    const platformId =
      ep?.platform_id ?? (await client.query('select id from platforms where tenant_id = $1 order by created_at limit 1', [a.tenant_id])).rows[0]?.id ?? null;
    const path = ep?.kind === 'llm' ? 'direct' : 'gateway';
    // Modelle des Tests; ältere Tests tragen das Modell in der Konfiguration der Testart.
    const aliases = new Set(a.models_old ?? []);
    for (const cfg of Object.values(a.configs ?? {})) if (typeof cfg?.model === 'string' && cfg.model) aliases.add(cfg.model);
    // Ohne Angabe galt bisher das Standardmodell des Endpoints.
    if (!aliases.size && ep) {
      const fallback =
        ep.default_model ?? (await client.query('select coalesce(alias, name) as a from endpoint_models where endpoint_id = $1 and available order by name limit 1', [ep.id])).rows[0]?.a;
      if (fallback) aliases.add(fallback);
    }
    const models = [...aliases].map((alias) => ({ alias, path }));

    const items = [];
    let tolerance = 0.2;
    for (const type of a.types ?? []) {
      const base = official.get(type);
      if (!base) continue;
      const cfg = a.configs?.[type] ?? {};
      if (typeof cfg.regressionTolerance === 'number') tolerance = cfg.regressionTolerance;
      const own = Object.keys(cfg).filter((k) => !THRESHOLD_KEYS.includes(k));
      const thresholds = thresholdsOf(cfg, base.spec.suggested_thresholds);
      if (!own.length) {
        items.push({ template_version_id: base.version_id, thresholds });
        continue;
      }
      // Abweichende Konfiguration: private Vorlage des Maintainers, veröffentlicht in Version 1.0.0.
      const spec = structuredClone(base.spec);
      spec.config = { ...spec.config, ...Object.fromEntries(own.map((k) => [k, cfg[k]])) };
      if (own.some((k) => INLINE_DATA.includes(k))) spec.dataset = null;
      spec.source = { migrated_from: `Test ${a.name}`, official: `${base.key}@${base.version}` };
      const key = `migriert-${type}-${a.id.slice(0, 8)}`;
      const owner = a.maintainer_id ?? a.created_by;
      const tpl = (
        await client.query(
          `insert into templates (key, tenant_id, origin, owner_id, name, description, type, use_cases, security)
           select $1, $2, 'private', $3, $4, $5, $6, use_cases, security from templates where id = $7 returning id`,
          [key, a.tenant_id, owner, `${a.name} · ${type}`, `Aus dem Test „${a.name}“ übernommen (abweichende Konfiguration)`, type, base.template_id],
        )
      ).rows[0];
      const hash = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
      const ver = (
        await client.query(
          `insert into template_versions (template_id, version, status, spec, changelog, hash, created_by, published_at)
           values ($1, '1.0.0', 'published', $2, 'Migration aus dem Test-Builder', $3, $4, now()) returning id`,
          [tpl.id, JSON.stringify(spec), hash, owner],
        )
      ).rows[0];
      await client.query('insert into template_version_categories select $1, category_id from template_version_categories where version_id = $2', [ver.id, base.version_id]);
      items.push({ template_version_id: ver.id, thresholds });
    }

    await client.query('update audits set platform_id = $2, models = $3, items = $4, regression_tolerance = $5 where id = $1', [
      a.id,
      platformId,
      JSON.stringify(models),
      JSON.stringify(items),
      tolerance,
    ]);
    await client.query('update runs set platform_id = $2 where audit_id = $1', [a.id, platformId]);
  }

  // Alte Ergebnisse: Zuordnung zu Prüfung, Plattform und der offiziellen Vorlage der Testart (ohne Versionsbezug).
  await client.query(
    `update results r set audit_id = t.audit_id, platform_id = e.platform_id
     from test_definitions t, endpoints e where r.test_id = t.id and e.id = r.endpoint_id`,
  );
  await client.query(`update results r set platform_id = e.platform_id from endpoints e where r.platform_id is null and e.id = r.endpoint_id`);
  for (const [type, key] of Object.entries(OFFICIAL_OF)) {
    await client.query('update results set template_key = $2 where type = $1 and template_key is null', [type, key]);
  }
  await client.query(`update results set path = case when e.kind = 'llm' then 'direct' else 'gateway' end from endpoints e where e.id = results.endpoint_id and results.path is null`);
  await client.query(`update runs r set platform_id = (select platform_id from endpoints e where e.id = (select endpoint_id from results x where x.run_id = r.id limit 1)) where r.platform_id is null`);

  await client.query(
    `alter table audits drop column endpoint_id, drop column types, drop column configs, drop column models_old,
       drop column requires_api_key, drop column published_at`,
  );
  log.info?.(`Tests in Prüfungen überführt: ${audits.length}`);
}
