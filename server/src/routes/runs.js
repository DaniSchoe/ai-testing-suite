// Testläufe starten und einsehen, Ergebnistabelle ("Meine Tests") und Dashboard-Auswertungen.
import { hasRole, requireRole } from '../auth.js';
import { many, one, query } from '../db.js';
import { createRun } from '../runs.js';

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
  const viewer = { preHandler: requireRole('viewer') };
  const tester = { preHandler: requireRole('tester') };

  // body: { kind: 'single'|'selection'|'suite'|'all', testIds?, suiteId? }
  app.post('/api/runs', tester, async (request) => {
    const b = request.body ?? {};
    return createRun({ kind: b.kind, testIds: b.testIds, suiteId: b.suiteId, userId: request.user.id, label: b.label });
  });

  app.get('/api/runs', viewer, async (request) => {
    const scope = request.query.scope === 'all' ? 'all' : 'me';
    const limit = Math.min(Number(request.query.limit ?? 50), 200);
    return many(
      `select r.*, u.display_name as user_name from runs r left join users u on u.id = r.user_id
       where ($1 = 'all' or r.user_id = $2) order by r.created_at desc limit $3`,
      [scope, request.user.id, limit],
    );
  });

  app.get('/api/runs/:id', viewer, async (request, reply) => {
    const run = await one(
      `select r.*, u.display_name as user_name from runs r left join users u on u.id = r.user_id where r.id = $1`,
      [request.params.id],
    );
    if (!run) return reply.code(404).send({ error: 'Lauf nicht gefunden' });
    const results = await many('select * from results where run_id = $1 order by started_at', [run.id]);
    return { ...run, results };
  });

  // Logs inkrementell abrufen (?after=<letzte id>), das Frontend pollt während der Lauf aktiv ist.
  app.get('/api/runs/:id/logs', viewer, async (request) =>
    many('select * from run_logs where run_id = $1 and id > $2 order by id limit 1000', [
      request.params.id,
      Number(request.query.after ?? 0),
    ]),
  );

  app.post('/api/runs/:id/cancel', tester, async (request, reply) => {
    const run = await one('select user_id, status from runs where id = $1', [request.params.id]);
    if (!run) return reply.code(404).send({ error: 'Lauf nicht gefunden' });
    if (run.user_id !== request.user.id && !hasRole(request.user, 'admin')) {
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
    const scope = q.scope === 'all' && hasRole(request.user, 'viewer') ? 'all' : 'me';
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(Number(q.pageSize ?? 25), 200);
    const sort = RESULT_SORT[q.sort] ?? RESULT_SORT.started_at;
    const dir = q.dir === 'asc' ? 'asc' : 'desc';
    const params = [scope, request.user.id, q.type || null, q.status || null, q.search ? `%${q.search}%` : null];
    const where = `($1 = 'all' or r.user_id = $2)
      and ($3::text is null or res.type = $3)
      and ($4::text is null or res.status = $4)
      and ($5::text is null or res.test_name ilike $5 or res.model ilike $5 or res.endpoint_name ilike $5)`;
    const [{ total }] = await many(
      `select count(*)::int as total from results res join runs r on r.id = res.run_id where ${where}`,
      params,
    );
    const rows = await many(
      `select res.id, res.run_id, res.test_id, res.test_name, res.type, res.endpoint_name, res.model, res.persona_name,
         res.status, res.score, res.duration_ms, res.metrics, res.error, res.started_at, res.finished_at,
         (jsonb_array_length(coalesce(res.details->'regression'->'regressions', '[]'::jsonb)) > 0) as regression,
         r.trigger, r.label as run_label, u.display_name as user_name
       from results res join runs r on r.id = res.run_id left join users u on u.id = r.user_id
       where ${where}
       order by ${sort} ${dir} nulls last
       limit ${pageSize} offset ${(page - 1) * pageSize}`,
      params,
    );
    return { total, page, pageSize, rows };
  });

  app.get('/api/results/:id', viewer, async (request, reply) => {
    const row = await one('select * from results where id = $1', [request.params.id]);
    if (!row) return reply.code(404).send({ error: 'Ergebnis nicht gefunden' });
    return row;
  });

  // Dashboard: global (alle User) oder nur eigene Läufe, über einen Zeitraum in Tagen.
  app.get('/api/dashboard', viewer, async (request) => {
    const scope = request.query.scope === 'me' ? 'me' : 'global';
    const days = Math.min(Math.max(Number(request.query.days ?? 30), 1), 365);
    const p = [scope, request.user.id, days];
    const base = `from results res join runs r on r.id = res.run_id
      where res.finished_at is not null
        and res.finished_at > now() - make_interval(days => $3::int)
        and ($1 = 'global' or r.user_id = $2)`;

    const [kpis, trend, byType, perfByModel, models, recentFailures, regressions, runsCount, byUser, thinking] = await Promise.all([
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
      many(
        `select coalesce(res.model_alias, res.model) as model, count(*)::int as results,
           count(distinct res.endpoint_id)::int as endpoints,
           avg(res.score) filter (where res.type in ('quality', 'structured')) as quality_score,
           avg(res.score) filter (where res.type = 'security') as security_score,
           avg((res.metrics->>'ttft_ms_p95')::numeric) as ttft_ms_p95,
           avg((res.metrics->>'tokens_per_s_avg')::numeric) as tokens_per_s,
           count(*) filter (where res.status = 'passed')::float / nullif(count(*), 0) as pass_rate
         ${base} and res.model is not null and res.type not in ('comparison', 'thinking') group by 1 order by 2 desc limit 12`,
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
        `select count(*)::int as runs,
           count(*) filter (where r.status in ('queued', 'running'))::int as active
         from runs r where r.created_at > now() - make_interval(days => $3::int) and ($1 = 'global' or r.user_id = $2)`,
        p,
      ),
      scope === 'global'
        ? many(
            `select u.id, u.display_name, u.username, count(distinct r.id)::int as runs, count(res.id)::int as results,
               count(res.id) filter (where res.status = 'passed')::float / nullif(count(res.id), 0) as pass_rate,
               max(r.created_at) as last_run_at
             from runs r join users u on u.id = r.user_id left join results res on res.run_id = r.id
             where r.created_at > now() - make_interval(days => $1::int)
             group by u.id order by runs desc limit 20`,
            [days],
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
    ]);

    return {
      scope,
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
      models,
      recentFailures,
      byUser,
      thinking,
    };
  });
}
