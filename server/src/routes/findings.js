// Findings (Sicherheits- und Plattformbefunde mit Status und Nachtest) und Prüfberichte.
import { logAudit } from '../audit.js';
import { hasPermission, requirePermission } from '../auth.js';
import { many, one, query } from '../db.js';
import { FINDING_STATUS, SEVERITIES } from '../findings.js';
import { loadAudits } from '../audits.js';
import { reportHtml, reportMarkdown } from '../reports.js';
import { createAuditRun } from '../runs.js';
import { ensureReport } from '../reports.js';

const err = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export default async function findingRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const manager = { preHandler: requirePermission('findings.manage') };

  // Kunden-Viewer sehen Findings ohne Rohdaten (Prompts und Antworten).
  const redact = (user, f) => {
    if (hasPermission(user, 'security.payloads')) return f;
    const { evidence, ...rest } = f;
    return { ...rest, evidence: evidence ? { hash: evidence.hash, masked: true } : null };
  };

  app.get('/api/findings', viewer, async (request) => {
    const q = request.query;
    const rows = await many(
      `select f.*, p.name as platform_name, coalesce(u.display_name, u.username) as owner_name, a.name as audit_name
       from findings f left join platforms p on p.id = f.platform_id left join users u on u.id = f.owner_id left join audits a on a.id = f.audit_id
       where f.tenant_id = $1 and ($2::text is null or f.status = $2) and ($3::text is null or f.severity = $3) and ($4::uuid is null or f.platform_id = $4)
         and ($5::text is null or f.framework = $5) and ($6::text is null or f.category = $6) and ($7::text is null or f.title ilike $7 or f.model ilike $7)
         and ($8::boolean is not true or f.status in ('open', 'in_progress'))
       order by array_position(array['critical','high','medium','low','info'], f.severity), f.last_seen_at desc limit 500`,
      [request.user.tenant_id, q.status || null, q.severity || null, q.platform_id || null, q.framework || null, q.category || null, q.q ? `%${q.q}%` : null, q.open === '1'],
    );
    return rows.map((f) => redact(request.user, f));
  });

  app.get('/api/findings/stats', viewer, async (request) => {
    const rows = await many(`select severity, status, count(*)::int as n from findings where tenant_id = $1 group by 1, 2`, [request.user.tenant_id]);
    return { by: rows, open: rows.filter((r) => ['open', 'in_progress'].includes(r.status)).reduce((n, r) => n + r.n, 0) };
  });

  async function load(request) {
    const f = await one('select f.*, p.name as platform_name, coalesce(u.display_name, u.username) as owner_name from findings f left join platforms p on p.id = f.platform_id left join users u on u.id = f.owner_id where f.id = $1 and f.tenant_id = $2', [request.params.id, request.user.tenant_id]);
    if (!f) throw err('Finding nicht gefunden', 404);
    return f;
  }

  app.get('/api/findings/:id', viewer, async (request) => {
    const f = await load(request);
    const events = await many(`select e.*, coalesce(u.display_name, u.username) as user_name from finding_events e left join users u on u.id = e.user_id where e.finding_id = $1 order by e.ts`, [f.id]);
    return { ...redact(request.user, f), events };
  });

  app.put('/api/findings/:id', manager, async (request) => {
    const f = await load(request);
    const b = request.body ?? {};
    if (b.status !== undefined && !FINDING_STATUS.includes(b.status)) throw err('Ungültiger Status');
    if (b.severity !== undefined && !SEVERITIES.includes(b.severity)) throw err('Ungültige Schwere');
    if (b.owner_id) {
      const member = await one('select 1 from user_roles where user_id = $1 and (tenant_id = $2 or tenant_id is null)', [b.owner_id, request.user.tenant_id]);
      if (!member) throw err('Verantwortliche Person ist kein Mitglied des Mandanten');
    }
    const row = await one(
      `update findings set status = $2, severity = $3, owner_id = $4, note = $5, updated_at = now() where id = $1 returning *`,
      [f.id, b.status ?? f.status, b.severity ?? f.severity, b.owner_id === undefined ? f.owner_id : b.owner_id || null, b.note === undefined ? f.note : b.note, ],
    );
    const changes = {};
    for (const k of ['status', 'severity', 'owner_id', 'note']) if (b[k] !== undefined && String(b[k] ?? '') !== String(f[k] ?? '')) changes[k] = { from: f[k], to: b[k] };
    if (Object.keys(changes).length) {
      await query(`insert into finding_events (finding_id, user_id, kind, data) values ($1, $2, 'update', $3)`, [f.id, request.user.id, JSON.stringify(changes)]);
      await logAudit(request, 'finding.update', 'finding', f.id, changes);
    }
    return row;
  });

  // Nachtest: nur die betroffene Vorlage, das Modell und den Pfad der Prüfung erneut ausführen.
  app.post('/api/findings/:id/retest', { preHandler: [requirePermission('findings.manage'), requirePermission('runs.start')] }, async (request) => {
    const f = await load(request);
    if (!f.audit_id) throw err('Die zugehörige Prüfung existiert nicht mehr');
    const audit = (await loadAudits(request.user.tenant_id, f.audit_id))[0];
    if (!audit) throw err('Die zugehörige Prüfung existiert nicht mehr');
    const run = await createAuditRun({ audit, user: request.user, kind: 'retest', label: `Nachtest: ${f.title}`, filter: { template_key: f.template_key, model: f.model ?? undefined, path: f.path ?? undefined } });
    await query(`update findings set retest_run_id = $2, retest_result = null, status = 'in_progress', updated_at = now() where id = $1`, [f.id, run.id]);
    await query(`insert into finding_events (finding_id, user_id, kind, data) values ($1, $2, 'retest_started', $3)`, [f.id, request.user.id, JSON.stringify({ run_id: run.id })]);
    await logAudit(request, 'finding.retest', 'finding', f.id, { run_id: run.id });
    return run;
  });

  // ---------------------------------------------------------------- Berichte
  // Kunden-Viewer sehen nur freigegebene Berichte.
  const sees = (user, r) => r.status === 'approved' || hasPermission(user, 'tests.manage') || hasPermission(user, 'reports.approve') || user.is_admin;

  app.get('/api/reports', viewer, async (request) => {
    const rows = await many(
      `select r.id, r.status, r.run_id, r.audit_id, r.created_at, r.updated_at, r.approved_at, r.body->'rating' as rating, r.body->'platform' as platform, a.name as audit_name, run.finished_at
       from reports r left join audits a on a.id = r.audit_id join runs run on run.id = r.run_id
       where r.tenant_id = $1 and ($2::text is null or r.status = $2) and ($3::text is null or r.body->'platform'->>'id' = $3) order by r.created_at desc limit 200`,
      [request.user.tenant_id, request.query.status || null, request.query.platform_id || null],
    );
    return rows.filter((r) => sees(request.user, r));
  });

  async function loadReport(request) {
    const r = await one(`select r.*, a.name as audit_name, coalesce(s.display_name, s.username) as submitted_by_name, coalesce(p.display_name, p.username) as approved_by_name from reports r left join audits a on a.id = r.audit_id left join users s on s.id = r.submitted_by left join users p on p.id = r.approved_by where r.id = $1 and r.tenant_id = $2`, [request.params.id, request.user.tenant_id]);
    if (!r || !sees(request.user, r)) throw err('Bericht nicht gefunden', 404);
    return r;
  }

  app.get('/api/reports/:id', viewer, async (request) => loadReport(request));

  app.get('/api/runs/:id/report', viewer, async (request) => {
    const run = await one('select id from runs where id = $1 and tenant_id = $2', [request.params.id, request.user.tenant_id]);
    if (!run) throw err('Lauf nicht gefunden', 404);
    let r = await one('select id from reports where run_id = $1', [run.id]);
    if (!r && hasPermission(request.user, 'tests.manage')) r = await ensureReport(run.id);
    if (!r) throw err('Für diesen Lauf gibt es keinen Bericht', 404);
    request.params.id = r.id;
    return loadReport(request);
  });

  const editorOf = { preHandler: requirePermission('tests.manage') };
  app.put('/api/reports/:id', editorOf, async (request) => {
    const r = await loadReport(request);
    if (r.status === 'approved') throw err('Ein freigegebener Bericht ist unveränderlich', 409);
    const summary = String(request.body?.summary ?? '').slice(0, 8000);
    return one('update reports set summary = $2, updated_at = now() where id = $1 returning *', [r.id, summary]);
  });

  app.post('/api/reports/:id/refresh', editorOf, async (request) => {
    const r = await loadReport(request);
    if (r.status !== 'draft') throw err('Nur Entwürfe können neu berechnet werden', 409);
    await ensureReport(r.run_id);
    return loadReport(request);
  });

  // Der KI-Entwurf wird nie automatisch übernommen: ein Reviewer übernimmt ihn ausdrücklich in die Summary.
  app.post('/api/reports/:id/adopt-ai', { preHandler: requirePermission('reports.approve') }, async (request) => {
    const r = await loadReport(request);
    if (r.status === 'approved') throw err('Ein freigegebener Bericht ist unveränderlich', 409);
    if (!r.ai_draft) throw err('Es gibt keinen KI-Entwurf');
    return one('update reports set summary = $2, updated_at = now() where id = $1 returning *', [r.id, r.ai_draft]);
  });

  app.post('/api/reports/:id/submit', editorOf, async (request) => {
    const r = await loadReport(request);
    if (r.status !== 'draft') throw err('Der Bericht ist nicht im Entwurf', 409);
    await query(`update reports set status = 'in_review', submitted_by = $2, submitted_at = now() where id = $1`, [r.id, request.user.id]);
    await logAudit(request, 'report.submit', 'report', r.id, {});
    return loadReport(request);
  });

  app.post('/api/reports/:id/approve', { preHandler: requirePermission('reports.approve') }, async (request) => {
    const r = await loadReport(request);
    if (r.status !== 'in_review') throw err('Der Bericht ist nicht im Review', 409);
    if (r.submitted_by === request.user.id) throw err('Vier-Augen-Prinzip: Eingereichtes kann nicht selbst freigegeben werden', 403);
    await query(`update reports set status = 'approved', approved_by = $2, approved_at = now(), approval_note = $3 where id = $1`, [r.id, request.user.id, request.body?.note ?? null]);
    await logAudit(request, 'report.approve', 'report', r.id, {});
    return loadReport(request);
  });

  app.post('/api/reports/:id/reject', { preHandler: requirePermission('reports.approve') }, async (request) => {
    const r = await loadReport(request);
    if (r.status !== 'in_review') throw err('Der Bericht ist nicht im Review', 409);
    await query(`update reports set status = 'draft', approval_note = $2 where id = $1`, [r.id, request.body?.note ?? null]);
    return loadReport(request);
  });

  app.get('/api/reports/:id/export', viewer, async (request, reply) => {
    const r = await loadReport(request);
    const format = request.query.format === 'md' ? 'md' : 'html';
    reply.header('content-type', format === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="pruefbericht-${r.id.slice(0, 8)}.${format}"`);
    return format === 'md' ? reportMarkdown(r) : reportHtml(r);
  });
}
