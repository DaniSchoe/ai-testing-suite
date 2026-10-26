import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authPlugin } from './auth.js';
import { config } from './config.js';
import { pool } from './db.js';
import adminRoutes from './routes/admin.js';
import runRoutes from './routes/runs.js';
import testRoutes from './routes/tests.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: true, // hinter Ingress
  });

  app.setErrorHandler((err, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) request.log.error(err);
    reply.code(status).send({ error: status >= 500 ? 'Interner Fehler' : err.message });
  });

  // Probes für Kubernetes
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (request, reply) => {
    try {
      await pool.query('select 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  await app.register(authPlugin);

  app.get('/api/me', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'Nicht angemeldet', loginUrl: '/auth/login' });
    const { id, username, email, display_name, roles } = request.user;
    return { id, username, email, display_name, roles, authMode: config.auth.mode };
  });

  await app.register(adminRoutes);
  await app.register(testRoutes);
  await app.register(runRoutes);

  // Gebautes Frontend ausliefern; unbekannte Pfade gehen an die SPA.
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir });
    app.setNotFoundHandler((request, reply) => {
      if (/^\/(api|auth|assets)\//.test(request.url)) {
        return reply.code(404).send({ error: 'Nicht gefunden' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
