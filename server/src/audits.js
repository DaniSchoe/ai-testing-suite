// Prüfungen (Audits): Laden mit Zusatzangaben, Sichtbarkeit, Vorlagen-Aktualisierungen und Laufzeitschätzung.
import { many, one } from './db.js';
import { loadTemplateVersions } from './plan.js';

const teamIdsOf = (user) => (user.teams ?? []).map((t) => t.id);

// Ersteller, Maintainer und Administratoren sehen eine Prüfung immer; sonst gilt die Sichtbarkeit.
export function canSeeAudit(user, a) {
  if (user.is_admin || a.created_by === user.id || a.maintainer_id === user.id) return true;
  if (a.visibility === 'global') return true;
  if (a.visibility === 'teams') return teamIdsOf(user).some((id) => (a.teamIds ?? []).includes(id));
  return false;
}
export const canEditAudit = (user, a) => user.is_admin || a.created_by === user.id || a.maintainer_id === user.id;

export async function loadAudits(tenantId, id = null) {
  const rows = await many(
    `select a.*, p.name as platform_name, p.environment as platform_environment, p.locked as platform_locked, k.name as api_key_name,
       coalesce(u.display_name, u.username) as maintainer_name, coalesce(c.display_name, c.username) as creator_name,
       (select count(*)::int from runs r where r.audit_id = a.id and not r.is_draft) as run_count,
       lr.id as last_run_id, lr.status as last_status, lr.finished_at as last_run_at, lr.outcomes as last_outcomes,
       sc.id as schedule_id, sc.cron as schedule_cron, sc.run_at as schedule_run_at, sc.timezone as schedule_timezone, sc.enabled as schedule_enabled
     from audits a
     left join platforms p on p.id = a.platform_id
     left join api_keys k on k.id = a.api_key_id
     left join users u on u.id = a.maintainer_id
     left join users c on c.id = a.created_by
     left join schedules sc on sc.audit_id = a.id
     left join lateral (select id, status, finished_at, outcomes from runs where audit_id = a.id and not is_draft order by created_at desc limit 1) lr on true
     where a.tenant_id = $1 and ($2::uuid is null or a.id = $2)
     order by a.name`,
    [tenantId, id],
  );
  const teams = await many('select audit_id, team_id from audit_teams t join audits a on a.id = t.audit_id where a.tenant_id = $1', [tenantId]);
  return rows.map((a) => ({ ...a, teamIds: teams.filter((x) => x.audit_id === a.id).map((x) => x.team_id) }));
}

// Positionen mit Vorlagenname, Version, Status und – falls vorhanden – einer neueren veröffentlichten Version.
export async function describeItems(items) {
  const versions = await loadTemplateVersions(items.map((i) => i.template_version_id));
  const ids = [...new Set([...versions.values()].map((v) => v.template_id))];
  const newer = ids.length
    ? await many(
        `select distinct on (template_id) template_id, id, version from template_versions
         where template_id = any($1) and status = 'published' order by template_id, string_to_array(version, '.')::int[] desc`,
        [ids],
      )
    : [];
  const latest = new Map(newer.map((n) => [n.template_id, n]));
  return items.map((item, index) => {
    const v = versions.get(item.template_version_id);
    if (!v) return { ...item, index, missing: true };
    const l = latest.get(v.template_id);
    return {
      ...item,
      index,
      key: v.key,
      name: v.name,
      type: v.type,
      version: v.version,
      status: v.status,
      load: Boolean(v.spec?.load),
      security: v.security,
      requires: v.spec?.requires ?? [],
      categories: v.categories,
      suggested_thresholds: v.spec?.suggested_thresholds ?? [],
      update_available: l && l.id !== v.id && v.version !== l.version ? { version: l.version, version_id: l.id } : null,
    };
  });
}

const DEFAULT_MS = { smoke: 5_000, performance: 45_000, quality: 90_000, coding: 60_000, ocr: 45_000, security: 40_000, access: 8_000, mcp: 8_000, structured: 15_000, thinking: 150_000 };

// Geschätzte Laufzeit: Median der letzten Ausführungen derselben Vorlage (und desselben Modells), sonst Richtwert je Testart.
export async function estimateRuntime(plan) {
  let total = 0;
  let fromHistory = 0;
  const run = plan.filter((a) => a.applicable);
  for (const a of run) {
    const hist = await one(
      `select percentile_cont(0.5) within group (order by duration_ms) as ms, count(*)::int as n from
         (select duration_ms from results where template_key = $1 and status in ('passed', 'failed') and duration_ms is not null
            and ($2::text is null or model_alias = $2) order by finished_at desc limit 10) x`,
      [a.template_key, a.model ?? null],
    );
    if (hist?.n) {
      total += Number(hist.ms);
      fromHistory += 1;
    } else if (a.type === 'load') {
      total += (a.config?.stages ?? []).reduce((n, s) => n + s.durationS * 1000, 0) + 5_000;
    } else {
      total += (DEFAULT_MS[a.type] ?? 30_000) * (a.repeats ?? 1);
    }
  }
  return { count: plan.length, applicable: run.length, estimate_ms: Math.round(total), basis: !run.length || fromHistory === run.length ? 'history' : fromHistory === 0 ? 'estimate' : 'mixed' };
}
