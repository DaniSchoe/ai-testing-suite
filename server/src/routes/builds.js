// Test-Builder: Tests mit Testarten, Modellen, Zeitplan und Veröffentlichung sowie der Zeitplan-Kalender.
import { CronExpressionParser } from 'cron-parser';
import { hasPermission, requirePermission } from '../auth.js';
import { many, one, query, tx } from '../db.js';
import { atomPlan, canEditBuild, canSeeBuild, estimateRuntime, syncAtoms } from '../builds.js';
import { removeSchedule, syncSchedule } from '../queue.js';
import { createRun } from '../runs.js';
import { resolveScope, scopeParams, scopeSql } from '../scope.js';
import { testTypes } from '../testtypes/index.js';
import { canSeeKey } from '../visibility.js';
import { loadKeys } from './apikeys.js';

const CRON = /^(\S+\s+){4}\S+$/;
const VISIBILITIES = ['private', 'teams', 'global'];

const err = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export async function loadBuilds() {
  const rows = await many(
    `select t.*, e.name as endpoint_name, e.kind as endpoint_kind, k.name as api_key_name,
       coalesce(u.display_name, u.username) as maintainer_name, coalesce(c.display_name, c.username) as creator_name,
       (select count(distinct res.run_id)::int from results res join test_definitions td on td.id = res.test_id where td.build_id = t.id) as run_count,
       (select count(*)::int from test_watchlist w where w.test_id = t.id) as watch_count,
       lr.status as last_status, lr.score as last_score, lr.finished_at as last_run_at,
       sc.id as schedule_id, sc.cron as schedule_cron, sc.run_at as schedule_run_at, sc.timezone as schedule_timezone,
       sc.enabled as schedule_enabled
     from tests t
     left join endpoints e on e.id = t.endpoint_id
     left join api_keys k on k.id = t.api_key_id
     left join users u on u.id = t.maintainer_id
     left join users c on c.id = t.created_by
     left join schedules sc on sc.build_id = t.id
     left join lateral (
       select res.status, res.score, res.finished_at from results res join test_definitions td on td.id = res.test_id
       where td.build_id = t.id and res.finished_at is not null order by res.finished_at desc limit 1
     ) lr on true
     order by t.name`,
  );
  const teams = await many('select test_id, team_id from test_teams');
  return rows.map((t) => ({ ...t, teamIds: teams.filter((x) => x.test_id === t.id).map((x) => x.team_id) }));
}

export default async function buildRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const editor = { preHandler: requirePermission('tests.manage') };
  const starter = { preHandler: requirePermission('runs.start') };

  const visibleBuild = async (user, id) => {
    const build = (await loadBuilds()).find((b) => b.id === id);
    if (!build || !canSeeBuild(user, build)) throw err('Test nicht gefunden', 404);
    return build;
  };

  const withRights = (user, b, watched = new Set()) => ({ ...b, can_edit: canEditBuild(user, b), mine: b.created_by === user.id, watched: watched.has(b.id) });
  const watchedBy = async (user) => new Set((await many('select test_id from test_watchlist where user_id = $1', [user.id])).map((r) => r.test_id));

  app.get('/api/builds', viewer, async (request) => {
    const watched = await watchedBy(request.user);
    return (await loadBuilds()).filter((b) => canSeeBuild(request.user, b)).map((b) => withRights(request.user, b, watched));
  });

  app.get('/api/builds/:id', viewer, async (request) =>
    withRights(request.user, await visibleBuild(request.user, request.params.id), await watchedBy(request.user)),
  );

  // Detailseite im Marketplace: Metadaten wie Endpoint, Modelle und Testarten (ohne Konfiguration) und die letzten Läufe.
  app.get('/api/marketplace/:id', viewer, async (request) => {
    const user = request.user;
    const build = await visibleBuild(user, request.params.id);
    const { configs, ...rest } = build;
    const runs = await many(
      `select r.id, r.status, r.created_at, r.finished_at, r.total, r.passed, r.failed, r.errored, coalesce(u.display_name, u.username) as user_name
       from runs r left join users u on u.id = r.user_id where r.build_id = $1 order by r.created_at desc limit 10`,
      [build.id],
    );
    const endpoint = await one('select name, kind, llm_flavor, environment from endpoints where id = $1', [build.endpoint_id]);
    const teams = build.teamIds.length ? await many('select id, name from teams where id = any($1::uuid[])', [build.teamIds]) : [];
    // Nur Berechtigte (Ersteller, Maintainer, Admin) sehen die Konfiguration.
    return { ...withRights(user, rest, await watchedBy(user)), endpoint, teams, runs, ...(canEditBuild(user, build) ? { configs } : {}) };
  });

  app.post('/api/builds/:id/watch', viewer, async (request) => {
    const build = await visibleBuild(request.user, request.params.id);
    await query('insert into test_watchlist (test_id, user_id) values ($1, $2) on conflict do nothing', [build.id, request.user.id]);
    return { ok: true };
  });
  app.delete('/api/builds/:id/watch', viewer, async (request) => {
    await query('delete from test_watchlist where test_id = $1 and user_id = $2', [request.params.id, request.user.id]);
    return { ok: true };
  });

  // Zusammenfassung im Builder: Anzahl der Einzeltests und geschätzte Laufzeit (Historie, sonst Richtwerte).
  app.post('/api/builds/preview', editor, async (request) => {
    const b = { ...request.body, name: request.body?.name || 'Test' };
    validate({ ...b, endpoint_id: b.endpoint_id || 'x' });
    return estimateRuntime(atomPlan({ name: b.name, types: b.types, models: b.models, configs: b.configs }), query);
  });

  function validate(b) {
    if (!b.name?.trim()) throw err('Name fehlt');
    if (!b.endpoint_id) throw err('Endpoint fehlt');
    if (!Array.isArray(b.types) || b.types.length === 0) throw err('Mindestens eine Testart auswählen');
    for (const type of b.types) if (!testTypes[type]) throw err(`Unbekannte Testart "${type}"`);
    if (b.configs && typeof b.configs !== 'object') throw err('Konfiguration muss ein Objekt sein');
  }

  async function assertEndpoint(user, b) {
    const e = await one('select kind, enabled from endpoints where id = $1', [b.endpoint_id]);
    if (!e) throw err('Endpoint existiert nicht');
    for (const type of b.types) {
      const kinds = testTypes[type].endpointKinds ?? ['ai_proxy', 'llm'];
      if (!kinds.includes(e.kind)) throw err(`Die Testart "${testTypes[type].label}" passt nicht zu diesem Endpoint`);
    }
  }

  async function assertKeyUsable(user, keyId, currentKeyId) {
    if (!keyId || user.is_admin || keyId === currentKeyId) return;
    const key = (await loadKeys()).find((k) => k.id === keyId);
    if (!key || !canSeeKey(user, key)) throw err('Dieser API-Key steht dir nicht zur Verfügung', 403);
  }

  // schedule: { mode: 'save' | 'now' | 'once' | 'recurring', run_at?, cron?, timezone? }
  function parseSchedule(user, s = {}) {
    const mode = s.mode ?? 'save';
    if (!['save', 'now', 'once', 'recurring'].includes(mode)) throw err('Ungültige Ausführungsart');
    if ((mode === 'once' || mode === 'recurring') && !hasPermission(user, 'schedules.manage')) throw err('Keine Berechtigung für Zeitpläne', 403);
    if (mode === 'now' && !hasPermission(user, 'runs.start')) throw err('Keine Berechtigung zum Starten von Läufen', 403);
    if (mode === 'once') {
      const at = new Date(s.run_at);
      if (Number.isNaN(at.getTime())) throw err('Zeitpunkt fehlt');
      if (at <= new Date()) throw err('Der Zeitpunkt liegt in der Vergangenheit');
    }
    if (mode === 'recurring') {
      if (!CRON.test(s.cron?.trim() ?? '')) throw err('Cron-Ausdruck muss 5 Felder haben, z. B. "0 6 * * *"');
      try {
        CronExpressionParser.parse(s.cron.trim());
      } catch {
        throw err('Cron-Ausdruck ist ungültig');
      }
    }
    return { mode, run_at: mode === 'once' ? new Date(s.run_at) : null, cron: mode === 'recurring' ? s.cron.trim() : null, timezone: s.timezone || 'Europe/Berlin' };
  }

  async function save(request, id) {
    const b = request.body ?? {};
    validate(b);
    const user = request.user;
    const sched = parseSchedule(user, b.schedule);
    await assertEndpoint(user, b);
    const existing = id ? await visibleBuild(user, id) : null;
    if (existing && !canEditBuild(user, existing)) throw err('Nur Ersteller, Maintainer oder Administratoren dürfen den Test ändern', 403);
    await assertKeyUsable(user, b.api_key_id, existing?.api_key_id);
    const models = [...new Set((b.models ?? []).map((m) => String(m).trim()).filter(Boolean))];
    const tags = (b.tags ?? []).map((t) => String(t).trim()).filter(Boolean);
    const values = [b.name.trim(), b.description?.trim() || null, tags, b.maintainer_id || null, b.endpoint_id, models, b.api_key_id || null, b.types, b.configs ?? {}];

    const { build, schedule } = await tx(async (c) => {
      const { rows } = id
        ? await c.query(
            `update tests set name = $2, description = $3, tags = $4, maintainer_id = $5, endpoint_id = $6, models = $7,
               api_key_id = $8, types = $9, configs = $10, updated_at = now() where id = $1 returning *`,
            [id, ...values],
          )
        : await c.query(
            `insert into tests (name, description, tags, maintainer_id, endpoint_id, models, api_key_id, types, configs, created_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
            [...values, user.id],
          );
      const build = rows[0];
      await syncAtoms(c, build);
      // Zeitplan des Tests: höchstens einer; "jetzt" und "nur speichern" entfernen ihn.
      await c.query('delete from schedules where build_id = $1', [build.id]);
      let schedule = null;
      if (sched.mode === 'once' || sched.mode === 'recurring') {
        schedule = (
          await c.query(
            `insert into schedules (name, target_kind, build_id, cron, run_at, timezone, enabled, owner_id)
             values ($1, 'build', $2, $3, $4, $5, true, $6) returning *`,
            [build.name, build.id, sched.cron, sched.run_at, sched.timezone, user.id],
          )
        ).rows[0];
      }
      return { build, schedule };
    });
    if (existing?.schedule_id) await removeSchedule(existing.schedule_id);
    if (schedule) await syncSchedule(schedule);
    const run = sched.mode === 'now' ? await createRun({ kind: 'build', buildId: build.id, userId: user.id }) : null;
    return { build: withRights(user, await visibleBuild(user, build.id)), run };
  }

  app.post('/api/builds', editor, async (request) => save(request, null));
  app.put('/api/builds/:id', editor, async (request) => save(request, request.params.id));

  app.delete('/api/builds/:id', viewer, async (request) => {
    const build = await visibleBuild(request.user, request.params.id);
    if (!canEditBuild(request.user, build)) throw err('Nur Ersteller, Maintainer oder Administratoren dürfen den Test löschen', 403);
    if (build.schedule_id) await removeSchedule(build.schedule_id);
    await query('delete from tests where id = $1', [build.id]);
    return { ok: true };
  });

  app.post('/api/builds/:id/run', starter, async (request) => {
    const user = request.user;
    const build = await visibleBuild(user, request.params.id);
    const keyId = request.body?.api_key_id || null;
    // Verlangt der Test einen eigenen Key, muss ihn jeder außer Ersteller und Maintainer mitbringen.
    if (build.requires_api_key && !keyId && !canEditBuild(user, build)) throw err('Dieser Test braucht deinen eigenen API-Key');
    await assertKeyUsable(user, keyId, null);
    return createRun({ kind: 'build', buildId: build.id, apiKeyId: keyId, userId: user.id });
  });

  // Veröffentlichen: nur für sich (private), für Teams (Mitglied) oder global.
  app.post('/api/builds/:id/publish', editor, async (request) => {
    const user = request.user;
    const build = await visibleBuild(user, request.params.id);
    if (!canEditBuild(user, build)) throw err('Nur Ersteller, Maintainer oder Administratoren dürfen veröffentlichen', 403);
    const b = request.body ?? {};
    const visibility = b.visibility ?? 'global';
    const requiresKey = Boolean(b.requires_api_key);
    if (!VISIBILITIES.includes(visibility)) throw err('Ungültige Sichtbarkeit');
    const teamIds = visibility === 'teams' ? [...new Set(b.teamIds ?? [])] : [];
    if (visibility === 'teams') {
      if (teamIds.length === 0) throw err('Mindestens ein Team auswählen');
      const own = (user.teams ?? []).map((t) => t.id);
      if (!user.is_admin && teamIds.some((t) => !own.includes(t))) throw err('Du kannst nur für Teams veröffentlichen, in denen du Mitglied bist', 403);
    }
    await tx(async (c) => {
      await c.query(
        `update tests set visibility = $2, requires_api_key = $3,
           published_at = case when $2 = 'private' then null else coalesce(published_at, now()) end, updated_at = now() where id = $1`,
        [build.id, visibility, requiresKey],
      );
      await c.query('delete from test_teams where test_id = $1', [build.id]);
      if (teamIds.length) await c.query('insert into test_teams select $1, unnest($2::uuid[])', [build.id, teamIds]);
    });
    return withRights(user, await visibleBuild(user, build.id));
  });

  app.post('/api/builds/:id/unpublish', viewer, async (request) => {
    const build = await visibleBuild(request.user, request.params.id);
    if (!canEditBuild(request.user, build)) throw err('Nur Ersteller, Maintainer oder Administratoren dürfen zurückziehen', 403);
    await query(`update tests set visibility = 'private', published_at = null, updated_at = now() where id = $1`, [build.id]);
    await query('delete from test_teams where test_id = $1', [build.id]);
    return withRights(request.user, await visibleBuild(request.user, build.id));
  });

  // Kalender: geplante Ausführungen (ab jetzt) und bisherige Läufe im Zeitraum.
  app.get('/api/calendar', viewer, async (request) => {
    const from = new Date(request.query.from);
    const to = new Date(request.query.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw err('Zeitraum ungültig');
    if (to - from > 62 * 86400_000) throw err('Zeitraum zu groß (maximal 62 Tage)');
    const user = request.user;
    const builds = (await loadBuilds()).filter((b) => canSeeBuild(user, b));
    const visibleBuilds = new Map(builds.map((b) => [b.id, b]));
    const schedules = await many(
      `select sc.*, s.name as suite_name, t.name as test_name from schedules sc
       left join suites s on s.id = sc.suite_id left join test_definitions t on t.id = sc.test_id where sc.enabled`,
    );
    const events = [];
    const now = new Date();
    for (const sc of schedules) {
      const build = sc.build_id ? visibleBuilds.get(sc.build_id) : null;
      // Zeitpläne ohne Test (Suite, alle Tests) sehen Besitzer und Administratoren.
      if (sc.build_id ? !build : !(user.is_admin || sc.owner_id === user.id)) continue;
      const title = build?.name ?? (sc.target_kind === 'all' ? 'Alle Tests' : (sc.suite_name ?? sc.test_name ?? sc.name));
      const base = { kind: 'planned', schedule_id: sc.id, build_id: sc.build_id, title, recurring: Boolean(sc.cron) };
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
    const s = resolveScope(user, request.query, 'me');
    const runs = await many(
      `select r.id, r.label, r.status, r.trigger, r.build_id, r.created_at, r.finished_at, r.total, r.passed, r.failed, r.errored
       from runs r where r.created_at >= $4 and r.created_at < $5 and ${scopeSql(1)} order by r.created_at limit 1000`,
      [...scopeParams(user, s), from, to],
    );
    for (const r of runs) {
      events.push({ kind: 'run', run_id: r.id, build_id: r.build_id, title: r.label, status: r.status, trigger: r.trigger, at: r.created_at, finished_at: r.finished_at, total: r.total, failed: r.failed + r.errored });
    }
    return events.sort((a, b) => new Date(a.at) - new Date(b.at));
  });
}
