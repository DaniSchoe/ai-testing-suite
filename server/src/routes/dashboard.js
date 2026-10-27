// Dashboard in drei Ebenen: Portfolio → Plattform → Modell, dazu Souveränität (SEAL). Die Umgebung (prod/dev/all) wählt die Oberfläche oben.
import { hasPermission, requirePermission } from '../auth.js';
import { many, one } from '../db.js';
import { envFilter, heatmap, latestResults, NORMALIZATION, scorecard, sloOf, suitability } from '../dashboard.js';
import { assess, sovereignty } from '../assessment.js';
import { percentile } from '../evaluate.js';
import { platformStatus } from '../snapshot.js';
import { GPU_TYPES } from '../inventory.js';

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

const err = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);

export default async function dashboardRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const params = (request) => ({ environment: envFilter(request.query), days: Math.min(Math.max(Number(request.query.days ?? 30), 1), 365) });
  const customerView = (user) => !hasPermission(user, 'tests.manage') && !hasPermission(user, 'security.payloads');

  async function modelMeta(platformId) {
    const rows = await many(`select m.*, e.kind from endpoint_models m join endpoints e on e.id = m.endpoint_id where e.platform_id = $1`, [platformId]);
    return (alias) => {
      const hits = rows.filter((m) => m.alias === alias || m.name === alias);
      if (!hits.length) return { caps: [] };
      const pick = (k) => hits.map((h) => h[k]).find((v) => v !== null && v !== undefined && v !== '');
      return {
        model: { open_weights: hits.some((h) => h.open_weights === true) ? true : hits.some((h) => h.open_weights === false) ? false : null, license: pick('license'), origin: pick('origin'), provider: pick('provider'), revision: pick('revision') },
        caps: [...new Set(hits.flatMap((h) => h.capabilities ?? []))],
        info: { license: pick('license'), provider: pick('provider'), origin: pick('origin'), quantization: pick('quantization'), revision: pick('revision'), context_length: pick('context_length'), open_weights: pick('open_weights') },
      };
    };
  }

  // Trend je Tag und Änderungsmarker aus den Snapshots der Läufe.
  async function markers(tenantId, platformId, days) {
    const rows = await many(
      `select id, coalesce(finished_at, created_at) as at, snapshot->'changes' as changes from runs
       where tenant_id = $1 and platform_id = $2 and not is_draft and snapshot is not null and jsonb_array_length(coalesce(snapshot->'changes', '[]'::jsonb)) > 0
         and created_at > now() - make_interval(days => $3::int) order by created_at`,
      [tenantId, platformId, days],
    );
    return rows.map((r) => ({ run_id: r.id, at: r.at, changes: r.changes }));
  }

  app.get('/api/dashboard/normalization', viewer, async () => NORMALIZATION);

  // ------------------------------------------------------------------ Portfolio
  app.get('/api/dashboard/portfolio', viewer, async (request) => {
    const t = request.user.tenant_id;
    const { environment, days } = params(request);
    const platforms = await many('select id, name, description, environment, locked, locked_reason, sovereignty from platforms where tenant_id = $1 and ($2::text is null or environment = $2) order by name', [t, environment]);
    const results = await latestResults(t, { environment, days });
    const findings = await many(`select platform_id, severity, count(*)::int as n from findings where tenant_id = $1 and status in ('open', 'in_progress') group by 1, 2`, [t]);
    const lastRuns = await many(`select distinct on (platform_id) platform_id, id, status, finished_at, snapshot from runs where tenant_id = $1 and not is_draft and platform_id is not null order by platform_id, created_at desc`, [t]);
    const out = platforms.map((p) => {
      const rs = results.filter((r) => r.platform_id === p.id);
      const last = lastRuns.find((r) => r.platform_id === p.id);
      const sev = Object.fromEntries(['critical', 'high', 'medium', 'low', 'info'].map((s) => [s, findings.filter((f) => f.platform_id === p.id && f.severity === s).reduce((n, f) => n + f.n, 0)]));
      const comps = last?.snapshot?.components ?? [];
      return {
        id: p.id,
        name: p.name,
        environment: p.environment,
        locked: p.locked,
        tests: rs.length,
        passed: rs.filter((r) => r.status === 'passed').length,
        pass_rate: rs.length ? rs.filter((r) => r.status === 'passed').length / rs.length : null,
        slo: sloOf(rs),
        findings: sev,
        open_findings: Object.values(sev).reduce((a, b) => a + b, 0),
        components: { total: comps.length, up: comps.filter((c) => c.status === 'up').length },
        last_run: last ? { id: last.id, status: last.status, finished_at: last.finished_at } : null,
        models: new Set(rs.map((r) => r.model_alias).filter(Boolean)).size,
        sovereignty_min: p.sovereignty?.min_level ?? null,
      };
    });
    const [pending, review, runs, trend] = await Promise.all([
      one(`select count(*)::int as n from approvals where tenant_id = $1 and status = 'pending'`, [t]),
      one(`select count(*)::int as n from reports where tenant_id = $1 and status = 'in_review'`, [t]),
      many(
        `select r.id, r.label, r.status, r.finished_at, r.created_at, p.name as platform_name, r.outcomes from runs r left join platforms p on p.id = r.platform_id
         where r.tenant_id = $1 and not r.is_draft and ($2::text is null or p.environment = $2) order by r.created_at desc limit 8`,
        [t, environment],
      ),
      many(
        `select date_trunc('day', res.finished_at)::date as day, count(*) filter (where res.status = 'passed')::int as passed, count(*)::int as total
         from results res join runs r on r.id = res.run_id join platforms p on p.id = res.platform_id
         where r.tenant_id = $1 and not r.is_draft and res.status in ('passed', 'failed') and res.finished_at > now() - make_interval(days => $3::int) and ($2::text is null or p.environment = $2)
         group by 1 order by 1`,
        [t, environment, days],
      ),
    ]);
    return {
      environment,
      days,
      totals: {
        platforms: out.length,
        tests: results.length,
        pass_rate: results.length ? results.filter((r) => r.status === 'passed').length / results.length : null,
        slo: sloOf(results),
        open_findings: out.reduce((n, p) => n + p.open_findings, 0),
        critical_findings: out.reduce((n, p) => n + p.findings.critical + p.findings.high, 0),
        pending_approvals: pending.n,
        reports_in_review: review.n,
      },
      platforms: out,
      recent_runs: runs,
      trend: trend.map((d) => ({ day: dayOf(d.day), passed: d.passed, total: d.total, rate: d.total ? d.passed / d.total : null })),
    };
  });

  // ------------------------------------------------------------------ Plattform
  app.get('/api/dashboard/platforms/:id', viewer, async (request) => {
    const t = request.user.tenant_id;
    const { days } = params(request);
    const platform = await one('select id, name, description, environment, locked, locked_reason, sovereignty from platforms where id = $1 and tenant_id = $2', [request.params.id, t]);
    if (!platform) throw err('Plattform nicht gefunden', 404);
    const customer = customerView(request.user);
    const rows = await latestResults(t, { platformId: platform.id, days });
    const meta = await modelMeta(platform.id);
    const aliases = [...new Set(rows.map((r) => r.model_alias).filter(Boolean))].sort();
    const models = aliases.map((alias) => {
      const rs = rows.filter((r) => r.model_alias === alias);
      const m = meta(alias);
      const card = scorecard(rs, { model: m.model });
      return { alias, info: m.info ?? null, capabilities: m.caps, scorecard: card, suitability: suitability(rs, card, m.caps), tests: rs.length, failed: rs.filter((r) => r.status === 'failed').length, regressions: rs.filter((r) => r.regressions?.length).length };
    });
    let status = null;
    try {
      status = await platformStatus(platform.id);
      if (customer) status = { ...status, components: status.components.map(({ error, info, ...c }) => c) };
    } catch {
      /* Status ist optional */
    }
    // Geschwindigkeit je Modell (mittlere TTFT, Token/s) und mittlere TTFT nach Weg; nur Performance- und Lastergebnisse.
    const perf = rows.filter((r) => ['performance', 'load'].includes(r.type));
    const ttftOf = (rs) => avg(rs.flatMap((r) => r.samples?.ttft_ms ?? []).filter((x) => typeof x === 'number'));
    const tpsOf = (rs) => avg(rs.map((r) => r.metrics?.tokens_per_s_avg).filter((x) => typeof x === 'number'));
    const speed = aliases.map((alias) => ({ alias, ttft_ms: round1(ttftOf(perf.filter((r) => r.model_alias === alias))), tokens_per_s: round1(tpsOf(perf.filter((r) => r.model_alias === alias))) }));
    const ttftByPath = { gateway: round1(ttftOf(perf.filter((r) => r.path === 'gateway'))), direct: round1(ttftOf(perf.filter((r) => r.path === 'direct'))) };
    // VRAM der Plattform: GPUs, die einem Server zugeordnet sind.
    const gpuRows = await many(
      `select e.id, e.spec, l.to_id as server_id from endpoints e join platform_links l on l.from_id = e.id and l.kind = 'hosted_in'
       join endpoints s on s.id = l.to_id and s.kind = 'server' where e.platform_id = $1 and e.kind = 'gpu'`,
      [platform.id],
    );
    const vram = {
      total_gb: gpuRows.reduce((n, g) => n + (Number(g.spec?.memory_gb) || Number(g.spec?.custom?.memory_gb) || GPU_TYPES[g.spec?.gpu_type]?.memory_gb || 0), 0),
      gpus: gpuRows.length,
      servers: new Set(gpuRows.map((g) => g.server_id)).size,
    };
    const [routesRows, findingsRows, topFindings, trend, mk, lastSnapshot, assessment, reportCounts] = await Promise.all([
      many(`select g.name as gateway, b.name as backend, r.models from platform_routes r join endpoints g on g.id = r.gateway_endpoint_id join endpoints b on b.id = r.backend_endpoint_id where r.platform_id = $1`, [platform.id]),
      many(`select severity, count(*)::int as n from findings where platform_id = $1 and status in ('open', 'in_progress') group by 1`, [platform.id]),
      many(`select id, title, severity, status, framework, category, model, path, last_seen_at from findings where platform_id = $1 and status in ('open', 'in_progress') order by array_position(array['critical','high','medium','low','info'], severity), last_seen_at desc limit 8`, [platform.id]),
      many(
        `select date_trunc('day', res.finished_at)::date as day, count(*) filter (where res.status = 'passed')::int as passed, count(*)::int as total
         from results res join runs r on r.id = res.run_id where res.platform_id = $1 and not r.is_draft and res.status in ('passed', 'failed') and res.finished_at > now() - make_interval(days => $2::int) group by 1 order by 1`,
        [platform.id, days],
      ),
      markers(t, platform.id, days),
      one(`select id, finished_at, snapshot from runs where platform_id = $1 and snapshot is not null and not is_draft order by created_at desc limit 1`, [platform.id]),
      assess(t, platform.id),
      one(`select count(*)::int as total, count(*) filter (where status = 'approved')::int as approved from reports where tenant_id = $1 and body->'platform'->>'id' = $2`, [t, platform.id]),
    ]);
    // SLO je Prüfung: welche Schwellwerte werden nicht erfüllt.
    const failing = rows.filter((r) => r.rules?.length && r.status === 'failed').map((r) => ({ template: r.template_key, model: r.model_alias, path: r.path, rules: r.rules }));
    return {
      platform,
      view: customer ? 'customer' : 'full',
      days,
      status,
      routes: routesRows,
      snapshot: lastSnapshot ? { run_id: lastSnapshot.id, at: lastSnapshot.finished_at, ...lastSnapshot.snapshot } : null,
      sovereignty: assessment ? { ...assessment.sovereignty, goals: assessment.sovereignty.goals.map(({ checks, ...g }) => g) } : null,
      assessment: assessment ? { security: { score: assessment.security.score, level: assessment.security.level }, production: { score: assessment.production.score, level: assessment.production.level } } : null,
      reports: reportCounts,
      findings: { open: Object.fromEntries(findingsRows.map((f) => [f.severity, f.n])), top: topFindings },
      slo: { ...sloOf(rows), failing: failing.slice(0, 10) },
      models,
      speed,
      ttft_by_path: ttftByPath,
      vram,
      heatmap: await heatmap(t, { platformId: platform.id, days }),
      trend: trend.map((d) => ({ day: dayOf(d.day), passed: d.passed, total: d.total, rate: d.total ? d.passed / d.total : null })),
      markers: mk,
      normalization: NORMALIZATION.version,
    };
  });

  // ------------------------------------------------------------------ Modell
  app.get('/api/dashboard/models', viewer, async (request) => {
    const t = request.user.tenant_id;
    const { days } = params(request);
    const { platform_id: platformId, model } = request.query;
    if (!platformId || !model) throw err('platform_id und model sind Pflicht');
    const platform = await one('select id, name, environment from platforms where id = $1 and tenant_id = $2', [platformId, t]);
    if (!platform) throw err('Plattform nicht gefunden', 404);
    const rows = await latestResults(t, { platformId, days, model });
    const meta = (await modelMeta(platformId))(model);
    const card = scorecard(rows, { model: meta.model });
    const byPath = {};
    for (const path of [...new Set(rows.map((r) => r.path).filter(Boolean))]) {
      const rs = rows.filter((r) => r.path === path);
      byPath[path] = scorecard(rs, { model: meta.model });
    }
    // Zeitreihe je Lauf: Qualität (Anteil richtiger Fälle gepoolt), Sicherheit, Latenz p95 gepoolt, Fehlerrate.
    const series = await many(
      `select r.id as run_id, coalesce(r.finished_at, r.created_at) as at, res.type, res.score, res.metrics, res.details->'samples' as samples,
         case when jsonb_typeof(res.details->'cases') = 'array' then jsonb_array_length(res.details->'cases') end as cases_total,
         case when jsonb_typeof(res.details->'cases') = 'array' then (select count(*)::int from jsonb_array_elements(res.details->'cases') c where c->>'ok' = 'true') end as cases_passed
       from results res join runs r on r.id = res.run_id where res.platform_id = $1 and res.model_alias = $2 and not r.is_draft and res.status in ('passed', 'failed')
         and res.finished_at > now() - make_interval(days => $3::int) order by r.created_at`,
      [platformId, model, days],
    );
    const byRun = new Map();
    for (const s of series) byRun.set(s.run_id, [...(byRun.get(s.run_id) ?? []), s]);
    const trend = [...byRun.entries()].map(([runId, rs]) => {
      const caseRate = (types) => {
        const part = rs.filter((x) => types.includes(x.type));
        const total = part.reduce((n, x) => n + (x.cases_total ?? 1), 0);
        const ok = part.reduce((n, x) => n + (x.cases_total ? x.cases_passed : Number(x.score ?? 0)), 0);
        return total ? ok / total : null;
      };
      const lat = rs.flatMap((x) => x.samples?.latency_ms ?? []);
      return {
        run_id: runId,
        at: rs[0].at,
        quality: caseRate(['quality', 'coding', 'ocr', 'thinking', 'structured']),
        security: caseRate(['security', 'access']),
        latency_ms_p95: percentile(lat, 95),
      };
    });
    const baselines = await many(
      `select a.id as audit_id, a.name, a.baseline_run_id, r.finished_at as at from audits a join runs r on r.id = a.baseline_run_id where a.tenant_id = $1 and a.platform_id = $2`,
      [t, platformId],
    );
    const findings = await many(`select id, title, severity, status, path, category from findings where platform_id = $1 and model = $2 and status in ('open', 'in_progress') order by array_position(array['critical','high','medium','low','info'], severity)`, [platformId, model]);
    return {
      platform,
      model,
      info: meta.info ?? null,
      capabilities: meta.caps,
      days,
      scorecard: card,
      by_path: byPath,
      suitability: suitability(rows, card, meta.caps),
      results: rows.map((r) => ({ id: r.id, run_id: r.run_id, template: r.template_key, version: r.template_version, type: r.type, path: r.path, status: r.status, outcome: r.outcome, score: r.score === null ? null : Number(r.score), metrics: r.metrics, statistics: r.statistics, cases_total: r.cases_total, cases_passed: r.cases_passed, small_sample: Boolean(r.dataset?.small_sample), regressions: r.regressions ?? [], finished_at: r.finished_at })),
      trend,
      markers: await markers(t, platformId, days),
      baselines,
      findings,
    };
  });

  // ------------------------------------------------------------------ Souveränität
  app.get('/api/sovereignty', viewer, async (request) => {
    const t = request.user.tenant_id;
    const { environment } = params(request);
    const platforms = await many('select id from platforms where tenant_id = $1 and ($2::text is null or environment = $2) and ($3::uuid is null or id = $3) order by name', [t, environment, request.query.platform_id || null]);
    return Promise.all(platforms.map((p) => sovereignty(t, p.id)));
  });
}
