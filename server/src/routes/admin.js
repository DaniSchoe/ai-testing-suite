// Admin-Panel: Endpoints (AI Proxy, LLM-Endpoint, MCP) und Modellkatalog.
import { requirePermission } from '../auth.js';
import { logAudit } from '../audit.js';
import { many, one, query, tx } from '../db.js';
import { analyzeRun, getAnalysisSetting, setAnalysisSetting } from '../analysis.js';
import { ENDPOINT_SELECT, endpointHeaders, llmClientFor, syncEndpointModels } from '../models.js';
import { hasPermission } from '../permissions.js';
import { McpClient } from '../runner/clients.js';
import { canSeePublished } from '../visibility.js';

import { KINDS, URL_KINDS } from '../inventory.js';
import { cleanSpec } from '../inventorySpec.js';
const CAPABILITIES = ['vision', 'tools', 'reasoning', 'mcp', 'json', 'embeddings'];
const FLAVORS = ['openai', 'claude'];
const ENVIRONMENTS = ['dev', 'prod'];
const VISIBILITIES = ['admins', 'teams', 'global'];

function badRequest(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function validateEndpoint(b) {
  if (!b.name?.trim()) throw badRequest('Name fehlt');
  if (!KINDS.includes(b.kind)) throw badRequest(`Art muss eine von ${KINDS.join(', ')} sein`);
  if (!b.platform_id) throw badRequest('Plattform fehlt');
  if (b.kind === 'llm' && b.llm_flavor && !FLAVORS.includes(b.llm_flavor)) throw badRequest('Ungültige API-Art');
  if (b.environment && !ENVIRONMENTS.includes(b.environment)) throw badRequest('Umgebung muss dev oder prod sein');
  if (b.visibility && !VISIBILITIES.includes(b.visibility)) throw badRequest('Ungültige Veröffentlichung');
  if (b.visibility === 'teams' && !(b.teamIds ?? []).length) throw badRequest('Mindestens ein Team auswählen');
  if (URL_KINDS.includes(b.kind)) {
    try {
      new URL(b.base_url);
    } catch {
      throw badRequest('Basis-URL ist ungültig');
    }
  }
  if (b.metrics_url) {
    try {
      new URL(b.metrics_url);
    } catch {
      throw badRequest('Metrics-Endpunkt ist keine gültige URL');
    }
  }
  cleanSpec(b.kind, b.spec);
}

// Das Flavor gilt nur für LLM-Endpoints; AI-Proxys und MCP sind immer OpenAI-kompatibel bzw. MCP.
const flavorOf = (b) => (b.kind === 'llm' && (b.llm_flavor === 'claude' || b.spec?.provider === 'anthropic') ? 'claude' : 'openai');

// Verbindungstest einer (auch noch nicht gespeicherten) Konfiguration: Modelle bzw. MCP-Tools abrufen.
async function testConnection({ kind, llm_flavor, base_url, headers, secretEnc, health_path, metrics_url, spec }) {
  if (!URL_KINDS.includes(kind)) {
    // Rechenzentrum, Kubernetes und GPU-Server haben keine Basis-URL; geprüft wird nur ein angegebener Metrics-Endpunkt (DCGM).
    if (!metrics_url) return { ok: true, latencyMs: 0, models: [], note: 'Keine Verbindung zu prüfen' };
    const t1 = performance.now();
    try {
      const res = await fetch(metrics_url, { signal: AbortSignal.timeout(15_000) });
      return { ok: res.ok, latencyMs: Math.round(performance.now() - t1), models: [], error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, latencyMs: Math.round(performance.now() - t1), error: err.message };
    }
  }
  const e ={ kind, llm_flavor: flavorOf({ kind, llm_flavor, spec }), base_url, headers: headers ?? {}, api_key_enc: secretEnc };
  const t0 = performance.now();
  const latency = () => Math.round(performance.now() - t0);
  try {
    if (kind === 'mcp') {
      const mcp = new McpClient({ url: base_url, headers: endpointHeaders(e), timeoutMs: 15_000 });
      const info = await mcp.initialize();
      const tools = await mcp.listTools();
      return { ok: true, latencyMs: latency(), server: info?.serverInfo, tools: tools.map((t) => t.name) };
    }
    if (!['ai_proxy', 'llm'].includes(kind)) {
      const res = await fetch(`${base_url.replace(/\/$/, '')}${health_path ?? ''}`, { headers: endpointHeaders(e), signal: AbortSignal.timeout(15_000) });
      return res.ok ? { ok: true, latencyMs: latency(), models: [] } : { ok: false, latencyMs: latency(), error: `HTTP ${res.status}` };
    }
    const models = await llmClientFor(e, { timeoutMs: 15_000 }).models();
    return { ok: true, latencyMs: latency(), models };
  } catch (err) {
    return { ok: false, latencyMs: latency(), error: err.message };
  }
}

// Endpoints und Modelle mit Teams, Maintainer und Sichtbarkeit für den anfragenden User.
export async function catalog(user, { platformId = null } = {}) {
  const [endpoints, models, endpointTeams, modelTeams, users] = await Promise.all([
    many(
      `select e.*, k.secret_enc as api_key_enc, k.name as api_key_name, p.name as platform_name, p.environment as platform_environment
       from endpoints e left join api_keys k on k.id = e.api_key_id join platforms p on p.id = e.platform_id
       where e.tenant_id = $1 and ($2::uuid is null or e.platform_id = $2) order by p.name, e.kind, e.name`,
      [user.tenant_id, platformId],
    ),
    many('select m.* from endpoint_models m join endpoints e on e.id = m.endpoint_id where e.tenant_id = $1 order by coalesce(m.alias, m.name)', [user.tenant_id]),
    many('select * from endpoint_teams'),
    many('select * from model_teams'),
    many('select id, coalesce(display_name, username) as name from users'),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const manager = user.is_admin || hasPermission(user, 'endpoints.manage');
  const out = [];
  for (const e of endpoints) {
    const teamIds = endpointTeams.filter((t) => t.endpoint_id === e.id).map((t) => t.team_id);
    if (!canSeePublished(user, { ...e, teamIds })) continue;
    const { api_key_enc, headers, ...rest } = e;
    const own = models
      .filter((m) => m.endpoint_id === e.id)
      .map((m) => {
        const mTeamIds = modelTeams.filter((t) => t.endpoint_id === e.id && t.model_name === m.name).map((t) => t.team_id);
        return { ...m, teamIds: mTeamIds, maintainer_name: userName.get(m.maintainer_id) ?? null, can_edit: manager || m.maintainer_id === user.id };
      })
      .filter((m) => canSeePublished(user, m) || manager);
    out.push({
      ...rest,
      ...(manager ? { headers } : {}),
      has_api_key: Boolean(api_key_enc),
      teamIds,
      maintainer_name: userName.get(e.maintainer_id) ?? null,
      models: own,
    });
  }
  return out;
}


export { CAPABILITIES };

export default async function adminRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const endpointAdmin = { preHandler: requirePermission('endpoints.manage') };
  const canManage = (user) => hasPermission(user, 'endpoints.manage');

  async function saveManualModels(endpointId, names) {
    const list = (names ?? []).map((n) => n.trim()).filter(Boolean);
    await query(`delete from endpoint_models where endpoint_id = $1 and source = 'manual' and not (name = any($2::text[]))`, [endpointId, list]);
    await query(
      `insert into endpoint_models (endpoint_id, name, source) select $1, unnest($2::text[]), 'manual'
       on conflict (endpoint_id, name) do nothing`,
      [endpointId, list],
    );
  }

  async function setEndpointTeams(c, endpointId, teamIds) {
    await c.query('delete from endpoint_teams where endpoint_id = $1', [endpointId]);
    if (teamIds.length) await c.query('insert into endpoint_teams select $1, unnest($2::uuid[])', [endpointId, teamIds]);
  }

  // Modelle von Endpoint abrufen; Ergebnis für das Popup nach dem Anlegen.
  async function discover(endpoint) {
    if (!['ai_proxy', 'llm'].includes(endpoint.kind)) return null;
    if (!endpoint.auto_discover) return { ok: true, models: [], skipped: true };
    try {
      return { ok: true, models: await syncEndpointModels(endpoint) };
    } catch (err) {
      return { ok: false, models: [], error: err.message };
    }
  }

  async function loadEndpoint(id, tenantId) {
    return one(`${ENDPOINT_SELECT} where e.id = $1 and e.tenant_id = $2`, [id, tenantId]);
  }

  // --- Endpoints ---
  app.get('/api/endpoints', viewer, async (request) => catalog(request.user, { platformId: request.query.platform_id ?? null }));

  // Verbindungstest vor dem Speichern (Neuanlage und Bearbeiten).
  app.post('/api/endpoints/test', endpointAdmin, async (request) => {
    const b = request.body ?? {};
    if (!KINDS.includes(b.kind)) throw badRequest('Art fehlt');
    if (URL_KINDS.includes(b.kind)) {
      try {
        new URL(b.base_url);
      } catch {
        throw badRequest('Basis-URL ist ungültig');
      }
    }
    const key = b.api_key_id ? await one('select secret_enc from api_keys where id = $1 and tenant_id = $2', [b.api_key_id, request.user.tenant_id]) : null;
    return testConnection({ ...b, secretEnc: key?.secret_enc });
  });

  async function save(request, id) {
    const b = request.body ?? {};
    validateEndpoint(b);
    const visibility = b.visibility ?? 'global';
    const teamIds = visibility === 'teams' ? [...new Set(b.teamIds ?? [])] : [];
    const tenantId = request.user.tenant_id;
    const platform = await one('select id, environment from platforms where id = $1 and tenant_id = $2', [b.platform_id, tenantId]);
    if (!platform) throw badRequest('Plattform existiert nicht');
    if (b.api_key_id && !(await one('select 1 from api_keys where id = $1 and tenant_id = $2', [b.api_key_id, tenantId]))) throw badRequest('API-Key existiert nicht');
    const values = [
      b.name.trim(),
      b.kind,
      flavorOf(b),
      b.base_url?.trim() || null,
      b.api_key_id || null,
      b.headers ?? {},
      b.auto_discover ?? true,
      b.default_model || null,
      b.enabled ?? true,
      b.notes ?? null,
      b.maintainer_id || null,
      platform.environment,
      visibility,
      b.platform_id,
      b.health_path || null,
      JSON.stringify(cleanSpec(b.kind, b.spec)),
      b.metrics_url || null,
    ];
    const row = await tx(async (c) => {
      const { rows } = id
        ? await c.query(
            `update endpoints set name = $2, kind = $3, llm_flavor = $4, base_url = $5, api_key_id = $6, headers = $7,
               auto_discover = $8, default_model = $9, enabled = $10, notes = $11, maintainer_id = $12,
               environment = $13, visibility = $14, platform_id = $15, health_path = $16, spec = $17, metrics_url = $18, updated_at = now()
             where id = $1 and tenant_id = $19 returning id`,
            [id, ...values, tenantId],
          )
        : await c.query(
            `insert into endpoints (name, kind, llm_flavor, base_url, api_key_id, headers, auto_discover, default_model, enabled,
               notes, maintainer_id, environment, visibility, platform_id, health_path, spec, metrics_url, created_by, tenant_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) returning id`,
            [...values, request.user.id, tenantId],
          );
      if (!rows[0]) throw badRequest('Endpoint nicht gefunden', 404);
      await setEndpointTeams(c, rows[0].id, teamIds);
      return rows[0];
    });
    await saveManualModels(row.id, b.manual_models);
    const endpoint = await loadEndpoint(row.id, tenantId);
    await logAudit(request, id ? 'endpoint.update' : 'endpoint.create', 'endpoint', row.id, { name: b.name });
    // Nach dem Speichern die Modelle lesen; das Frontend zeigt das Ergebnis kurz als Popup.
    const discovered = await discover(endpoint);
    const full = (await catalog(request.user)).find((e) => e.id === row.id);
    return { endpoint: full, discovered };
  }

  app.post('/api/endpoints', endpointAdmin, async (request) => save(request, null));
  app.put('/api/endpoints/:id', endpointAdmin, async (request) => save(request, request.params.id));

  app.delete('/api/endpoints/:id', endpointAdmin, async (request) => {
    await query('delete from endpoints where id = $1 and tenant_id = $2', [request.params.id, request.user.tenant_id]);
    await logAudit(request, 'endpoint.delete', 'endpoint', request.params.id);
    return { ok: true };
  });

  // Verbindungstest eines gespeicherten Endpoints; gleicht den Modellkatalog direkt mit ab.
  app.post('/api/endpoints/:id/check', endpointAdmin, async (request, reply) => {
    const e = await loadEndpoint(request.params.id, request.user.tenant_id);
    if (!e) return reply.code(404).send({ error: 'Endpoint nicht gefunden' });
    const result = await testConnection({ ...e, secretEnc: e.api_key_enc });
    if (result.ok && result.models) await syncEndpointModels(e).catch(() => {});
    return result;
  });

  app.post('/api/endpoints/:id/sync-models', endpointAdmin, async (request, reply) => {
    const e = await loadEndpoint(request.params.id, request.user.tenant_id);
    if (!e) return reply.code(404).send({ error: 'Endpoint nicht gefunden' });
    try {
      return { ok: true, models: await syncEndpointModels(e) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // --- Modellkatalog ---
  // Modell für die KI-Analyse der Testläufe (eine Einstellung für die ganze Anwendung).
  app.get('/api/settings/analysis', viewer, async (request) => {
    if (!request.user.is_admin) throw Object.assign(new Error('Nur für Administratoren'), { statusCode: 403 });
    return (await getAnalysisSetting(request.user.tenant_id)) ?? { endpoint_id: null, model: null };
  });
  app.put('/api/settings/analysis', endpointAdmin, async (request, reply) => {
    if (!request.user.is_admin) return reply.code(403).send({ error: 'Nur für Administratoren' });
    const { endpoint_id, model } = request.body ?? {};
    if (!endpoint_id && !model) {
      await setAnalysisSetting(request.user.tenant_id, null, request.user.id);
      return { endpoint_id: null, model: null };
    }
    const hit = await one(`select 1 from endpoint_models m join endpoints e on e.id = m.endpoint_id
      where m.endpoint_id = $1 and m.name = $2 and e.tenant_id = $3 and e.kind in ('ai_proxy', 'llm')`, [endpoint_id, model, request.user.tenant_id]);
    if (!hit) return reply.code(400).send({ error: 'Modell am Endpoint nicht gefunden' });
    await setAnalysisSetting(request.user.tenant_id, { endpoint_id, model }, request.user.id);
    return getAnalysisSetting(request.user.tenant_id);
  });

  app.get('/api/models', viewer, async (request) => {
    const endpoints = await catalog(request.user);
    return endpoints.flatMap((e) =>
      e.models.map((m) => ({
        ...m,
        endpoint_name: e.name,
        platform_id: e.platform_id,
        platform_name: e.platform_name,
        endpoint_kind: e.kind,
        endpoint_enabled: e.enabled,
        endpoint_environment: e.environment,
        // Dev, sobald Endpoint oder Modell als Dev markiert ist.
        effective_environment: e.environment === 'dev' || m.environment === 'dev' ? 'dev' : 'prod',
      })),
    );
  });

  // Modell bearbeiten (Body statt Pfad, weil Modellnamen wie "Qwen/Qwen3-32B" Schrägstriche enthalten).
  // Erlaubt für Administratoren und den Maintainer des Modells.
  app.put('/api/endpoint-models', viewer, async (request, reply) => {
    const b = request.body ?? {};
    const existing = await one(
      `select m.* from endpoint_models m join endpoints e on e.id = m.endpoint_id where m.endpoint_id = $1 and m.name = $2 and e.tenant_id = $3`,
      [b.endpoint_id, b.name, request.user.tenant_id],
    );
    if (!existing) return reply.code(404).send({ error: 'Modell nicht gefunden' });
    const user = request.user;
    if (!(user.is_admin || canManage(user) || existing.maintainer_id === user.id)) {
      return reply.code(403).send({ error: 'Nur Administratoren und der Maintainer dürfen Modelle bearbeiten' });
    }
    const visibility = b.visibility ?? existing.visibility;
    const environment = b.environment ?? existing.environment;
    if (!VISIBILITIES.includes(visibility)) throw badRequest('Ungültige Veröffentlichung');
    if (!ENVIRONMENTS.includes(environment)) throw badRequest('Umgebung muss dev oder prod sein');
    const teamIds = visibility === 'teams' ? [...new Set(b.teamIds ?? [])] : [];
    if (visibility === 'teams' && !teamIds.length) throw badRequest('Mindestens ein Team auswählen');
    // Metadaten: nur angegebene Felder ändern; leere Texte löschen den Wert.
    const pick = (k) => (b[k] === undefined ? existing[k] : String(b[k] ?? '').trim() || null);
    const capabilities = b.capabilities === undefined ? existing.capabilities : [...new Set(b.capabilities)].filter((c) => CAPABILITIES.includes(c));
    await tx(async (c) => {
      await c.query(
        `update endpoint_models set alias = $3, maintainer_id = $4, environment = $5, visibility = $6,
           license = $7, provider = $8, origin = $9, open_weights = $10, revision = $11, quantization = $12,
           capabilities = $13, context_length = $14
         where endpoint_id = $1 and name = $2`,
        [
          b.endpoint_id, b.name, b.alias?.trim() || null,
          b.maintainer_id === undefined ? existing.maintainer_id : b.maintainer_id || null, environment, visibility,
          pick('license'), pick('provider'), pick('origin'),
          b.open_weights === undefined ? existing.open_weights : b.open_weights === null || b.open_weights === '' ? null : Boolean(b.open_weights),
          pick('revision'), pick('quantization'),
          capabilities, b.context_length === undefined ? existing.context_length : Number(b.context_length) || null,
        ],
      );
      await c.query('delete from model_teams where endpoint_id = $1 and model_name = $2', [b.endpoint_id, b.name]);
      if (teamIds.length) await c.query('insert into model_teams select $1, $2, unnest($3::uuid[])', [b.endpoint_id, b.name, teamIds]);
    });
    return one('select * from endpoint_models where endpoint_id = $1 and name = $2', [b.endpoint_id, b.name]);
  });
}
