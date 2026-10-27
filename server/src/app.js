import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authPlugin } from './auth.js';
import { config } from './config.js';
import { pool } from './db.js';
import accessRoutes from './routes/access.js';
import apiKeyRoutes from './routes/apikeys.js';
import adminRoutes from './routes/admin.js';
import platformRoutes from './routes/platforms.js';
import portfolioRoutes from './routes/portfolio.js';
import sizingRoutes from './routes/sizing.js';
import runRoutes from './routes/runs.js';
import auditRoutes from './routes/audits.js';
import catalogRoutes from './routes/catalog.js';
import datasetRoutes from './routes/datasets.js';
import findingRoutes from './routes/findings.js';
import dashboardRoutes from './routes/dashboard.js';
import systemRoutes from './routes/system.js';

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
    // Eindeutigkeitsverletzung (z. B. doppelter Name) als Konflikt statt als Serverfehler melden.
    if (err.code === '23505') return reply.code(409).send({ error: 'Name oder E-Mail ist bereits vergeben' });
    const status = err.statusCode ?? 500;
    if (status >= 500) request.log.error(err);
    reply.code(status).send({ error: status >= 500 ? 'Interner Fehler' : err.message });
  });

  // Probes für Kubernetes
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/version', async () => ({ version: config.appVersion }));
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
    const { id, username, email, display_name, roles, teams, permissions, is_admin, is_system_admin, env_admin, disabled, tenant, tenants } = request.user;
    return {
      id, username, email, display_name, roles, teams, permissions, is_admin, is_system_admin, env_admin, disabled,
      tenant, tenants, authMode: config.auth.mode, version: config.appVersion,
    };
  });

  await app.register(adminRoutes);
  await app.register(accessRoutes);
  await app.register(apiKeyRoutes);
  await app.register(datasetRoutes);
  await app.register(catalogRoutes);
  await app.register(auditRoutes);
  await app.register(runRoutes);
  await app.register(findingRoutes);
  await app.register(dashboardRoutes);
  await app.register(systemRoutes);
  await app.register(platformRoutes);
  await app.register(portfolioRoutes);
  await app.register(sizingRoutes);

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
