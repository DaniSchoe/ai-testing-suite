// Tests aus dem Test-Builder: Sichtbarkeit und Erzeugung der ausführbaren Einzeltests.
import { testTypes } from './testtypes/index.js';

const teamIdsOf = (user) => (user.teams ?? []).map((t) => t.id);

// Ersteller, Maintainer und Administratoren sehen einen Test immer; sonst gilt die Veröffentlichung.
export function canSeeBuild(user, build) {
  if (user.is_admin || build.created_by === user.id || build.maintainer_id === user.id) return true;
  if (build.visibility === 'global') return true;
  if (build.visibility === 'teams') return teamIdsOf(user).some((id) => (build.teamIds ?? []).includes(id));
  return false;
}

export const canEditBuild = (user, build) => user.is_admin || build.created_by === user.id || build.maintainer_id === user.id;

// Welche Einzeltests (Testart × Modell) ein Test erzeugt.
export function atomPlan(build) {
  const plan = [];
  const models = build.models ?? [];
  for (const type of build.types) {
    const def = testTypes[type];
    const base = { ...(build.configs?.[type] ?? {}) };
    const mode = def.modelMode ?? 'each';
    if (mode === 'each' && models.length) {
      for (const model of models) plan.push({ type, key: model, model, config: { ...base, model } });
    } else if (mode === 'list' && models.length) {
      plan.push({ type, key: '', model: null, config: { ...base, models } });
    } else if (mode === 'first' && models.length) {
      plan.push({ type, key: '', model: models[0], config: { ...base, model: models[0] } });
    } else {
      plan.push({ type, key: '', model: null, config: base });
    }
  }
  const single = plan.length === 1;
  return plan.map((a) => ({
    ...a,
    name: single ? build.name : `${build.name} · ${testTypes[a.type].label}${a.model && (testTypes[a.type].modelMode ?? 'each') === 'each' ? ` · ${a.model}` : ''}`,
  }));
}

// Einzeltests mit dem Test abgleichen. IDs bleiben stabil, damit Historie und Regressionsvergleich erhalten bleiben.
export async function syncAtoms(client, build) {
  const plan = atomPlan(build);
  const { rows: existing } = await client.query('select id, type, build_key from test_definitions where build_id = $1', [build.id]);
  const keep = new Set();
  for (const a of plan) {
    const hit = existing.find((e) => e.type === a.type && (e.build_key ?? '') === a.key && !keep.has(e.id));
    if (hit) {
      keep.add(hit.id);
      await client.query(
        `update test_definitions set name = $2, endpoint_id = $3, api_key_id = $4, config = $5, tags = $6, enabled = true, updated_at = now()
         where id = $1`,
        [hit.id, a.name, build.endpoint_id, build.api_key_id, a.config, build.tags],
      );
    } else {
      const { rows } = await client.query(
        `insert into test_definitions (name, type, endpoint_id, api_key_id, config, tags, enabled, created_by, build_id, build_key)
         values ($1, $2, $3, $4, $5, $6, true, $7, $8, $9) returning id`,
        [a.name, a.type, build.endpoint_id, build.api_key_id, a.config, build.tags, build.created_by, build.id, a.key],
      );
      keep.add(rows[0].id);
    }
  }
  await client.query('delete from test_definitions where build_id = $1 and not (id = any($2::uuid[]))', [build.id, [...keep]]);
  return plan.length;
}

// Richtwerte (Millisekunden), solange es zu einer Testart noch keine Historie gibt.
const DEFAULT_MS = { smoke: 5_000, performance: 45_000, quality: 90_000, coding: 60_000, ocr: 45_000, security: 40_000, access: 8_000, mcp: 8_000, structured: 15_000, thinking: 150_000 };

// Geschätzte Laufzeit für die Einzeltests eines Tests: Median der letzten bis zu zehn Ausführungen derselben Testart
// (bevorzugt mit demselben Modell), sonst Richtwert je Testart. Die Einzeltests laufen nacheinander.
export async function estimateRuntime(plan, query) {
  let total = 0;
  let fromHistory = 0;
  for (const a of plan) {
    const sql = `select percentile_cont(0.5) within group (order by duration_ms) as ms, count(*)::int as n
       from (select duration_ms from results where type = $1 and status <> 'error' and duration_ms is not null
             and ($2::text is null or coalesce(model_alias, model) = $2 or model = $2)
             order by finished_at desc limit 10) x`;
    let row = (await query(sql, [a.type, a.model])).rows?.[0];
    if (!row?.n && a.model) row = (await query(sql, [a.type, null])).rows?.[0];
    if (row?.n) {
      total += Number(row.ms);
      fromHistory += 1;
    } else if (a.type === 'load') {
      const stages = a.config?.stages ?? testTypes.load.defaults.stages;
      total += stages.reduce((n, s) => n + s.durationS * 1000, 0) + 5_000;
    } else {
      total += DEFAULT_MS[a.type] ?? 30_000;
    }
  }
  return {
    count: plan.length,
    estimate_ms: Math.round(total),
    basis: fromHistory === plan.length ? 'history' : fromHistory === 0 ? 'estimate' : 'mixed',
  };
}
