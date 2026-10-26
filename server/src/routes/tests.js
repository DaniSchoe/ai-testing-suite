// Testdefinitionen, Suiten (gebündelte Läufe) und Schedules.
import { hasPermission, requirePermission } from '../auth.js';
import { many, one, query, tx } from '../db.js';
import { removeSchedule, syncSchedule } from '../queue.js';
import { canSeeKey } from '../visibility.js';
import { loadKeys } from './apikeys.js';
import { describeTypes, testTypes } from '../testtypes/index.js';

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

const CRON = /^(\S+\s+){4}\S+$/;

export default async function testRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const editor = { preHandler: requirePermission('tests.manage') };
  const scheduler = { preHandler: requirePermission('schedules.manage') };

  app.get('/api/test-types', viewer, async () => describeTypes());

  // --- Testdefinitionen ---
  app.get('/api/tests', viewer, async () =>
    many(
      `select t.*, e.name as endpoint_name, e.kind as endpoint_kind, k.name as api_key_name,
         lr.status as last_status, lr.score as last_score, lr.finished_at as last_run_at
       from test_definitions t
       left join endpoints e on e.id = t.endpoint_id
       left join api_keys k on k.id = t.api_key_id
       left join lateral (
         select status, score, finished_at from results where test_id = t.id and finished_at is not null
         order by finished_at desc limit 1
       ) lr on true
       order by t.type, t.name`,
    ),
  );

  app.get('/api/tests/:id', viewer, async (request, reply) => {
    const t = await one('select * from test_definitions where id = $1', [request.params.id]);
    if (!t) return reply.code(404).send({ error: 'Test nicht gefunden' });
    return t;
  });

  // Historie eines Tests für Trenddiagramme (Score und Kennzahlen über die Zeit).
  app.get('/api/tests/:id/history', viewer, async (request) =>
    many(
      `select id, run_id, status, score, metrics, model, duration_ms, finished_at
       from results where test_id = $1 and finished_at is not null
       order by finished_at desc limit $2`,
      [request.params.id, Math.min(Number(request.query.limit ?? 50), 500)],
    ),
  );

  function validateTest(b) {
    if (!b.name?.trim()) throw badRequest('Name fehlt');
    if (!testTypes[b.type]) throw badRequest(`Unbekannter Testtyp "${b.type}"`);
    if (!b.endpoint_id) throw badRequest('Endpoint fehlt');
    if (b.config && typeof b.config !== 'object') throw badRequest('Konfiguration muss ein Objekt sein');
  }

  // Nur Keys verwenden, die der User sehen darf (eigene, Team-Keys, globale; Administratoren alle).
  async function assertKeyUsable(user, keyId) {
    if (!keyId || user.is_admin) return;
    const key = (await loadKeys()).find((k) => k.id === keyId);
    if (!key || !canSeeKey(user, key)) throw Object.assign(new Error('Dieser API-Key steht dir nicht zur Verfügung'), { statusCode: 403 });
  }

  app.post('/api/tests', editor, async (request) => {
    const b = request.body ?? {};
    validateTest(b);
    await assertKeyUsable(request.user, b.api_key_id);
    return one(
      `insert into test_definitions (name, type, endpoint_id, api_key_id, config, tags, enabled, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [b.name.trim(), b.type, b.endpoint_id, b.api_key_id || null, b.config ?? {}, b.tags ?? [], b.enabled ?? true, request.user.id],
    );
  });

  app.put('/api/tests/:id', editor, async (request, reply) => {
    const b = request.body ?? {};
    validateTest(b);
    const current = await one('select api_key_id from test_definitions where id = $1', [request.params.id]);
    // Ein bereits gesetzter Key darf bleiben, auch wenn der Bearbeiter ihn nicht sehen kann.
    if (b.api_key_id !== current?.api_key_id) await assertKeyUsable(request.user, b.api_key_id);
    const row = await one(
      `update test_definitions set name = $2, type = $3, endpoint_id = $4, api_key_id = $5, config = $6,
         tags = $7, enabled = $8, updated_at = now() where id = $1 returning *`,
      [request.params.id, b.name.trim(), b.type, b.endpoint_id, b.api_key_id || null, b.config ?? {}, b.tags ?? [], b.enabled ?? true],
    );
    if (!row) return reply.code(404).send({ error: 'Test nicht gefunden' });
    return row;
  });

  app.delete('/api/tests/:id', editor, async (request) => {
    await query('delete from test_definitions where id = $1', [request.params.id]);
    return { ok: true };
  });

  // --- Suiten ---
  app.get('/api/suites', viewer, async () =>
    many(
      `select s.*, coalesce(array_agg(st.test_id order by st.position) filter (where st.test_id is not null), '{}') as test_ids
       from suites s left join suite_tests st on st.suite_id = s.id
       group by s.id order by s.name`,
    ),
  );

  async function saveSuite(client, id, testIds) {
    await client.query('delete from suite_tests where suite_id = $1', [id]);
    for (const [i, testId] of (testIds ?? []).entries()) {
      await client.query('insert into suite_tests (suite_id, test_id, position) values ($1, $2, $3)', [id, testId, i]);
    }
  }

  app.post('/api/suites', editor, async (request) => {
    const b = request.body ?? {};
    if (!b.name?.trim()) throw badRequest('Name fehlt');
    return tx(async (client) => {
      const { rows } = await client.query(
        'insert into suites (name, description, created_by) values ($1, $2, $3) returning *',
        [b.name.trim(), b.description ?? null, request.user.id],
      );
      await saveSuite(client, rows[0].id, b.test_ids);
      return { ...rows[0], test_ids: b.test_ids ?? [] };
    });
  });

  app.put('/api/suites/:id', editor, async (request) => {
    const b = request.body ?? {};
    if (!b.name?.trim()) throw badRequest('Name fehlt');
    return tx(async (client) => {
      const { rows } = await client.query('update suites set name = $2, description = $3 where id = $1 returning *', [
        request.params.id,
        b.name.trim(),
        b.description ?? null,
      ]);
      await saveSuite(client, request.params.id, b.test_ids);
      return { ...rows[0], test_ids: b.test_ids ?? [] };
    });
  });

  app.delete('/api/suites/:id', editor, async (request) => {
    await query('delete from suites where id = $1', [request.params.id]);
    return { ok: true };
  });

  // --- Schedules ---
  app.get('/api/schedules', viewer, async () =>
    many(
      `select sc.*, s.name as suite_name, t.name as test_name, u.display_name as owner_name
       from schedules sc
       left join suites s on s.id = sc.suite_id
       left join test_definitions t on t.id = sc.test_id
       left join users u on u.id = sc.owner_id
       order by sc.name`,
    ),
  );

  function validateSchedule(b) {
    if (!b.name?.trim()) throw badRequest('Name fehlt');
    if (!CRON.test(b.cron?.trim() ?? '')) throw badRequest('Cron-Ausdruck muss 5 Felder haben, z. B. "0 6 * * *"');
    if (b.target_kind === 'test' && !b.test_id) throw badRequest('Test fehlt');
    if (b.target_kind === 'suite' && !b.suite_id) throw badRequest('Suite fehlt');
    if (!['test', 'suite', 'all'].includes(b.target_kind)) throw badRequest('Ungültiges Ziel');
  }

  app.post('/api/schedules', scheduler, async (request) => {
    const b = request.body ?? {};
    validateSchedule(b);
    const row = await one(
      `insert into schedules (name, target_kind, test_id, suite_id, cron, timezone, enabled, owner_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [
        b.name.trim(),
        b.target_kind,
        b.target_kind === 'test' ? b.test_id : null,
        b.target_kind === 'suite' ? b.suite_id : null,
        b.cron.trim(),
        b.timezone || 'Europe/Berlin',
        b.enabled ?? true,
        request.user.id,
      ],
    );
    await syncSchedule(row);
    return row;
  });

  app.put('/api/schedules/:id', scheduler, async (request, reply) => {
    const b = request.body ?? {};
    validateSchedule(b);
    const existing = await one('select owner_id from schedules where id = $1', [request.params.id]);
    if (!existing) return reply.code(404).send({ error: 'Schedule nicht gefunden' });
    if (existing.owner_id !== request.user.id && !hasPermission(request.user, 'runs.manage_all')) {
      return reply.code(403).send({ error: 'Nur Besitzer oder Admin dürfen den Schedule ändern' });
    }
    const row = await one(
      `update schedules set name = $2, target_kind = $3, test_id = $4, suite_id = $5, cron = $6, timezone = $7, enabled = $8
       where id = $1 returning *`,
      [
        request.params.id,
        b.name.trim(),
        b.target_kind,
        b.target_kind === 'test' ? b.test_id : null,
        b.target_kind === 'suite' ? b.suite_id : null,
        b.cron.trim(),
        b.timezone || 'Europe/Berlin',
        b.enabled ?? true,
      ],
    );
    await syncSchedule(row);
    return row;
  });

  app.delete('/api/schedules/:id', scheduler, async (request, reply) => {
    const existing = await one('select owner_id from schedules where id = $1', [request.params.id]);
    if (existing && existing.owner_id !== request.user.id && !hasPermission(request.user, 'runs.manage_all')) {
      return reply.code(403).send({ error: 'Nur Besitzer oder Admin dürfen den Schedule löschen' });
    }
    await query('delete from schedules where id = $1', [request.params.id]);
    await removeSchedule(request.params.id);
    return { ok: true };
  });
}
