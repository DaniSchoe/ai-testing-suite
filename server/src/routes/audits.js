// Prüfungen: Ziel, Vorlagen in fester Version, Modelle mit Pfad, Schwellwerte, Baseline, Zeitplan, Freigaben und Kill-Switch.
import { CronExpressionParser } from 'cron-parser';
import { logAudit } from '../audit.js';
import { hasPermission, requirePermission } from '../auth.js';
import { many, one, query, tx } from '../db.js';
import { canEditAudit, canSeeAudit, describeItems, estimateRuntime, loadAudits } from '../audits.js';
import { canSeeTemplate } from '../catalog.js';
import { validateThresholds } from '../evaluate.js';
import { buildPlan, validateModels } from '../plan.js';
import { removeSchedule, syncSchedule } from '../queue.js';
import { approvalNeeds, createAuditRun, effectiveLimits, err, validApproval } from '../runs.js';
import { resolveScope, scopeParams, scopeSql } from '../scope.js';
import { canSeeKey } from '../visibility.js';
import { loadKeys } from './apikeys.js';

const CRON = /^(\S+\s+){4}\S+$/;
const VISIBILITIES = ['private', 'teams', 'global'];
const GATE_OUTCOMES = ['security_finding', 'quality_deviation', 'technical_error', 'regression'];

export default async function auditRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const editor = { preHandler: requirePermission('tests.manage') };
  const starter = { preHandler: requirePermission('runs.start') };
  const scheduler = { preHandler: requirePermission('schedules.manage') };
  const approver = { preHandler: requirePermission('runs.prod') };

  const visible = async (user, id) => {
    const a = (await loadAudits(user.tenant_id, id))[0];
    if (!a || !canSeeAudit(user, a)) throw err('Prüfung nicht gefunden', 404);
    return a;
  };
  const withRights = (user, a) => ({ ...a, can_edit: canEditAudit(user, a), mine: a.created_by === user.id });

  async function assertKeyUsable(user, keyId, currentKeyId) {
    if (!keyId || user.is_admin || keyId === currentKeyId) return;
    const key = (await loadKeys(user.tenant_id)).find((k) => k.id === keyId);
    if (!key || !canSeeKey(user, key)) throw err('Dieser API-Key steht dir nicht zur Verfügung', 403);
  }

  // Eingabe in Positionen auflösen: Vorlagenversionen (feste Versionen).
  async function resolveItems(user, raw, existing = []) {
    if (!Array.isArray(raw) || !raw.length) throw err('Mindestens eine Vorlage auswählen');
    const out = [];
    const known = new Set(existing.map((i) => i.template_version_id));
    for (const r of raw) {
      const ids = [];
      if (r.template_version_id) ids.push({ template_version_id: r.template_version_id, thresholds: r.thresholds, endpoint_id: r.endpoint_id });
      else throw err('Position ohne Vorlage');
      for (const it of ids) {
        const v = await one(
          `select v.id, v.status, v.spec, t.tenant_id, t.origin, t.team_id, t.owner_id, t.name from template_versions v join templates t on t.id = v.template_id where v.id = $1`,
          [it.template_version_id],
        );
        if (!v || !(await canSeeTemplate(user, v))) throw err('Vorlage nicht gefunden', 404);
        if (v.status !== 'published' && !known.has(v.id)) throw err(`Vorlage „${v.name}“ ist nicht veröffentlicht`);
        const thresholds = it.thresholds === undefined ? (v.spec?.suggested_thresholds ?? []) : validateThresholds(it.thresholds);
        out.push({ template_version_id: v.id, ...(it.endpoint_id ? { endpoint_id: it.endpoint_id } : {}), thresholds });
      }
    }
    return out;
  }

  function validateBody(b) {
    if (!b.name?.trim()) throw err('Name fehlt');
    if (!b.platform_id) throw err('Plattform (Ziel) fehlt');
    const repeats = Number(b.repeats ?? 1);
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw err('Wiederholungen: 1 bis 20');
    const mode = b.mode ?? 'standard';
    if (!['standard', 'compare'].includes(mode)) throw err('Ungültiger Modus');
    let compare = null;
    if (mode === 'compare') {
      const c = b.compare ?? {};
      if (c.kind === 'models') {
        if (!c.a || !c.b || c.a === c.b) throw err('Vergleich: zwei verschiedene Modelle wählen');
        compare = { kind: 'models', a: c.a, b: c.b, path: c.path ?? 'gateway' };
      } else if (c.kind === 'paths') {
        if (!c.model) throw err('Vergleich: ein Modell wählen (direkt gegen Gateway)');
        compare = { kind: 'paths', model: c.model };
      } else throw err('Vergleich: Art muss „models“ oder „paths“ sein');
    }
    const tol = Number(b.regression_tolerance ?? 0.2);
    if (!(tol >= 0 && tol <= 5)) throw err('Toleranz außerhalb des Bereichs');
    const visibility = b.visibility ?? 'private';
    if (!VISIBILITIES.includes(visibility)) throw err('Ungültige Sichtbarkeit');
    const failOn = (b.gate?.fail_on ?? ['security_finding', 'technical_error']).filter((x) => GATE_OUTCOMES.includes(x));
    const limits = {};
    for (const k of ['max_concurrency', 'max_duration_s']) if (Number(b.load_limits?.[k]) > 0) limits[k] = Math.floor(Number(b.load_limits[k]));
    return { repeats, mode, compare, tol, visibility, gate: { fail_on: failOn }, limits };
  }

  app.get('/api/audits', viewer, async (request) => {
    const q = request.query;
    return (await loadAudits(request.user.tenant_id))
      .filter((a) => canSeeAudit(request.user, a) && (!q.platform_id || a.platform_id === q.platform_id))
      .map((a) => withRights(request.user, a));
  });

  app.get('/api/audits/:id', viewer, async (request) => {
    const a = await visible(request.user, request.params.id);
    const [items, runs, approvals, teams] = await Promise.all([
      describeItems(a.items),
      many(
        `select r.id, r.status, r.kind, r.created_at, r.finished_at, r.total, r.passed, r.failed, r.errored, r.outcomes, coalesce(u.display_name, u.username) as user_name
         from runs r left join users u on u.id = r.user_id where r.audit_id = $1 and not r.is_draft order by r.created_at desc limit 15`,
        [a.id],
      ),
      many(
        `select ap.*, coalesce(u.display_name, u.username) as requested_by_name, coalesce(d.display_name, d.username) as decided_by_name
         from approvals ap left join users u on u.id = ap.requested_by left join users d on d.id = ap.decided_by where ap.audit_id = $1 order by ap.requested_at desc limit 10`,
        [a.id],
      ),
      a.teamIds.length ? many('select id, name from teams where id = any($1::uuid[])', [a.teamIds]) : [],
    ]);
    return { ...withRights(request.user, a), items, runs, approvals, teams };
  });

  // Vorschau: Anzahl der Einzeltests, nicht anwendbare Kombinationen, geschätzte Laufzeit, Freigabebedarf.
  app.post('/api/audits/preview', editor, async (request) => {
    const b = request.body ?? {};
    const v = validateBody({ ...b, name: b.name || 'Vorschau' });
    const items = await resolveItems(request.user, b.items, []);
    const models = validateModels(b.models ?? []);
    const platform = await one('select * from platforms where id = $1 and tenant_id = $2', [b.platform_id, request.user.tenant_id]);
    if (!platform) throw err('Plattform nicht gefunden');
    const plan = await buildPlan({ platformId: platform.id, models, items, repeats: v.repeats, mode: v.mode, compare: v.compare, limits: v.limits });
    return {
      ...(await estimateRuntime(plan)),
      not_applicable: plan.filter((a) => !a.applicable).map((a) => ({ name: a.name, reason: a.reason })),
      approval_needed: approvalNeeds(platform, plan),
    };
  });

  async function save(request, id) {
    const b = request.body ?? {};
    const user = request.user;
    const v = validateBody(b);
    const existing = id ? await visible(user, id) : null;
    if (existing && !canEditAudit(user, existing)) throw err('Nur Ersteller, Maintainer oder Administratoren dürfen die Prüfung ändern', 403);
    const platform = await one('select id from platforms where id = $1 and tenant_id = $2', [b.platform_id, user.tenant_id]);
    if (!platform) throw err('Plattform nicht gefunden');
    await assertKeyUsable(user, b.api_key_id, existing?.api_key_id);
    const models = validateModels(b.models ?? []);
    const items = await resolveItems(user, b.items, existing?.items ?? []);
    const needsModels = items.length > 0;
    if (needsModels && !models.length && v.mode !== 'compare') {
      // Plattform- und MCP-Prüfungen kommen ohne Modell aus; alles andere braucht mindestens eines.
      const types = await many('select t.type from template_versions tv join templates t on t.id = tv.template_id where tv.id = any($1)', [items.map((i) => i.template_version_id)]);
      if (types.some((t) => !['mcp', 'access', 'smoke'].includes(t.type))) throw err('Mindestens ein Modell auswählen');
    }
    const teamIds = v.visibility === 'teams' ? [...new Set(b.teamIds ?? [])] : [];
    if (v.visibility === 'teams') {
      if (!teamIds.length) throw err('Mindestens ein Team auswählen');
      const own = (user.teams ?? []).map((t) => t.id);
      if (!user.is_admin && teamIds.some((t) => !own.includes(t))) throw err('Du kannst nur für Teams freigeben, in denen du Mitglied bist', 403);
    }
    const tags = (b.tags ?? []).map((t) => String(t).trim()).filter(Boolean);
    const values = [b.name.trim(), b.description?.trim() || null, tags, b.maintainer_id || null, b.platform_id, JSON.stringify(models), JSON.stringify(items), v.repeats, v.mode, v.compare ? JSON.stringify(v.compare) : null, v.tol, JSON.stringify(v.limits), JSON.stringify(v.gate), v.visibility, b.api_key_id || null, Boolean(b.baseline_auto ?? true)];
    const row = await tx(async (c) => {
      const { rows } = id
        ? await c.query(
            `update audits set name = $2, description = $3, tags = $4, maintainer_id = $5, platform_id = $6, models = $7, items = $8, repeats = $9, mode = $10, compare = $11,
               regression_tolerance = $12, load_limits = $13, gate = $14, visibility = $15, api_key_id = $16, baseline_auto = $17, updated_at = now() where id = $1 returning id`,
            [id, ...values],
          )
        : await c.query(
            `insert into audits (name, description, tags, maintainer_id, platform_id, models, items, repeats, mode, compare, regression_tolerance, load_limits, gate, visibility, api_key_id, baseline_auto, created_by, tenant_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) returning id`,
            [...values, user.id, user.tenant_id],
          );
      await c.query('delete from audit_teams where audit_id = $1', [rows[0].id]);
      if (teamIds.length) await c.query('insert into audit_teams select $1, unnest($2::uuid[])', [rows[0].id, teamIds]);
      return rows[0];
    });
    await logAudit(request, id ? 'audit.update' : 'audit.create', 'audit', row.id, { name: b.name });
    return withRights(user, await visible(user, row.id));
  }

  app.post('/api/audits', editor, async (request) => save(request, null));
  app.put('/api/audits/:id', editor, async (request) => save(request, request.params.id));

  app.delete('/api/audits/:id', viewer, async (request) => {
    const a = await visible(request.user, request.params.id);
    if (!canEditAudit(request.user, a)) throw err('Nur Ersteller, Maintainer oder Administratoren dürfen die Prüfung löschen', 403);
    if (a.schedule_id) await removeSchedule(a.schedule_id);
    await query('delete from audits where id = $1', [a.id]);
    await logAudit(request, 'audit.delete', 'audit', a.id, { name: a.name });
    return { ok: true };
  });

  // Neuere Version einer Vorlage bewusst übernehmen. Schwellwerte bleiben, die Baseline sollte danach neu gesetzt werden.
  app.post('/api/audits/:id/items/:index/update', editor, async (request) => {
    const a = await visible(request.user, request.params.id);
    if (!canEditAudit(request.user, a)) throw err('Keine Berechtigung', 403);
    const idx = Number(request.params.index);
    const item = a.items[idx];
    if (!item) throw err('Position nicht gefunden', 404);
    const described = (await describeItems(a.items))[idx];
    if (!described.update_available) throw err('Es gibt keine neuere veröffentlichte Version');
    const items = a.items.map((it, i) => (i === idx ? { ...it, template_version_id: described.update_available.version_id } : it));
    await query('update audits set items = $2, updated_at = now() where id = $1', [a.id, JSON.stringify(items)]);
    await logAudit(request, 'audit.adopt_version', 'audit', a.id, { template: described.key, from: described.version, to: described.update_available.version });
    return withRights(request.user, await visible(request.user, a.id));
  });

  app.get('/api/audits/:id/preflight', viewer, async (request) => {
    const a = await visible(request.user, request.params.id);
    const platform = await one('select * from platforms where id = $1', [a.platform_id]);
    if (!platform) throw err('Plattform fehlt');
    const approval = await validApproval(a.id);
    const plan = await buildPlan({ platformId: platform.id, models: a.models, items: a.items, repeats: a.repeats, mode: a.mode, compare: a.compare, limits: effectiveLimits(a.load_limits, approval?.limits) });
    const needs = approvalNeeds(platform, plan);
    const pending = await one(`select id, requested_at from approvals where audit_id = $1 and status = 'pending' order by requested_at desc limit 1`, [a.id]);
    return {
      ...(await estimateRuntime(plan)),
      platform: { id: platform.id, name: platform.name, environment: platform.environment, locked: platform.locked, locked_reason: platform.locked_reason },
      approval_needed: needs,
      approval: approval ? { id: approval.id, window_to: approval.window_to, runs_left: approval.runs_allowed - approval.runs_used, limits: approval.limits } : null,
      approval_pending: pending,
      not_applicable: plan.filter((x) => !x.applicable).map((x) => ({ name: x.name, reason: x.reason })),
      can_start: !platform.locked && (!needs.length || Boolean(approval)),
    };
  });

  app.post('/api/audits/:id/run', starter, async (request) => {
    const a = await visible(request.user, request.params.id);
    const keyId = request.body?.api_key_id || null;
    await assertKeyUsable(request.user, keyId, null);
    const trigger = /^Bearer sat_/.test(request.headers.authorization ?? '') ? 'api' : 'manual';
    const run = await createAuditRun({ audit: a, user: request.user, trigger, apiKeyId: keyId });
    await logAudit(request, 'run.start', 'run', run.id, { audit: a.name, environment: a.platform_environment, trigger });
    return run;
  });

  // Baseline festlegen (ausdrücklich, durch Menschen) oder entfernen.
  app.post('/api/audits/:id/baseline', editor, async (request) => {
    const a = await visible(request.user, request.params.id);
    if (!canEditAudit(request.user, a)) throw err('Keine Berechtigung', 403);
    const runId = request.body?.run_id;
    if (runId) {
      const run = await one(`select id, status from runs where id = $1 and audit_id = $2 and status in ('passed', 'failed')`, [runId, a.id]);
      if (!run) throw err('Lauf nicht gefunden oder noch nicht abgeschlossen', 404);
    }
    await query('update audits set baseline_run_id = $2, baseline_set_by = $3, baseline_set_at = now(), baseline_auto = $4 where id = $1', [a.id, runId ?? null, request.user.id, runId ? false : Boolean(request.body?.auto)]);
    await logAudit(request, runId ? 'audit.baseline_set' : 'audit.baseline_clear', 'audit', a.id, { run_id: runId ?? null });
    return withRights(request.user, await visible(request.user, a.id));
  });

  // --- Zeitpläne ---
  app.get('/api/schedules', viewer, async (request) => {
    const rows = await many(
      `select sc.*, a.name as audit_name, u.display_name as owner_name from schedules sc join audits a on a.id = sc.audit_id left join users u on u.id = sc.owner_id
       where sc.tenant_id = $1 and ($2::uuid is null or sc.audit_id = $2) order by sc.name`,
      [request.user.tenant_id, request.query.audit_id || null],
    );
    return rows;
  });

  function validateSchedule(b) {
    if (!b.audit_id) throw err('Prüfung fehlt');
    if (b.run_at) {
      const at = new Date(b.run_at);
      if (Number.isNaN(at.getTime())) throw err('Zeitpunkt ungültig');
      if (at <= new Date()) throw err('Der Zeitpunkt liegt in der Vergangenheit');
    } else {
      if (!CRON.test(b.cron?.trim() ?? '')) throw err('Cron-Ausdruck muss 5 Felder haben, z. B. "0 6 * * *"');
      try {
        CronExpressionParser.parse(b.cron.trim());
      } catch {
        throw err('Cron-Ausdruck ist ungültig');
      }
    }
  }

  async function saveSchedule(request, id) {
    const b = request.body ?? {};
    validateSchedule(b);
    const a = await visible(request.user, b.audit_id);
    const existing = id ? await one('select * from schedules where id = $1 and tenant_id = $2', [id, request.user.tenant_id]) : null;
    if (id && !existing) throw err('Zeitplan nicht gefunden', 404);
    if (existing && existing.owner_id !== request.user.id && !hasPermission(request.user, 'runs.manage_all')) throw err('Nur Besitzer oder Administratoren dürfen den Zeitplan ändern', 403);
    // Ein Zeitplan je Prüfung.
    await query('delete from schedules where audit_id = $1 and id is distinct from $2', [a.id, id ?? null]);
    const values = [b.name?.trim() || a.name, a.id, b.run_at ? null : b.cron.trim(), b.run_at ? new Date(b.run_at) : null, b.timezone || 'Europe/Berlin', b.enabled ?? true];
    const row = id
      ? await one('update schedules set name = $2, audit_id = $3, cron = $4, run_at = $5, timezone = $6, enabled = $7 where id = $1 returning *', [id, ...values])
      : await one(`insert into schedules (name, target_kind, audit_id, cron, run_at, timezone, enabled, owner_id, tenant_id) values ($1, 'audit', $2, $3, $4, $5, $6, $7, $8) returning *`, [...values, request.user.id, request.user.tenant_id]);
    await syncSchedule(row);
    await logAudit(request, 'schedule.save', 'schedule', row.id, { audit: a.name, cron: row.cron, run_at: row.run_at });
    return row;
  }
  app.post('/api/schedules', scheduler, async (request) => saveSchedule(request, null));
  app.put('/api/schedules/:id', scheduler, async (request) => saveSchedule(request, request.params.id));
  app.delete('/api/schedules/:id', scheduler, async (request) => {
    const existing = await one('select owner_id from schedules where id = $1 and tenant_id = $2', [request.params.id, request.user.tenant_id]);
    if (!existing) return { ok: true };
    if (existing.owner_id !== request.user.id && !hasPermission(request.user, 'runs.manage_all')) throw err('Nur Besitzer oder Administratoren dürfen den Zeitplan löschen', 403);
    await query('delete from schedules where id = $1', [request.params.id]);
    await removeSchedule(request.params.id);
    return { ok: true };
  });

  // Kalender: geplante Ausführungen (ab jetzt) und bisherige Läufe im Zeitraum.
  app.get('/api/calendar', viewer, async (request) => {
    const from = new Date(request.query.from);
    const to = new Date(request.query.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw err('Zeitraum ungültig');
    if (to - from > 62 * 86400_000) throw err('Zeitraum zu groß (maximal 62 Tage)');
    const user = request.user;
    const audits = new Map((await loadAudits(user.tenant_id)).filter((a) => canSeeAudit(user, a)).map((a) => [a.id, a]));
    const schedules = await many('select * from schedules where tenant_id = $1 and enabled', [user.tenant_id]);
    const events = [];
    const now = new Date();
    for (const sc of schedules) {
      const audit = audits.get(sc.audit_id);
      if (!audit) continue;
      const base = { kind: 'planned', schedule_id: sc.id, audit_id: audit.id, title: audit.name, recurring: Boolean(sc.cron), environment: audit.platform_environment };
      if (sc.run_at) {
        const at = new Date(sc.run_at);
        if (at >= from && at < to && at > now) events.push({ ...base, at: at.toISOString() });
        continue;
      }
      try {
        const it = CronExpressionParser.parse(sc.cron, { currentDate: from > now ? from : now, endDate: to, tz: sc.timezone });
        for (let n = 0; n < 500 && it.hasNext(); n++) events.push({ ...base, at: it.next().toDate().toISOString() });
      } catch {
        /* ungültiger Cron-Ausdruck: kein Eintrag */
      }
    }
    const s = resolveScope(user, request.query, 'all');
    const runs = await many(
      `select r.id, r.label, r.status, r.trigger, r.audit_id, r.created_at, r.finished_at, r.total, r.passed, r.failed, r.errored
       from runs r where r.tenant_id = $6 and not r.is_draft and r.created_at >= $4 and r.created_at < $5 and ${scopeSql(1)} order by r.created_at limit 1000`,
      [...scopeParams(user, s), from, to, user.tenant_id],
    );
    for (const r of runs) events.push({ kind: 'run', run_id: r.id, audit_id: r.audit_id, title: r.label, status: r.status, trigger: r.trigger, at: r.created_at, finished_at: r.finished_at, total: r.total, failed: r.failed + r.errored });
    return events.sort((a, b) => new Date(a.at) - new Date(b.at));
  });

  // --- Freigaben ---
  // Eine Freigabe sehen Antragsteller, zugewiesene Person, Mitglieder des zugewiesenen Teams mit Freigaberecht und Administratoren.
  // Ohne Zuweisung sehen sie alle mit Freigaberecht. Entscheiden dürfen nur die Berechtigten (nicht der Antragsteller).
  const mayDecide = (user, ap) => {
    if (!(user.is_admin || hasPermission(user, 'runs.prod'))) return false;
    if (user.is_admin) return true;
    if (ap.assigned_user_id) return ap.assigned_user_id === user.id;
    if (ap.assigned_team_id) return (user.teams ?? []).some((t) => t.id === ap.assigned_team_id);
    return true;
  };
  const mayView = (user, ap) => ap.requested_by === user.id || mayDecide(user, ap);

  async function listApprovals(user, { status = null, platformId = null } = {}) {
    const rows = await many(
      `select ap.*, a.name as audit_name, p.name as platform_name, p.environment, coalesce(u.display_name, u.username) as requested_by_name, coalesce(d.display_name, d.username) as decided_by_name,
         t.name as assigned_team_name, coalesce(au.display_name, au.username) as assigned_user_name
       from approvals ap join audits a on a.id = ap.audit_id left join platforms p on p.id = ap.platform_id
       left join users u on u.id = ap.requested_by left join users d on d.id = ap.decided_by
       left join teams t on t.id = ap.assigned_team_id left join users au on au.id = ap.assigned_user_id
       where ap.tenant_id = $1 and ($2::text is null or ap.status = $2) and ($3::uuid is null or ap.platform_id = $3) order by ap.requested_at desc limit 200`,
      [user.tenant_id, status, platformId],
    );
    return rows.filter((ap) => mayView(user, ap)).map((ap) => ({ ...ap, can_decide: ap.status === 'pending' && ap.requested_by !== user.id && mayDecide(user, ap) }));
  }

  app.get('/api/approvals', viewer, async (request) => listApprovals(request.user, { status: request.query.status || null, platformId: request.query.platform_id || null }));

  // Anzahl offener Freigaben, die der angemeldete User entscheiden kann (Hinweis in der Navigation).
  app.get('/api/approvals/summary', viewer, async (request) => {
    const open = await listApprovals(request.user, { status: 'pending', platformId: request.query.platform_id || null });
    return { pending: open.filter((ap) => ap.can_decide).length };
  });

  app.post('/api/audits/:id/approvals', starter, async (request) => {
    const a = await visible(request.user, request.params.id);
    const b = request.body ?? {};
    const pending = await one(`select id from approvals where audit_id = $1 and status = 'pending'`, [a.id]);
    if (pending) throw err('Für diese Prüfung liegt bereits ein offener Antrag vor', 409);
    const team = b.assigned_team_id ? await one('select id from teams where id = $1', [b.assigned_team_id]) : null;
    if (b.assigned_team_id && !team) throw err('Team nicht gefunden');
    const assignee = b.assigned_user_id ? await one('select id from users where id = $1', [b.assigned_user_id]) : null;
    if (b.assigned_user_id && !assignee) throw err('Person nicht gefunden');
    if (assignee?.id === request.user.id) throw err('Vier-Augen-Prinzip: Der Antrag kann nicht an die antragstellende Person gehen');
    const row = await one(
      `insert into approvals (tenant_id, audit_id, platform_id, requested_by, request_note, window_from, window_to, limits, runs_allowed, assigned_team_id, assigned_user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`,
      [
        request.user.tenant_id,
        a.id,
        a.platform_id,
        request.user.id,
        b.note?.slice(0, 1000) ?? null,
        b.window_from ? new Date(b.window_from) : null,
        b.window_to ? new Date(b.window_to) : null,
        JSON.stringify(effectiveLimits(b.limits)),
        Math.min(Math.max(Number(b.runs_allowed) || 1, 1), 1000),
        team?.id ?? null,
        assignee?.id ?? null,
      ],
    );
    await logAudit(request, 'approval.request', 'approval', row.id, { audit: a.name });
    return row;
  });

  // Vier-Augen-Prinzip: wer beantragt hat, darf nicht entscheiden.
  app.post('/api/approvals/:id/decision', approver, async (request) => {
    const ap = await one(`select * from approvals where id = $1 and tenant_id = $2`, [request.params.id, request.user.tenant_id]);
    if (!ap) throw err('Freigabe nicht gefunden', 404);
    if (ap.status !== 'pending') throw err('Der Antrag ist bereits entschieden', 409);
    if (!mayDecide(request.user, ap)) throw err('Dieser Antrag ist einem anderen Team bzw. einer anderen Person zugewiesen', 403);
    if (ap.requested_by === request.user.id) throw err('Vier-Augen-Prinzip: Eigene Anträge können nicht selbst freigegeben werden', 403);
    const b = request.body ?? {};
    if (!['approve', 'reject'].includes(b.decision)) throw err('Entscheidung muss approve oder reject sein');
    const limits = b.limits ? effectiveLimits(b.limits) : ap.limits;
    const row = await one(
      `update approvals set status = $2, decided_by = $3, decided_at = now(), decision_note = $4, window_from = $5, window_to = $6, limits = $7, runs_allowed = $8 where id = $1 returning *`,
      [
        ap.id,
        b.decision === 'approve' ? 'approved' : 'rejected',
        request.user.id,
        b.note?.slice(0, 1000) ?? null,
        b.window_from === undefined ? ap.window_from : b.window_from ? new Date(b.window_from) : null,
        b.window_to === undefined ? ap.window_to : b.window_to ? new Date(b.window_to) : null,
        JSON.stringify(limits),
        b.runs_allowed ? Math.min(Math.max(Number(b.runs_allowed), 1), 1000) : ap.runs_allowed,
      ],
    );
    await logAudit(request, `approval.${b.decision}`, 'approval', ap.id, { audit_id: ap.audit_id });
    return row;
  });

  app.post('/api/approvals/:id/revoke', approver, async (request) => {
    const row = await one(`update approvals set status = 'revoked', decided_by = $2, decided_at = now() where id = $1 and tenant_id = $3 and status in ('pending', 'approved') returning *`, [request.params.id, request.user.id, request.user.tenant_id]);
    if (!row) throw err('Freigabe nicht gefunden', 404);
    await logAudit(request, 'approval.revoke', 'approval', row.id, {});
    return row;
  });

  // --- Kill-Switch ---
  app.post('/api/platforms/:id/lock', approver, async (request) => {
    const p = await one('select id, name from platforms where id = $1 and tenant_id = $2', [request.params.id, request.user.tenant_id]);
    if (!p) throw err('Plattform nicht gefunden', 404);
    await query('update platforms set locked = true, locked_reason = $2, locked_by = $3, locked_at = now() where id = $1', [p.id, request.body?.reason?.slice(0, 300) ?? null, request.user.id]);
    const cancelled = await query(`update runs set status = 'cancelled', finished_at = now() where platform_id = $1 and status in ('queued', 'running')`, [p.id]);
    await logAudit(request, 'platform.lock', 'platform', p.id, { name: p.name, reason: request.body?.reason ?? null, cancelled_runs: cancelled.rowCount });
    return { ok: true, cancelled_runs: cancelled.rowCount };
  });

  app.post('/api/platforms/:id/unlock', approver, async (request) => {
    const p = await one('select id, name from platforms where id = $1 and tenant_id = $2', [request.params.id, request.user.tenant_id]);
    if (!p) throw err('Plattform nicht gefunden', 404);
    await query('update platforms set locked = false, locked_reason = null, locked_by = null, locked_at = null where id = $1', [p.id]);
    await logAudit(request, 'platform.unlock', 'platform', p.id, { name: p.name });
    return { ok: true };
  });
}
