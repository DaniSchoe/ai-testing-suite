import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { stopBoss } from './queue.js';
import { startWorker } from './worker.js';

const app = await buildApp();

if ((process.env.MIGRATE_ON_START ?? 'true') === 'true') await migrate(app.log);
if (config.runWorker) await startWorker(app.log);

await app.listen({ port: config.port, host: config.host });

const shutdown = async () => {
  await app.close();
  await stopBoss();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
