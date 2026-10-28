// Metriken der Komponenten: Prometheus-Endpunkte (DCGM, vLLM, LiteLLM) in festen Abständen lesen und als Zeitreihe speichern.
// Einstellungen (Abstand, Aufbewahrung, ein/aus) liegen in app_settings 'metrics'.
import { many, one, query } from './db.js';
import { EXTRACTORS, parsePrometheus } from './platformMetrics.js';

export const GROUP_OF = { gpu: 'gpu', llm: 'inference', ai_proxy: 'gateway' };
export const DEFAULT_METRICS_SETTINGS = { enabled: true, interval_s: 30, retention_h: 24 };

export async function getMetricsSettings() {
  const row = await one(`select value from app_settings where key = 'metrics'`);
  return { ...DEFAULT_METRICS_SETTINGS, ...(row?.value ?? {}) };
}

export function cleanMetricsSettings(b = {}) {
  const num = (v, min, max, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw Object.assign(new Error(`${name}: ${min} bis ${max}`), { statusCode: 400 });
    return Math.round(n);
  };
  return { enabled: b.enabled !== false, interval_s: num(b.interval_s ?? 30, 10, 600, 'Abstand in Sekunden'), retention_h: num(b.retention_h ?? 24, 1, 168, 'Aufbewahrung in Stunden') };
}

// Zuletzt bekannter Zustand je Endpunkt (im Speicher): { ok, at, ms, error }.
const state = new Map();
export const metricsState = () => state;

export async function scrapeEndpoint(e) {
  const t0 = performance.now();
  try {
    const res = await fetch(e.metrics_url, { headers: e.headers ?? {}, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const samples = parsePrometheus(await res.text());
    if (!samples.length) throw new Error('keine Metriken gefunden');
    const values = EXTRACTORS[GROUP_OF[e.kind]](samples);
    state.set(e.id, { ok: true, at: new Date().toISOString(), ms: Math.round(performance.now() - t0), error: null });
    return values;
  } catch (err) {
    state.set(e.id, { ok: false, at: new Date().toISOString(), ms: Math.round(performance.now() - t0), error: err.message });
    return null;
  }
}

export const metricEndpoints = (where = '', params = []) =>
  many(
    `select e.id, e.name, e.kind, e.metrics_url, e.headers, e.platform_id, e.tenant_id, p.name as platform_name from endpoints e join platforms p on p.id = e.platform_id
     where e.enabled and e.metrics_url is not null and e.kind in ('gpu', 'llm', 'ai_proxy') ${where} order by p.name, e.kind, e.name`,
    params,
  );

export async function collectOnce() {
  const endpoints = await metricEndpoints();
  await Promise.all(
    endpoints.map(async (e) => {
      const values = await scrapeEndpoint(e);
      if (values) await query('insert into metric_samples (endpoint_id, values) values ($1, $2)', [e.id, JSON.stringify(values)]);
    }),
  );
  return endpoints.length;
}

// Abgeleitete Werte je Messpunkt: Zähler werden zu Raten, Summe/Anzahl zu Mittelwerten.
const delta = (a, b, key) => (typeof a?.[key] === 'number' && typeof b?.[key] === 'number' && b[key] >= a[key] ? b[key] - a[key] : null);
export function derive(group, prev, cur, seconds) {
  const rate = (key) => {
    const d = delta(prev, cur, key);
    return d === null || seconds <= 0 ? null : d / seconds;
  };
  const meanMs = (sumKey, countKey) => {
    const ds = delta(prev, cur, sumKey);
    const dc = delta(prev, cur, countKey);
    return ds === null || !dc ? null : (ds / dc) * 1000;
  };
  if (group === 'inference') {
    return { running: cur.running, waiting: cur.waiting, kv_cache_pct: cur.kv_cache === null ? null : cur.kv_cache * 100, generation_tokens_per_s: rate('generation_tokens_total'), prompt_tokens_per_s: rate('prompt_tokens_total'), requests_per_s: rate('requests_total'), ttft_ms: meanMs('ttft_sum_s', 'ttft_count'), e2e_ms: meanMs('e2e_sum_s', 'e2e_count') };
  }
  if (group === 'gateway') {
    return { in_flight: cur.in_flight, requests_per_s: rate('requests_total'), failed_per_s: rate('failed_total'), tokens_per_s: rate('tokens_total'), latency_ms: meanMs('latency_sum_s', 'latency_count') };
  }
  return { ...cur, mem_used_gib: cur.mem_used_mib === null ? null : cur.mem_used_mib / 1024, mem_total_gib: cur.mem_used_mib === null || cur.mem_free_mib === null ? null : (cur.mem_used_mib + cur.mem_free_mib) / 1024 };
}

export async function seriesFor(endpoint, minutes) {
  const rows = await many(`select at, values from metric_samples where endpoint_id = $1 and at > now() - make_interval(mins => $2::int) order by at`, [endpoint.id, minutes]);
  const group = GROUP_OF[endpoint.kind];
  const points = rows.map((r, i) => {
    const prev = rows[i - 1];
    const seconds = prev ? (new Date(r.at) - new Date(prev.at)) / 1000 : 0;
    return { at: r.at, v: derive(group, prev?.values, r.values, seconds) };
  });
  // Auf höchstens 240 Punkte ausdünnen.
  const step = Math.ceil(points.length / 240) || 1;
  return points.filter((_, i) => i % step === 0 || i === points.length - 1);
}

let timer = null;
export function startMetricsCollector(log) {
  let stopped = false;
  const tick = async () => {
    let wait = 30;
    try {
      const s = await getMetricsSettings();
      wait = s.interval_s;
      if (s.enabled) {
        await collectOnce();
        await query(`delete from metric_samples where at < now() - make_interval(hours => $1::int)`, [s.retention_h]);
      }
    } catch (err) {
      log?.warn(`Metriken: ${err.message}`);
    }
    if (!stopped) timer = setTimeout(tick, wait * 1000);
  };
  timer = setTimeout(tick, 5000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
