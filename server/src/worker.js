// Worker: führt Testläufe aus der Queue aus und startet geplante Läufe.
// Läuft in Kubernetes als eigenes Deployment (skalierbar), lokal optional im Web-Prozess (RUN_WORKER=true).
import { fileURLToPath } from 'node:url';
import { hasPermission, loadUser } from './auth.js';
import { config } from './config.js';
import { one, query, pool } from './db.js';
import { migrate } from './migrate.js';
import { getBoss, QUEUES, stopBoss } from './queue.js';
import { syncAllModels } from './models.js';
import { executeRun } from './runner/executor.js';
import { createRun } from './runs.js';

// Mit MIGRATE_ON_START=false (Helm) migriert ein Job. Der Worker wartet, bis das Schema da ist,
// statt mit "relation does not exist" abzustürzen.
async function waitForSchema(logger, timeoutS = 300) {
  for (let waited = 0; ; waited += 5) {
    const row = await one(`select to_regclass('public.runs') is not null as ready`).catch(() => null);
    if (row?.ready) return;
    if (waited >= timeoutS) throw new Error('Datenbankschema fehlt: Migration (Job "migrate") ist nicht durchgelaufen');
    if (waited % 30 === 0) logger.info('Warte auf Datenbankmigration…');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

export async function startWorker(logger = console) {
  await waitForSchema(logger);
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
    if (schedule.run_at && new Date(schedule.run_at).toISOString() !== job.data.runAt) return; // Zeitpunkt wurde geändert
    // Zeitpläne laufen mit den Rechten ihres Besitzers: gesperrt oder ohne runs.start = kein Lauf.
    const owner = schedule.owner_id ? await loadUser(schedule.owner_id) : null;
    if (owner && !hasPermission(owner, 'runs.start')) {
      logger.warn(`Zeitplan ${schedule.name} übersprungen: Besitzer gesperrt oder ohne Berechtigung runs.start`);
      return;
    }
    await createRun({
      kind: schedule.target_kind === 'test' ? 'single' : schedule.target_kind,
      trigger: 'schedule',
      testIds: schedule.test_id ? [schedule.test_id] : undefined,
      suiteId: schedule.suite_id,
      buildId: schedule.build_id,
      scheduleId: schedule.id,
      userId: schedule.owner_id,
      label: `${schedule.name} (geplant)`,
    });
    // Einmalige Zeitpläne sind danach erledigt.
    await query('update schedules set last_run_at = now(), enabled = enabled and run_at is null where id = $1', [schedule.id]);
  });

  // Modellkatalog regelmäßig mit LiteLLM und den vLLM-Endpunkten abgleichen.
  await boss.work(QUEUES.modelSync, async () => syncAllModels(logger));
  await boss.schedule(QUEUES.modelSync, process.env.MODEL_SYNC_CRON ?? '*/15 * * * *');
  syncAllModels(logger).catch((err) => logger.warn(`Modellabruf: ${err.message}`));

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
