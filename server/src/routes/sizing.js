// Sizing einer Plattform: Konfiguration (Schätzung), Live-Metriken der Komponenten und Messwerte aus Lasttests.
import { requirePermission } from '../auth.js';
import { logAudit } from '../audit.js';
import { decrypt } from '../crypto.js';
import { many, one } from '../db.js';
import { getPlatform, metricComponents, savePlatform } from '../platform.js';
import { collectAll, collectComponent, COMPONENTS } from '../platformMetrics.js';

const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });
const liveCache = new Map();

// Nur http(s)-URLs; die Konfiguration darf nur ein Administrator ändern (wie Endpoints).
function cleanUrls(urls) {
  const list = (Array.isArray(urls) ? urls : String(urls ?? '').split('\n')).map((u) => String(u).trim()).filter(Boolean);
  for (const u of list) if (!/^https?:\/\/\S+$/i.test(u)) throw bad(`Ungültige URL: ${u}`);
  return list;
}

const numOr = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

// Eigene GPU: nur bekannte Zahlenfelder, damit nichts Beliebiges in der Konfiguration landet.
function cleanCustomGpu(g) {
  if (!g || typeof g !== 'object') return null;
  return {
    name: String(g.name ?? 'Eigene GPU').slice(0, 60),
    vram_gb: numOr(g.vram_gb, 1, 2048, 24),
    bw_gbs: numOr(g.bw_gbs, 10, 100000, 600),
    tflops16: numOr(g.tflops16, 1, 100000, 100),
    tflops8: numOr(g.tflops8, 0, 200000, 0),
    nvlink_gbs: numOr(g.nvlink_gbs, 0, 5000, 0),
    watt: numOr(g.watt, 0, 5000, 0),
  };
}

function cleanWorkload(w) {
  return {
    model: String(w.model ?? '').slice(0, 80),
    dtype: String(w.dtype ?? 'fp16').slice(0, 20),
    kv_dtype: String(w.kv_dtype ?? 'fp16').slice(0, 20),
    avg_context: numOr(w.avg_context, 1, 2_000_000, 4000),
    avg_output: numOr(w.avg_output, 1, 200_000, 400),
    think_time_s: numOr(w.think_time_s, 0, 86400, 30),
    target_tps: numOr(w.target_tps, 1, 1000, 15),
  };
}

export default async function sizingRoutes(app) {
  const viewer = { preHandler: requirePermission('suite.view') };
  const admin = { preHandler: requirePermission('endpoints.manage') };

  // Plattform des Mandanten laden; fremde Plattformen sind unsichtbar.
  async function platformOf(request) {
    const p = await one('select id, name, environment from platforms where id = $1 and tenant_id = $2', [request.params.id, request.user.tenant_id]);
    if (!p) throw Object.assign(new Error('Plattform nicht gefunden'), { statusCode: 404 });
    return p;
  }

  app.get('/api/platforms/:id/sizing', viewer, async (request) => {
    const p = await platformOf(request);
    return { ...(await getPlatform(p.id)), platform: p };
  });

  app.put('/api/platforms/:id/sizing', admin, async (request) => {
    const p = await platformOf(request);
    const b = request.body ?? {};
    const current = (await getPlatform(p.id)).config;
    const num = (v, min, max, name) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw bad(`${name} muss zwischen ${min} und ${max} liegen`);
      return n;
    };
    const c = b.cluster ?? current.cluster;
    const config = {
      cluster: {
        gpu_type: String(c.gpu_type ?? current.cluster.gpu_type).slice(0, 60),
        gpu_count: num(c.gpu_count, 1, 4096, 'Anzahl GPUs'),
        nvlink: Boolean(c.nvlink),
        custom_gpu: cleanCustomGpu(c.custom_gpu),
        inference: {
          server: String(c.inference?.server ?? 'vllm').slice(0, 30),
          tensor_parallel: num(c.inference?.tensor_parallel ?? 1, 1, 1024, 'Tensor-Parallelität'),
          gpu_memory_utilization: num(c.inference?.gpu_memory_utilization ?? 0.9, 0.3, 0.99, 'GPU-Speicheranteil'),
          max_num_seqs: num(c.inference?.max_num_seqs ?? 256, 1, 8192, 'max_num_seqs'),
        },
        gateway: {
          type: String(c.gateway?.type ?? 'litellm').slice(0, 30),
          instances: num(c.gateway?.instances ?? 1, 1, 256, 'Gateway-Instanzen'),
          rps_per_instance: num(c.gateway?.rps_per_instance ?? 250, 1, 100000, 'Requests pro Sekunde je Instanz'),
        },
      },
      workload: cleanWorkload({ ...current.workload, ...b.workload }),
      extra: {
        gpu_type: String((b.extra ?? current.extra).gpu_type ?? current.extra.gpu_type).slice(0, 60),
        gpu_count: num((b.extra ?? current.extra).gpu_count ?? 0, 0, 4096, 'Zusätzliche GPUs'),
      },
      metrics: Object.fromEntries(
        COMPONENTS.map((k) => [k, { urls: cleanUrls((b.metrics ?? current.metrics)[k]?.urls), api_key_id: (b.metrics ?? current.metrics)[k]?.api_key_id || null }]),
      ),
    };
    await savePlatform(p.id, config, request.user.id);
    liveCache.delete(p.id);
    await logAudit(request, 'sizing.update', 'platform', p.id);
    return { ...(await getPlatform(p.id)), platform: p };
  });

  // Metrik-Endpunkt ausprobieren, bevor er gespeichert wird.
  app.post('/api/platforms/:id/sizing/metrics-test', admin, async (request) => {
    await platformOf(request);
    const { component, urls, api_key_id } = request.body ?? {};
    if (!COMPONENTS.includes(component)) throw bad('Unbekannte Komponente');
    let authorization;
    if (api_key_id) {
      const key = await one('select secret_enc from api_keys where id = $1 and tenant_id = $2', [api_key_id, request.user.tenant_id]);
      if (key) authorization = `Bearer ${decrypt(key.secret_enc)}`;
    }
    const res = await collectComponent(component, { urls: cleanUrls(urls), authorization });
    return res ?? { values: null, error: 'Keine URL angegeben' };
  });

  // Aktuelle Werte aller konfigurierten Komponenten (kurz zwischengespeichert, damit viele Browser den Exporter nicht fluten).
  app.get('/api/platforms/:id/sizing/live', viewer, async (request) => {
    const p = await platformOf(request);
    const hit = liveCache.get(p.id);
    if (hit && Date.now() - hit.at < 5000) return hit.data;
    const data = { at: new Date().toISOString(), components: await collectAll(await metricComponents(p.id)) };
    liveCache.set(p.id, { at: Date.now(), data });
    return data;
  });

  // Neueste Lasttests je Modell samt Plattformmessung, für den Vergleich Schätzung gegen Messung.
  app.get('/api/platforms/:id/sizing/load-results', viewer, async (request) => {
    const p = await platformOf(request);
    return many(
      `select distinct on (coalesce(res.model_alias, res.model)) res.id, res.run_id, res.endpoint_name,
         coalesce(res.model_alias, res.model) as model, res.finished_at, res.metrics, res.details->'stages' as stages,
         res.details->'platform'->'summary' as platform
       from results res join runs r on r.id = res.run_id
       where res.type = 'load' and res.status <> 'error' and res.finished_at is not null and res.model is not null
         and r.tenant_id = $1 and r.platform_id = $2
       order by coalesce(res.model_alias, res.model), res.finished_at desc`,
      [request.user.tenant_id, p.id],
    );
  });
}
