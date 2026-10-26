// Admin-Panel: Endpoints (LiteLLM, vLLM, MCP), Test-Personas und Benutzerübersicht.
import { requireRole } from '../auth.js';
import { encrypt, mask } from '../crypto.js';
import { many, one, query } from '../db.js';
import { LlmClient, McpClient } from '../runner/clients.js';
import { decrypt } from '../crypto.js';

const KINDS = ['litellm', 'vllm', 'openai', 'mcp'];
const AUTH_TYPES = ['keycloak_password', 'api_key', 'none'];

function publicEndpoint(e) {
  const { api_key_enc, ...rest } = e;
  return { ...rest, api_key_masked: mask(api_key_enc), has_api_key: Boolean(api_key_enc) };
}

function publicPersona(p) {
  const { secret_enc, ...rest } = p;
  return { ...rest, has_secret: Boolean(secret_enc) };
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function validateEndpoint(body) {
  if (!body.name?.trim()) throw badRequest('Name fehlt');
  if (!KINDS.includes(body.kind)) throw badRequest(`Typ muss einer von ${KINDS.join(', ')} sein`);
  try {
    new URL(body.base_url);
  } catch {
    throw badRequest('Basis-URL ist ungültig');
  }
}

export default async function adminRoutes(app) {
  const viewer = { preHandler: requireRole('viewer') };
  const admin = { preHandler: requireRole('admin') };

  // --- Endpoints ---
  app.get('/api/endpoints', viewer, async () =>
    (await many('select * from endpoints order by kind, name')).map(publicEndpoint),
  );

  app.post('/api/endpoints', admin, async (request) => {
    const b = request.body ?? {};
    validateEndpoint(b);
    const row = await one(
      `insert into endpoints (name, kind, base_url, api_key_enc, headers, models, default_model, enabled, notes, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
      [
        b.name.trim(),
        b.kind,
        b.base_url.trim(),
        encrypt(b.api_key),
        b.headers ?? {},
        b.models ?? [],
        b.default_model || null,
        b.enabled ?? true,
        b.notes ?? null,
        request.user.id,
      ],
    );
    return publicEndpoint(row);
  });

  app.put('/api/endpoints/:id', admin, async (request, reply) => {
    const b = request.body ?? {};
    validateEndpoint(b);
    // api_key: undefined = unverändert, '' = löschen, sonst neu setzen
    const row = await one(
      `update endpoints set name = $2, kind = $3, base_url = $4,
         api_key_enc = case when $5::boolean then $6 else api_key_enc end,
         headers = $7, models = $8, default_model = $9, enabled = $10, notes = $11, updated_at = now()
       where id = $1 returning *`,
      [
        request.params.id,
        b.name.trim(),
        b.kind,
        b.base_url.trim(),
        b.api_key !== undefined,
        encrypt(b.api_key),
        b.headers ?? {},
        b.models ?? [],
        b.default_model || null,
        b.enabled ?? true,
        b.notes ?? null,
      ],
    );
    if (!row) return reply.code(404).send({ error: 'Endpoint nicht gefunden' });
    return publicEndpoint(row);
  });

  app.delete('/api/endpoints/:id', admin, async (request) => {
    await query('delete from endpoints where id = $1', [request.params.id]);
    return { ok: true };
  });

  // Verbindungstest aus dem Admin-Panel: Modelle (bzw. MCP-Tools) abrufen und Latenz messen.
  app.post('/api/endpoints/:id/check', admin, async (request, reply) => {
    const e = await one('select * from endpoints where id = $1', [request.params.id]);
    if (!e) return reply.code(404).send({ error: 'Endpoint nicht gefunden' });
    const key = decrypt(e.api_key_enc);
    const headers = { ...e.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) };
    const t0 = performance.now();
    try {
      if (e.kind === 'mcp') {
        const mcp = new McpClient({ url: e.base_url, headers, timeoutMs: 15_000 });
        const info = await mcp.initialize();
        const tools = await mcp.listTools();
        return { ok: true, latencyMs: Math.round(performance.now() - t0), server: info?.serverInfo, tools: tools.map((t) => t.name) };
      }
      const models = await new LlmClient({ baseUrl: e.base_url, headers, timeoutMs: 15_000 }).models();
      return { ok: true, latencyMs: Math.round(performance.now() - t0), models };
    } catch (err) {
      return { ok: false, latencyMs: Math.round(performance.now() - t0), error: err.message };
    }
  });

  // --- Test-Personas ---
  app.get('/api/personas', viewer, async () => (await many('select * from personas order by name')).map(publicPersona));

  app.post('/api/personas', admin, async (request) => {
    const b = request.body ?? {};
    if (!b.name?.trim()) throw badRequest('Name fehlt');
    if (!AUTH_TYPES.includes(b.auth_type)) throw badRequest('Ungültige Authentifizierungsart');
    const row = await one(
      `insert into personas (name, description, auth_type, username, secret_enc, attributes)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [b.name.trim(), b.description ?? null, b.auth_type, b.username ?? null, encrypt(b.secret), b.attributes ?? {}],
    );
    return publicPersona(row);
  });

  app.put('/api/personas/:id', admin, async (request, reply) => {
    const b = request.body ?? {};
    if (!b.name?.trim()) throw badRequest('Name fehlt');
    if (!AUTH_TYPES.includes(b.auth_type)) throw badRequest('Ungültige Authentifizierungsart');
    const row = await one(
      `update personas set name = $2, description = $3, auth_type = $4, username = $5,
         secret_enc = case when $6::boolean then $7 else secret_enc end, attributes = $8, updated_at = now()
       where id = $1 returning *`,
      [
        request.params.id,
        b.name.trim(),
        b.description ?? null,
        b.auth_type,
        b.username ?? null,
        b.secret !== undefined,
        encrypt(b.secret),
        b.attributes ?? {},
      ],
    );
    if (!row) return reply.code(404).send({ error: 'Persona nicht gefunden' });
    return publicPersona(row);
  });

  app.delete('/api/personas/:id', admin, async (request) => {
    await query('delete from personas where id = $1', [request.params.id]);
    return { ok: true };
  });

  // --- Benutzer (kommen aus Keycloak, hier nur Übersicht) ---
  app.get('/api/users', admin, async () =>
    many(
      `select u.id, u.username, u.email, u.display_name, u.roles, u.last_login_at,
         count(r.id)::int as runs, max(r.created_at) as last_run_at
       from users u left join runs r on r.user_id = u.id
       group by u.id order by u.last_login_at desc nulls last`,
    ),
  );
}
