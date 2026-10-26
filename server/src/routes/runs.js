// Testläufe starten und einsehen, Ergebnistabelle ("Meine Tests") und Dashboard-Auswertungen.
import { analyzeRun } from '../analysis.js';
import { hasPermission, requirePermission } from '../auth.js';
import { many, one, query } from '../db.js';
import { dashboardAccess, dashboardFilters, resultFilter } from '../dashboardFilter.js';
import { createRun } from '../runs.js';
import { canSeeRunOf, resolveScope, scopeParams, scopeSql } from '../scope.js';

const RESULT_SORT = {
  started_at: 'res.started_at',
  test_name: 'res.test_name',
  type: 'res.type',
  status: 'res.status',
  score: 'res.score',
  duration_ms: 'res.duration_ms',
  model: 'res.model',
};

export default async function runRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const starter = { preHandler: requirePermission('runs.start') };

  // body: { kind: 'single'|'selection'|'suite'|'all', testIds?, suiteId? }
  app.post('/api/runs', starter, async (request) => {
    const b = request.body ?? {};
    if (b.kind === 'build') throw Object.assign(new Error('Tests werden über /api/builds/:id/run gestartet'), { statusCode: 400 });
    return createRun({ kind: b.kind, testIds: b.testIds, suiteId: b.suiteId, buildId: b.buildId, userId: request.user.id, label: b.label });
  });

  app.get('/api/runs', viewer, async (request) => {
    const s = resolveScope(request.user, request.query);
    const limit = Math.min(Number(request.query.limit ?? 50), 200);
    return many(
      `select r.*, u.display_name as user_name from runs r left join users u on u.id = r.user_id
       where ${scopeSql(1)} order by r.created_at desc limit $4`,
      [...scopeParams(request.user, s), limit],
    );
  });

  app.get('/api/runs/:id', viewer, async (request, reply) => {
    const run = await one(
      `select r.*, u.display_name as user_name from runs r left join users u on u.id = r.user_id where r.id = $1`,
      [request.params.id],
    );
    if (!run || !(await canSeeRunOf(request.user, run.user_id))) return reply.code(404).send({ error: 'Lauf nicht gefunden' });
    const results = await many('select * from results where run_id = $1 order by started_at', [run.id]);
    return { ...run, results };
  });

  // Logs inkrementell abrufen (?after=<letzte id>), das Frontend pollt während der Lauf aktiv ist.
  app.get('/api/runs/:id/logs', viewer, async (request, reply) => {
    const run = await one('select user_id from runs where id = $1', [request.params.id]);
    if (!run || !(await canSeeRunOf(request.user, run.user_id))) return reply.code(404).send({ error: 'Lauf nicht gefunden' });
    return many('select * from run_logs where run_id = $1 and id > $2 order by id limit 1000', [
      request.params.id,
      Number(request.query.after ?? 0),
    ]);
  });

  // KI-Analyse neu erzeugen, z. B. nachdem ein Analysemodell festgelegt wurde.
  app.post('/api/runs/:id/analysis', starter, async (request, reply) => {
    const run = await one('select user_id, status from runs where id = $1', [request.params.id]);
    if (!run || !(await canSeeRunOf(request.user, run.user_id))) return reply.code(404).send({ error: 'Lauf nicht gefunden' });
    if (['queued', 'running'].includes(run.status)) return reply.code(409).send({ error: 'Der Lauf ist noch nicht beendet' });
    await query(`update runs set analysis_status = 'pending' where id = $1`, [request.params.id]);
    analyzeRun(request.params.id, request.log).catch(() => {});
    return { ok: true };
  });

  app.post('/api/runs/:id/cancel', starter, async (request, reply) => {
    const run = await one('select user_id, status from runs where id = $1', [request.params.id]);
    if (!run) return reply.code(404).send({ error: 'Lauf nicht gefunden' });
    if (run.user_id !== request.user.id && !hasPermission(request.user, 'runs.manage_all')) {
      return reply.code(403).send({ error: 'Nur eigene Läufe können abgebrochen werden' });
    }
    await query(
      `update runs set status = 'cancelled', finished_at = now() where id = $1 and status in ('queued', 'running')`,
      [request.params.id],
    );
    return { ok: true };
  });

  // Tabelle aller durchgeführten Tests (ein Eintrag pro Testausführung) mit Filter, Sortierung, Paging.
  app.get('/api/results', viewer, async (request) => {
    const q = request.query;
    const s = resolveScope(request.user, q);
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(Number(q.pageSize ?? 25), 200);
    const sort = RESULT_SORT[q.sort] ?? RESULT_SORT.started_at;
    const dir = q.dir === 'asc' ? 'asc' : 'desc';
    const params = [...scopeParams(request.user, s), q.type || null, q.status || null, q.search ? `%${q.search}%` : null];
    const where = `${scopeSql(1)}
      and ($4::text is null or res.type = $4)
      and ($5::text is null or res.status = $5)
      and ($6::text is null or res.test_name ilike $6 or res.model ilike $6 or res.endpoint_name ilike $6)`;
    const [{ total }] = await many(
      `select count(*)::int as total from results res join runs r on r.id = res.run_id where ${where}`,
      params,
    );
    const rows = await many(
      `select res.id, res.run_id, res.test_id, res.test_name, res.type, res.endpoint_name, res.model, res.api_key_name,
         res.status, res.score, res.duration_ms, res.metrics, res.error, res.started_at, res.finished_at,
         (jsonb_array_length(coalesce(res.details->'regression'->'regressions', '[]'::jsonb)) > 0) as regression,
         r.trigger, r.label as run_label, u.display_name as user_name
       from results res join runs r on r.id = res.run_id left join users u on u.id = r.user_id
       where ${where}
       order by ${sort} ${dir} nulls last
       limit ${pageSize} offset ${(page - 1) * pageSize}`,
      params,
    );
    return { total, page, pageSize, rows, scope: s.scope, teamId: s.teamId };
  });

  // Historie: Testläufe als Bündel, darin die einzelnen Testergebnisse. Filter wie im Dashboard
  // (Team/Nutzer, Endpoints und Modelle als Vereinigung, ohne Auswahl nur Prod), dazu Status, Testart, Suche und Zeitraum.
  app.get('/api/history', viewer, async (request) => {
    const q = request.query;
    const s = resolveScope(request.user, q);
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(Math.max(Number(q.pageSize ?? 20), 1), 100);
    const days = q.days ? Math.min(Math.max(Number(q.days), 1), 365) : null;
    const access = await dashboardAccess(request.user, q);
    const filter = resultFilter(access, 5);
    const status = q.status || null;
    const type = q.type || null;
    const search = q.search ? `%${q.search}%` : null;
    const params = [...scopeParams(request.user, s), days, ...filter.params, type, search];
    const typeSql = '($10::text is null or res.type = $10)';
    const searchSql = '($11::text is null or res.test_name ilike $11 or res.model ilike $11 or res.endpoint_name ilike $11 or mr.label ilike $11)';
    const filtered = access.selected || type || search ? 'true' : 'false';
    // Innerer Lauf heißt mr, damit er den äußeren Lauf r nicht überdeckt.
    const matching = `from results res join runs mr on mr.id = res.run_id
      where ${scopeSql(1, 'mr')} and ($4::int is null or mr.created_at > now() - make_interval(days => $4::int))
        and ${filter.sql} and ${typeSql} and ${searchSql}`;
    // Läufe ohne Ergebnisse (wartend/laufend) bleiben sichtbar, solange kein Filter gesetzt ist.
    const sel = `from runs r left join users u on u.id = r.user_id
      where ${scopeSql(1)} and ($4::int is null or r.created_at > now() - make_interval(days => $4::int))
        and (exists (select 1 ${matching} and res.run_id = r.id and ($12::text is null or res.status = $12))
             or (not ${filtered} and $12::text is null and not exists (select 1 from results x where x.run_id = r.id)))`;
    const p = [...params, status];
    const [{ total }] = await many(`select count(*)::int as total ${sel}`, p);
    const runs = await many(
      `select r.id, r.label, r.kind, r.trigger, r.status, r.created_at, r.started_at, r.finished_at, u.display_name as user_name
       ${sel} order by r.created_at desc limit ${pageSize} offset ${(page - 1) * pageSize}`,
      p,
    );
    const ids = runs.map((r) => r.id);
    const rows = ids.length
      ? await many(
          `select res.id, res.run_id, res.test_name, res.type, res.endpoint_name, res.model, res.model_alias, res.api_key_name,
             res.status, res.score, res.duration_ms, res.metrics, res.error, res.started_at,
             (jsonb_array_length(coalesce(res.details->'regression'->'regressions', '[]'::jsonb)) > 0) as regression
           ${matching} and res.run_id = any($12::uuid[]) order by res.started_at`,
          [...params, ids],
        )
      : [];
    const byRun = new Map();
    for (const r of rows) byRun.set(r.run_id, [...(byRun.get(r.run_id) ?? []), r]);
    return {
      total,
      page,
      pageSize,
      runs: runs.map((r) => {
        const results = byRun.get(r.id) ?? [];
        const count = (st) => results.filter((x) => x.status === st).length;
        return { ...r, results, total: results.length, passed: count('passed'), failed: count('failed'), errored: count('error') };
      }),
      scope: s.scope,
      teamId: s.teamId,
    };
  });

  app.get('/api/results/:id', viewer, async (request, reply) => {
    const row = await one('select res.*, r.user_id from results res join runs r on r.id = res.run_id where res.id = $1', [
      request.params.id,
    ]);
    if (!row || !(await canSeeRunOf(request.user, row.user_id))) return reply.code(404).send({ error: 'Ergebnis nicht gefunden' });
    return row;
  });

  // Auswahlliste für den Filter im Dashboard.
  app.get('/api/dashboard/filters', viewer, async (request) => dashboardFilters(request.user));

  // Dashboard: global (alle User), ein Team oder nur eigene Läufe, über einen Zeitraum in Tagen.
  app.get('/api/dashboard', viewer, async (request) => {
    const s = resolveScope(request.user, request.query, 'all');
    const days = Math.min(Math.max(Number(request.query.days ?? 30), 1), 365);
    const access = await dashboardAccess(request.user, request.query);
    const filter = resultFilter(access, 5);
    const p = [...scopeParams(request.user, s), days, ...filter.params];
    // Nur sichtbare Endpoints/Modelle (ohne Auswahl: nur Prod); mit Auswahl die gewählten Modelle und Endpoints, summiert.
    const base = `from results res join runs r on r.id = res.run_id
      where res.finished_at is not null
        and res.finished_at > now() - make_interval(days => $4::int)
        and ${scopeSql(1)}
        and ${filter.sql}`;

    const [kpis, trend, byType, perfByModel, profiles, recentFailures, regressions, runsCount, byUser, thinking, quality, loadRows] = await Promise.all([
      one(
        `select count(*)::int as results,
           count(*) filter (where res.status = 'passed')::int as passed,
           count(*) filter (where res.status = 'failed')::int as failed,
           count(*) filter (where res.status = 'error')::int as errored,
           avg(res.score) as avg_score,
           avg((res.metrics->>'ttft_ms_p95')::numeric) filter (where res.type = 'performance') as ttft_ms_p95,
           avg((res.metrics->>'tokens_per_s_avg')::numeric) filter (where res.type = 'performance') as tokens_per_s,
           avg(res.score) filter (where res.type = 'security') as security_score,
           count(*) filter (where res.status <> 'passed' and res.finished_at > now() - interval '24 hours')::int as failing_24h
         ${base}`,
        p,
      ),
      many(
        `select date_trunc('day', res.finished_at) as day,
           count(*) filter (where res.status = 'passed')::int as passed,
           count(*) filter (where res.status = 'failed')::int as failed,
           count(*) filter (where res.status = 'error')::int as errored
         ${base} group by 1 order by 1`,
        p,
      ),
      many(
        `select res.type, count(*)::int as total,
           count(*) filter (where res.status = 'passed')::int as passed, avg(res.score) as avg_score
         ${base} group by 1 order by 1`,
        p,
      ),
      many(
        `select date_trunc('day', res.finished_at) as day, coalesce(res.model_alias, res.model) as model,
           avg((res.metrics->>'ttft_ms_p95')::numeric) as ttft_ms_p95,
           avg((res.metrics->>'latency_ms_p95')::numeric) as latency_ms_p95,
           avg((res.metrics->>'tokens_per_s_avg')::numeric) as tokens_per_s
         ${base} and res.type = 'performance' and res.model is not null group by 1, 2 order by 1`,
        p,
      ),
      // Profil je Modell: Kennzahlen für Netzdiagramm, Modelltabelle und die Bestenkacheln.
      many(
        `select coalesce(res.model_alias, res.model) as model, count(*)::int as results, count(distinct res.run_id)::int as runs,
           count(distinct res.endpoint_id)::int as endpoints,
           count(*) filter (where res.status = 'passed')::float / nullif(count(*), 0) as pass_rate,
           avg((res.metrics->>'latency_ms_p50')::numeric) filter (where res.type = 'performance') as latency_ms,
           avg((res.metrics->>'ttft_ms_p95')::numeric) filter (where res.type = 'performance') as ttft_ms,
           avg((res.metrics->>'tokens_per_s_avg')::numeric) filter (where res.type = 'performance') as tokens_per_s,
           avg(res.score) filter (where res.type in ('quality', 'structured')) as quality,
           avg(res.score) filter (where res.type = 'coding') as coding,
           avg(res.score) filter (where res.type = 'ocr') as ocr,
           avg(least(1, greatest(0, (res.details->'variants'->0->>'reasoning_tokens_avg')::numeric
               / nullif((res.details->'variants'->0->>'completion_tokens_avg')::numeric, 0)))) filter (where res.type = 'thinking') as thinking_share
         ${base} and res.model is not null group by 1 order by runs desc, results desc limit 12`,
        p,
      ),
      many(
        `select res.id, res.run_id, res.test_name, res.type, res.model, res.status, res.error, res.finished_at,
           u.display_name as user_name
         ${base.replace('where', 'left join users u on u.id = r.user_id where')}
           and res.status in ('failed', 'error') order by res.finished_at desc limit 8`,
        p,
      ),
      one(
        `select count(*)::int as count ${base}
           and jsonb_array_length(coalesce(res.details->'regression'->'regressions', '[]'::jsonb)) > 0`,
        p,
      ),
      one(
        `select count(distinct res.run_id)::int as runs,
           (select count(*)::int from runs a where a.status in ('queued', 'running') and ${scopeSql(1, 'a')}) as active
         ${base}`,
        p,
      ),
      s.scope !== 'me'
        ? many(
            `select u.id, u.display_name, u.username, count(distinct r.id)::int as runs, count(res.id)::int as results,
               count(res.id) filter (where res.status = 'passed')::float / nullif(count(res.id), 0) as pass_rate,
               max(r.created_at) as last_run_at
             ${base.replace('where', 'join users u on u.id = r.user_id where')}
             group by u.id order by runs desc limit 20`,
            p,
          )
        : Promise.resolve([]),
      // Thinking vs. Non-Thinking: Mittelwerte je Modell über die Thinking-Tests im Zeitraum.
      many(
        `select coalesce(res.model_alias, res.model) as model, count(*)::int as results,
           avg((res.metrics->>'accuracy_gain')::numeric) as accuracy_gain,
           avg((res.metrics->>'token_factor')::numeric) as token_factor,
           avg((res.metrics->>'latency_factor')::numeric) as latency_factor,
           avg(res.score) as thinking_accuracy
         ${base} and res.type = 'thinking' and res.status <> 'error' group by 1 order by 1`,
        p,
      ),
      // Genauigkeit/Qualität für die Gauge.
      one(
        `select avg(res.score) as score, count(*)::int as results ${base}
           and res.type in ('quality', 'structured') and res.score is not null`,
        p,
      ),
      // Lasttests: Stufen mit Parallelität, Antwortzeit und Fehlerquote.
      many(
        `select res.id, coalesce(res.model_alias, res.model) as model, res.finished_at, res.details->'stages' as stages
         ${base} and res.type = 'load' and jsonb_typeof(res.details->'stages') = 'array'
         order by res.finished_at desc limit 200`,
        p,
      ),
    ]);

    // Lastpunkte (Parallelität × Antwortzeit) und Lastwert: Anteil erfolgreicher Anfragen, gewichtet damit,
    // wie stabil die Antwortzeit von der ersten zur letzten Stufe bleibt.
    const loadPoints = [];
    const loadScores = new Map();
    for (const row of loadRows) {
      const stages = row.stages ?? [];
      for (const st of stages) {
        if (st.latency_ms_p95 == null) continue;
        loadPoints.push({
          model: row.model ?? 'unbekannt',
          concurrency: st.concurrency,
          latency_ms_p50: st.latency_ms_p50,
          latency_ms_p95: st.latency_ms_p95,
          error_rate: st.error_rate,
          requests_per_s: st.requests_per_s,
        });
      }
      const first = stages.find((st) => st.latency_ms_p95 != null);
      const last = [...stages].reverse().find((st) => st.latency_ms_p95 != null);
      if (first && last) {
        const requests = stages.reduce((n, st) => n + st.requests, 0);
        const errors = stages.reduce((n, st) => n + st.errors, 0);
        const stability = last.latency_ms_p95 > 0 ? Math.min(1, first.latency_ms_p95 / last.latency_ms_p95) : 1;
        const list = loadScores.get(row.model) ?? [];
        list.push((requests ? 1 - errors / requests : 1) * stability);
        loadScores.set(row.model, list);
      }
    }
    for (const m of profiles) {
      const list = loadScores.get(m.model) ?? [];
      m.load_score = list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
    }

    return {
      scope: s.scope === 'all' ? 'global' : s.scope,
      teamId: s.teamId,
      days,
      kpis: {
        ...kpis,
        ...runsCount,
        pass_rate: kpis.results ? kpis.passed / kpis.results : null,
        regressions: regressions.count,
      },
      trend,
      byType,
      perfByModel,
      profiles,
      recentFailures,
      byUser,
      thinking,
      quality,
      loadPoints,
      selection: { models: access.selModels, endpoints: access.selEndpoints, isDefault: !access.selected },
    };
  });
}
