// Läufe einsehen, abbrechen, Gate für CI/CD und Nachweise. Rohdaten aus Angriffstests sehen nur Berechtigte.
import { logAudit } from '../audit.js';
import { analyzeRun } from '../analysis.js';
import { hasPermission, requirePermission } from '../auth.js';
import { many, one, query } from '../db.js';
import { verifyRun } from '../findings.js';
import { loadAudits, canSeeAudit } from '../audits.js';
import { canSeeRunOf, resolveScope, scopeParams, scopeSql } from '../scope.js';

const err = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// Ergebnisse mit Sensitivität "attack" ohne security.payloads: nur Fallnamen und Urteile, keine Prompts und Antworten.
export function maskResult(user, r) {
  if (r.sensitivity !== 'attack' || hasPermission(user, 'security.payloads')) return r;
  const cases = Array.isArray(r.details?.cases) ? r.details.cases.map((c) => ({ name: c.name, category: c.category, ok: c.ok, expect: c.expect, blocked: c.blocked, severity: c.severity })) : undefined;
  const { samples, ...rest } = r.details ?? {};
  return { ...r, details: { ...rest, ...(cases ? { cases } : {}), masked: true } };
}

export function gateOf(run, results) {
  const failOn = run.gate?.fail_on ?? ['security_finding', 'technical_error'];
  const counts = { ...(run.outcomes ?? {}), regression: results.filter((r) => r.details?.regression?.regressions?.length).length };
  const finished = ['passed', 'failed', 'error', 'cancelled'].includes(run.status);
  const reasons = failOn.filter((k) => counts[k] > 0).map((k) => ({ outcome: k, count: counts[k] }));
  return { finished, status: run.status, pass: finished && run.status !== 'cancelled' && reasons.length === 0, fail_on: failOn, counts, reasons };
}

export default async function runRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const starter = { preHandler: requirePermission('runs.start') };

  async function loadRun(request) {
    const run = await one('select r.*, u.display_name as user_name, a.name as audit_name, p.name as platform_name, p.environment as platform_environment from runs r left join users u on u.id = r.user_id left join audits a on a.id = r.audit_id left join platforms p on p.id = r.platform_id where r.id = $1 and r.tenant_id = $2', [request.params.id, request.user.tenant_id]);
    if (!run || !(await canSeeRunOf(request.user, run.user_id))) throw err('Lauf nicht gefunden', 404);
    return run;
  }

  // Liste: Läufe des Mandanten (Entwurfsläufe nur mit ?drafts=1 und nur eigene).
  app.get('/api/runs', viewer, async (request) => {
    const q = request.query;
    const s = resolveScope(request.user, q, 'all');
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(Math.max(Number(q.pageSize ?? 25), 1), 100);
    const drafts = q.drafts === '1';
    const days = q.days ? Math.min(Math.max(Number(q.days), 1), 365) : null;
    const params = [...scopeParams(request.user, s), request.user.tenant_id, drafts, q.audit_id || null, q.platform_id || null, q.status || null, days, q.search ? `%${q.search}%` : null, ['dev', 'prod'].includes(q.environment) ? q.environment : null];
    const where = `${scopeSql(1)} and r.tenant_id = $4 and (($5 and r.is_draft and r.user_id = $2) or (not $5 and not r.is_draft))
      and ($6::uuid is null or r.audit_id = $6) and ($7::uuid is null or r.platform_id = $7) and ($8::text is null or r.status = $8 or ($8 = 'active' and r.status in ('queued', 'running')))
      and ($9::int is null or r.created_at > now() - make_interval(days => $9::int)) and ($10::text is null or r.label ilike $10)
      and ($11::text is null or exists (select 1 from platforms px where px.id = r.platform_id and px.environment = $11))`;
    const [{ total }] = await many(`select count(*)::int as total from runs r where ${where}`, params);
    const rows = await many(
      `select r.id, r.kind, r.trigger, r.label, r.status, r.audit_id, r.platform_id, r.total, r.passed, r.failed, r.errored, r.outcomes, r.is_draft, r.created_at, r.started_at, r.finished_at,
         r.analysis_status, r.evidence_hash is not null as sealed, u.display_name as user_name, a.name as audit_name, p.name as platform_name, p.environment as platform_environment,
         (select count(*)::int from results x where x.run_id = r.id and jsonb_array_length(coalesce(x.details->'regression'->'regressions', '[]'::jsonb)) > 0) as regressions
       from runs r left join users u on u.id = r.user_id left join audits a on a.id = r.audit_id left join platforms p on p.id = r.platform_id
       where ${where} order by r.created_at desc limit ${pageSize} offset ${(page - 1) * pageSize}`,
      params,
    );
    return { total, page, pageSize, runs: rows, scope: s.scope, teamId: s.teamId };
  });

  app.get('/api/runs/:id', viewer, async (request) => {
    const run = await loadRun(request);
    const results = (await many('select * from results where run_id = $1 order by item_index, started_at', [run.id])).map((r) => maskResult(request.user, r));
    const report = await one('select id, status from reports where run_id = $1', [run.id]);
    const { plan, ...rest } = run;
    return { ...rest, plan_size: plan.length, results, report, gate: gateOf(run, results) };
  });

  app.get('/api/runs/:id/logs', viewer, async (request) => {
    const run = await loadRun(request);
    return many('select * from run_logs where run_id = $1 and id > $2 order by id limit 1000', [run.id, Number(request.query.after ?? 0)]);
  });

  // CI/CD: Ergebnis des Laufs als Bestanden/Nicht bestanden gemäß Gate der Prüfung.
  app.get('/api/runs/:id/gate', viewer, async (request) => {
    const run = await loadRun(request);
    const results = await many('select details from results where run_id = $1', [run.id]);
    return { run_id: run.id, label: run.label, ...gateOf(run, results) };
  });

  app.post('/api/runs/:id/analysis', starter, async (request) => {
    const run = await loadRun(request);
    if (['queued', 'running'].includes(run.status)) throw err('Der Lauf ist noch nicht beendet', 409);
    await query(`update runs set analysis_status = 'pending' where id = $1`, [run.id]);
    analyzeRun(run.id, request.log).catch(() => {});
    return { ok: true };
  });

  // Nur Administratoren: der Lauf samt Ergebnissen, Logs und Nachweisen wird endgültig gelöscht.
  app.delete('/api/runs/:id', { preHandler: requirePermission('suite.view') }, async (request) => {
    if (!request.user.is_admin) throw err('Nur Administratoren dürfen Läufe löschen', 403);
    const run = await loadRun(request);
    if (['queued', 'running'].includes(run.status)) throw err('Der Lauf ist noch aktiv; bitte zuerst abbrechen', 409);
    await query('delete from runs where id = $1', [run.id]);
    await logAudit(request, 'run.delete', 'run', run.id, { label: run.label, status: run.status });
    return { ok: true };
  });

  app.post('/api/runs/:id/cancel', starter, async (request) => {
    const run = await loadRun(request);
    if (run.user_id !== request.user.id && !hasPermission(request.user, 'runs.manage_all')) throw err('Nur eigene Läufe können abgebrochen werden', 403);
    await query(`update runs set status = 'cancelled', finished_at = now() where id = $1 and status in ('queued', 'running')`, [run.id]);
    await logAudit(request, 'run.cancel', 'run', run.id, {});
    return { ok: true };
  });

  // Nachweise: Prompt, Antwort und Bewertung mit Hash. Angriffsinhalte nur mit security.payloads.
  app.get('/api/runs/:id/evidence', viewer, async (request) => {
    const run = await loadRun(request);
    const rows = await many('select id, result_id, case_key, prompt, response, assessment, ok, hash, sensitivity, retain_until, purged_at, created_at from evidence where run_id = $1 order by created_at, id', [run.id]);
    const mayReveal = hasPermission(request.user, 'security.payloads');
    return {
      evidence_hash: run.evidence_hash,
      items: rows.map((e) => (e.sensitivity === 'attack' && !mayReveal ? { ...e, prompt: null, response: null, assessment: { ok: e.ok }, masked: true } : e)),
    };
  });

  app.get('/api/runs/:id/evidence/verify', viewer, async (request) => {
    const run = await loadRun(request);
    return verifyRun(run.id);
  });

  // Prüfungen für den Filter der Läufe-Seite.
  app.get('/api/run-filters', viewer, async (request) => {
    const audits = (await loadAudits(request.user.tenant_id)).filter((a) => canSeeAudit(request.user, a)).map((a) => ({ id: a.id, name: a.name }));
    const platforms = await many('select id, name, environment from platforms where tenant_id = $1 order by name', [request.user.tenant_id]);
    return { audits, platforms };
  });
}
