// Worker: führt Testläufe aus der Queue aus und startet geplante Läufe.
// Läuft in Kubernetes als eigenes Deployment (skalierbar), lokal optional im Web-Prozess (RUN_WORKER=true).
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { one, query, pool } from './db.js';
import { migrate } from './migrate.js';
import { getBoss, QUEUES, stopBoss } from './queue.js';
import { executeRun } from './runner/executor.js';
import { createRun } from './runs.js';

export async function startWorker(logger = console) {
  const boss = await getBoss();

  // Nach einem Pod-Neustart hängengebliebene Läufe als Fehler markieren.
  await query(
    `update runs set status = 'error', finished_at = now()
     where status = 'running' and started_at < now() - interval '6 hours'`,
  );

  await boss.work(QUEUES.run, { localConcurrency: config.workerConcurrency }, async ([job]) => {
    logger.info(`Lauf ${job.data.runId} gestartet`);
    try {
      await executeRun(job.data.runId);
    } catch (err) {
      logger.error(`Lauf ${job.data.runId} abgebrochen: ${err.message}`);
      await query(`update runs set status = 'error', finished_at = now() where id = $1`, [job.data.runId]);
    }
  });

  await boss.work(QUEUES.scheduled, async ([job]) => {
    const schedule = await one('select * from schedules where id = $1 and enabled', [job.data.scheduleId]);
    if (!schedule) return;
    await createRun({
      kind: schedule.target_kind === 'test' ? 'single' : schedule.target_kind,
      trigger: 'schedule',
      testIds: schedule.test_id ? [schedule.test_id] : undefined,
      suiteId: schedule.suite_id,
      scheduleId: schedule.id,
      userId: schedule.owner_id,
      label: `${schedule.name} (geplant)`,
    });
    await query('update schedules set last_run_at = now() where id = $1', [schedule.id]);
  });

  logger.info(`Worker bereit (Parallelität ${config.workerConcurrency})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if ((process.env.MIGRATE_ON_START ?? 'true') === 'true') await migrate();
  await startWorker();
  const shutdown = async () => {
    await stopBoss();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
