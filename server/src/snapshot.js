// Zustand einer Plattform: Erreichbarkeit und Version je Komponente, Modell-Revisionen. Grundlage für die Topologie-Ansicht
// und den Plattform-Snapshot, der mit jeder Prüfung gespeichert wird (so weit die Komponenten es hergeben).
import { createHash } from 'node:crypto';
import { many, one } from './db.js';
import { endpointHeaders, ENDPOINT_SELECT } from './models.js';
import { McpClient } from './runner/clients.js';
import { URL_KINDS } from './inventory.js';

const join = (base, path) => `${base.replace(/\/$/, '')}${path}`;

async function getJson(url, headers, timeoutMs = 6000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* kein JSON */
  }
  return { status: res.status, ok: res.ok, json };
}

// Eine Komponente abfragen: Status, Latenz, Version und sonstige Angaben. Fehler führen zu status "down" statt zu einer Exception.
export async function probeEndpoint(e) {
  const t0 = performance.now();
  const out = { endpoint_id: e.id, name: e.name, kind: e.kind, status: 'down', version: null, latency_ms: null, info: {}, error: null };
  try {
    const headers = endpointHeaders(e);
    if (!URL_KINDS.includes(e.kind)) {
      // Rechenzentrum, Kubernetes, GPU: nur überwachbar, wenn ein Metrics-Endpunkt (DCGM) angegeben ist.
      if (e.metrics_url) {
        const res = await getJson(e.metrics_url, {});
        out.status = res.ok ? 'up' : 'down';
        if (!res.ok) out.error = `HTTP ${res.status}`;
      } else out.status = 'n/a';
    } else if (e.kind === 'mcp') {
      const info = await new McpClient({ url: e.base_url, headers, timeoutMs: 6000 }).initialize();
      out.status = 'up';
      out.version = info?.serverInfo?.version ?? null;
      out.info = { server: info?.serverInfo?.name ?? null, protocol: info?.protocolVersion ?? null };
    } else if (e.kind === 'ai_proxy') {
      // LiteLLM: /health/readiness nennt die Version; ohne diese Route genügt die Modellliste.
      const ready = await getJson(join(e.base_url, '/health/readiness'), headers).catch(() => null);
      if (ready?.ok) {
        out.status = 'up';
        out.version = ready.json?.litellm_version ?? null;
        out.info = { db: ready.json?.db ?? null, cache: ready.json?.cache ?? null };
      } else {
        const models = await getJson(join(e.base_url, '/v1/models'), headers);
        out.status = models.ok || models.status === 401 || models.status === 403 ? 'up' : 'down';
        if (!models.ok && models.status !== 401 && models.status !== 403) out.error = `HTTP ${models.status}`;
      }
    } else if (e.kind === 'llm') {
      // vLLM: GET /version liefert { version }.
      const v = await getJson(join(e.base_url, '/version'), headers).catch(() => null);
      if (v?.ok) {
        out.status = 'up';
        out.version = v.json?.version ?? null;
      } else {
        const models = await getJson(join(e.base_url, '/v1/models'), headers);
        out.status = models.ok ? 'up' : 'down';
        if (!models.ok) out.error = `HTTP ${models.status}`;
      }
    } else {
      const res = await getJson(join(e.base_url, e.health_path ?? ''), headers);
      out.status = res.ok ? 'up' : 'down';
      if (!res.ok) out.error = `HTTP ${res.status}`;
      out.version = res.json?.version ?? null;
    }
  } catch (err) {
    out.error = err.message;
  }
  out.latency_ms = Math.round(performance.now() - t0);
  return out;
}

export async function platformEndpoints(platformId) {
  const [endpoints, models] = await Promise.all([
    many(`${ENDPOINT_SELECT} where e.platform_id = $1 order by e.kind, e.name`, [platformId]),
    many('select m.* from endpoint_models m join endpoints e on e.id = m.endpoint_id where e.platform_id = $1', [platformId]),
  ]);
  return endpoints.map((e) => ({ ...e, modelRows: models.filter((m) => m.endpoint_id === e.id) }));
}

let statusCache = new Map();

// Status aller Komponenten, kurz zwischengespeichert, damit die Oberfläche den Dienst nicht flutet.
export async function platformStatus(platformId, { force = false } = {}) {
  const hit = statusCache.get(platformId);
  if (!force && hit && Date.now() - hit.at < 15_000) return hit.data;
  const endpoints = (await platformEndpoints(platformId)).filter((e) => e.enabled);
  const components = await Promise.all(endpoints.map(probeEndpoint));
  const data = { at: new Date().toISOString(), components };
  statusCache.set(platformId, { at: Date.now(), data });
  return data;
}

const canonical = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
export const hashOf = (v) => createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex');

// Snapshot: Komponenten mit Version, Modelle mit Revision/Quantisierung und die Topologie. `hash` ändert sich nur bei inhaltlichen Änderungen.
export async function takeSnapshot(platformId, { previousRunId } = {}) {
  const platform = await one('select id, name, environment from platforms where id = $1', [platformId]);
  if (!platform) return null;
  const endpoints = (await platformEndpoints(platformId)).filter((e) => e.enabled);
  const components = await Promise.all(endpoints.map(probeEndpoint));
  const models = endpoints.flatMap((e) =>
    e.modelRows
      .filter((m) => m.available && m.portfolio_id)
      .map((m) => ({
        endpoint: e.name,
        name: m.name,
        alias: m.alias ?? m.name,
        revision: m.revision ?? m.info?.root ?? null,
        quantization: m.quantization ?? null,
        license: m.license ?? null,
        provider: m.provider ?? null,
        max_model_len: m.info?.max_model_len ?? m.context_length ?? null,
      })),
  );
  const routes = await many(
    `select g.name as gateway, b.name as backend, r.models from platform_routes r
     join endpoints g on g.id = r.gateway_endpoint_id join endpoints b on b.id = r.backend_endpoint_id where r.platform_id = $1 order by 1, 2`,
    [platformId],
  );
  const sizing = await one('select config from platform_sizing where platform_id = $1', [platformId]);
  const stable = {
    components: components.map((c) => ({ name: c.name, kind: c.kind, version: c.version })),
    models: models.map(({ endpoint, name, revision, quantization }) => ({ endpoint, name, revision, quantization })),
    routes,
    cluster: sizing ? { gpu_type: sizing.config.cluster?.gpu_type, gpu_count: sizing.config.cluster?.gpu_count, inference: sizing.config.cluster?.inference } : null,
  };
  const snapshot = {
    taken_at: new Date().toISOString(),
    platform: { id: platform.id, name: platform.name, environment: platform.environment },
    components: components.map(({ endpoint_id, ...c }) => c),
    models,
    routes,
    cluster: stable.cluster,
    hash: hashOf(stable),
  };
  // Versionssprünge gegenüber dem Snapshot des vorherigen Laufs derselben Plattform (für Trendmarkierungen).
  const prev = await one(
    `select snapshot from runs where platform_id = $1 and snapshot is not null and ($2::uuid is null or id <> $2)
     order by created_at desc limit 1`,
    [platformId, previousRunId ?? null],
  );
  snapshot.changes = diffSnapshots(prev?.snapshot, snapshot);
  return snapshot;
}

export function diffSnapshots(before, after) {
  if (!before) return [];
  const changes = [];
  const was = new Map((before.components ?? []).map((c) => [c.name, c]));
  for (const c of after.components ?? []) {
    const old = was.get(c.name);
    if (!old) changes.push({ type: 'component_added', name: c.name });
    else if (old.version !== c.version) changes.push({ type: 'version', name: c.name, from: old.version, to: c.version });
  }
  const oldModels = new Map((before.models ?? []).map((m) => [`${m.endpoint}/${m.name}`, m]));
  for (const m of after.models ?? []) {
    const old = oldModels.get(`${m.endpoint}/${m.name}`);
    if (old && (old.revision !== m.revision || old.quantization !== m.quantization)) {
      changes.push({ type: 'model', name: `${m.endpoint}/${m.name}`, from: old.revision ?? old.quantization, to: m.revision ?? m.quantization });
    }
  }
  if (JSON.stringify(before.cluster) !== JSON.stringify(after.cluster)) changes.push({ type: 'cluster', name: 'Cluster-Konfiguration' });
  return changes;
}

