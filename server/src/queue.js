// Job-Queue und Cron-Scheduling über pg-boss (nutzt dieselbe Postgres, kein Redis nötig).
import { PgBoss } from 'pg-boss';
import { config } from './config.js';

export const QUEUES = { run: 'test-run', scheduled: 'scheduled-run' };

let boss;

export async function getBoss() {
  if (!boss) {
    boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'pgboss' });
    boss.on('error', (err) => console.error('pg-boss:', err));
    await boss.start();
    for (const name of Object.values(QUEUES)) {
      // Läufe nicht automatisch wiederholen: ein halb gelaufener Lasttest soll nicht doppelt laufen.
      await boss.createQueue(name, { retryLimit: 0, expireInSeconds: 6 * 3600 }).catch((err) => {
        if (!/exists/i.test(err.message)) throw err;
      });
    }
  }
  return boss;
}

export async function enqueueRun(runId) {
  const b = await getBoss();
  return b.send(QUEUES.run, { runId });
}

// Schedule aus der DB in pg-boss spiegeln (Key = Schedule-ID).
export async function syncSchedule(schedule) {
  const b = await getBoss();
  if (schedule.enabled) {
    await b.schedule(QUEUES.scheduled, schedule.cron, { scheduleId: schedule.id }, {
      key: schedule.id,
      tz: schedule.timezone,
    });
  } else {
    await b.unschedule(QUEUES.scheduled, schedule.id);
  }
}

export async function removeSchedule(id) {
  const b = await getBoss();
  await b.unschedule(QUEUES.scheduled, id);
}

export async function stopBoss() {
  if (boss) await boss.stop({ graceful: true, timeout: 30_000 });
}
