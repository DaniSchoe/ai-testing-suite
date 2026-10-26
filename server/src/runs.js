// Anlegen von Testläufen: einzeln, Auswahl, Suite oder "alle Tests".
import { many, one } from './db.js';
import { enqueueRun } from './queue.js';

export async function resolveTestIds({ kind, testIds, suiteId, buildId }) {
  if (kind === 'build') {
    const rows = await many('select id from test_definitions where build_id = $1 order by type, name', [buildId]);
    return rows.map((r) => r.id);
  }
  if (kind === 'single' || kind === 'selection') {
    const rows = await many('select id from test_definitions where id = any($1)', [testIds ?? []]);
    const valid = new Set(rows.map((r) => r.id));
    return (testIds ?? []).filter((id) => valid.has(id));
  }
  if (kind === 'suite') {
    const rows = await many(
      `select st.test_id from suite_tests st join test_definitions t on t.id = st.test_id
       where st.suite_id = $1 order by st.position, t.name`,
      [suiteId],
    );
    return rows.map((r) => r.test_id);
  }
  if (kind === 'all') {
    const rows = await many('select id from test_definitions order by type, name');
    return rows.map((r) => r.id);
  }
  throw new Error(`Unbekannte Laufart ${kind}`);
}

export async function createRun({ kind, trigger = 'manual', testIds, suiteId, buildId, scheduleId, userId, label }) {
  const ids = await resolveTestIds({ kind, testIds, suiteId, buildId });
  if (ids.length === 0) throw Object.assign(new Error('Keine Tests für diesen Lauf gefunden'), { statusCode: 400 });
  if (!label) {
    if (kind === 'build') label = (await one('select name from tests where id = $1', [buildId]))?.name;
    else if (kind === 'suite') label = (await one('select name from suites where id = $1', [suiteId]))?.name;
    else if (kind === 'single') label = (await one('select name from test_definitions where id = $1', [ids[0]]))?.name;
    else if (kind === 'all') label = 'Alle Tests';
    else label = `${ids.length} ausgewählte Tests`;
  }
  const run = await one(
    `insert into runs (kind, trigger, label, suite_id, build_id, schedule_id, user_id, test_ids, total)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
    [kind, trigger, label, suiteId ?? null, buildId ?? null, scheduleId ?? null, userId ?? null, ids, ids.length],
  );
  await enqueueRun(run.id);
  return run;
}
