// Prometheus-Metriken der Plattformkomponenten (DCGM-Exporter, vLLM, LiteLLM) lesen und für Kacheln und Lasttests aufbereiten.

// Prometheus-Textformat: "name{label="x"} 1.5". Kommentare und ungültige Zeilen werden übersprungen.
export function parsePrometheus(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(-?[\d.]+(?:[eE][+-]?\d+)?|NaN|[+-]?Inf)(?:\s+\d+)?$/);
    if (!m) continue;
    const labels = {};
    for (const l of (m[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]] = l[2];
    const value = Number(m[3]);
    if (Number.isFinite(value)) out.push({ name: m[1], labels, value });
  }
  return out;
}

const named = (samples, ...names) => samples.filter((s) => names.includes(s.name));
const sum = (list) => (list.length ? list.reduce((a, s) => a + s.value, 0) : null);
const avg = (list) => (list.length ? sum(list) / list.length : null);
const max = (list) => (list.length ? Math.max(...list.map((s) => s.value)) : null);

// Kennzahlen je Komponente. Namen laut DCGM-Exporter-Dokumentation, vLLM (v0/v1) und LiteLLM-Prometheus-Callback;
// fehlende Metriken ergeben null, dann blendet die Oberfläche den Wert aus.
export const EXTRACTORS = {
  gpu: (s) => ({
    gpus: new Set(named(s, 'DCGM_FI_DEV_GPU_UTIL').map((x) => `${x.labels.Hostname ?? ''}/${x.labels.gpu ?? ''}`)).size || null,
    util_pct: avg(named(s, 'DCGM_FI_DEV_GPU_UTIL')),
    mem_copy_util_pct: avg(named(s, 'DCGM_FI_DEV_MEM_COPY_UTIL')),
    mem_used_mib: sum(named(s, 'DCGM_FI_DEV_FB_USED')),
    mem_free_mib: sum(named(s, 'DCGM_FI_DEV_FB_FREE')),
    power_w: sum(named(s, 'DCGM_FI_DEV_POWER_USAGE')),
    temp_c_max: max(named(s, 'DCGM_FI_DEV_GPU_TEMP')),
    dram_active: avg(named(s, 'DCGM_FI_PROF_DRAM_ACTIVE')),
    tensor_active: avg(named(s, 'DCGM_FI_PROF_PIPE_TENSOR_ACTIVE')),
    nvlink_bandwidth: sum(named(s, 'DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL')),
    xid_errors: sum(named(s, 'DCGM_FI_DEV_XID_ERRORS')),
  }),
  inference: (s) => ({
    running: sum(named(s, 'vllm:num_requests_running')),
    waiting: sum(named(s, 'vllm:num_requests_waiting')),
    kv_cache: max(named(s, 'vllm:gpu_cache_usage_perc', 'vllm:kv_cache_usage_perc')),
    generation_tokens_total: sum(named(s, 'vllm:generation_tokens_total')),
    prompt_tokens_total: sum(named(s, 'vllm:prompt_tokens_total')),
    requests_total: sum(named(s, 'vllm:request_success_total')),
    preemptions_total: sum(named(s, 'vllm:num_preemptions_total')),
    ttft_sum_s: sum(named(s, 'vllm:time_to_first_token_seconds_sum')),
    ttft_count: sum(named(s, 'vllm:time_to_first_token_seconds_count')),
    e2e_sum_s: sum(named(s, 'vllm:e2e_request_latency_seconds_sum')),
    e2e_count: sum(named(s, 'vllm:e2e_request_latency_seconds_count')),
  }),
  gateway: (s) => ({
    in_flight: sum(named(s, 'litellm_in_flight_requests')),
    requests_total: sum(named(s, 'litellm_proxy_total_requests_metric_total', 'litellm_proxy_total_requests_metric')),
    failed_total: sum(named(s, 'litellm_proxy_failed_requests_metric_total', 'litellm_proxy_failed_requests_metric')),
    tokens_total: sum(named(s, 'litellm_total_tokens_metric_total', 'litellm_total_tokens')),
    latency_sum_s: sum(named(s, 'litellm_request_total_latency_metric_sum', 'litellm_llm_api_latency_metric_sum')),
    latency_count: sum(named(s, 'litellm_request_total_latency_metric_count', 'litellm_llm_api_latency_metric_count')),
  }),
};

export const COMPONENTS = Object.keys(EXTRACTORS);

async function scrape(url, headers, timeoutMs = 8000) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parsePrometheus(await res.text());
}

// Alle URLs einer Komponente abrufen (z. B. ein DCGM-Exporter je Knoten) und zusammenfassen.
// cfg: { urls: [..], authorization?: "Bearer …" }. Liefert { values, samples: Anzahl, error? }.
export async function collectComponent(component, cfg) {
  const urls = (cfg?.urls ?? []).filter(Boolean);
  if (!urls.length) return null;
  const headers = cfg.authorization ? { authorization: cfg.authorization } : {};
  const all = [];
  const errors = [];
  for (const url of urls) {
    try {
      all.push(...(await scrape(url, headers)));
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  if (!all.length) return { values: null, error: errors.join('; ') || 'keine Metriken gefunden' };
  return { values: EXTRACTORS[component](all), samples: all.length, ...(errors.length ? { error: errors.join('; ') } : {}) };
}

export async function collectAll(components) {
  const out = {};
  await Promise.all(COMPONENTS.map(async (c) => (out[c] = await collectComponent(c, components[c]).catch((err) => ({ values: null, error: err.message })))));
  return out;
}

const rate = (a, b, key, dt) => (a?.[key] != null && b?.[key] != null && dt > 0 ? Math.max(0, (b[key] - a[key]) / dt) : null);

// Während eines Lasttests regelmäßig Metriken lesen. stop() liefert die Messreihe und eine Zusammenfassung (Spitzen, Mittel, Raten).
export function createSampler(components, intervalMs = 5000) {
  const samples = [];
  let timer = null;
  let busy = false;
  const configured = COMPONENTS.filter((c) => components[c]?.urls?.length);
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const got = await collectAll(Object.fromEntries(configured.map((c) => [c, components[c]])));
      const row = { t: Date.now() };
      for (const c of configured) if (got[c]?.values) row[c] = got[c].values;
      samples.push(row);
    } finally {
      busy = false;
    }
  }
  return {
    configured,
    start() {
      if (!configured.length) return;
      tick();
      timer = setInterval(tick, intervalMs);
    },
    async stop() {
      clearInterval(timer);
      if (configured.length) await tick();
      return { samples, summary: summarize(samples) };
    },
  };
}

export function summarize(samples) {
  const col = (c, k) => samples.map((s) => s[c]?.[k]).filter((v) => typeof v === 'number');
  const peak = (c, k) => (col(c, k).length ? Math.max(...col(c, k)) : null);
  const mean = (c, k) => (col(c, k).length ? col(c, k).reduce((a, b) => a + b, 0) / col(c, k).length : null);
  const first = samples.find((s) => s.inference);
  const last = [...samples].reverse().find((s) => s.inference);
  const dt = first && last ? (last.t - first.t) / 1000 : 0;
  const gfirst = samples.find((s) => s.gateway);
  const glast = [...samples].reverse().find((s) => s.gateway);
  return {
    samples: samples.length,
    gpu: { util_pct_avg: mean('gpu', 'util_pct'), util_pct_peak: peak('gpu', 'util_pct'), mem_used_mib_peak: peak('gpu', 'mem_used_mib'), power_w_peak: peak('gpu', 'power_w'), temp_c_peak: peak('gpu', 'temp_c_max'), dram_active_avg: mean('gpu', 'dram_active'), nvlink_bandwidth_peak: peak('gpu', 'nvlink_bandwidth') },
    inference: {
      running_peak: peak('inference', 'running'),
      waiting_peak: peak('inference', 'waiting'),
      kv_cache_peak: peak('inference', 'kv_cache'),
      tokens_per_s: rate(first?.inference, last?.inference, 'generation_tokens_total', dt),
      preemptions: first && last && last.inference.preemptions_total != null ? last.inference.preemptions_total - (first.inference.preemptions_total ?? 0) : null,
    },
    gateway: {
      in_flight_peak: peak('gateway', 'in_flight'),
      requests_per_s: rate(gfirst?.gateway, glast?.gateway, 'requests_total', gfirst && glast ? (glast.t - gfirst.t) / 1000 : 0),
      failed: gfirst && glast && glast.gateway.failed_total != null ? glast.gateway.failed_total - (gfirst.gateway.failed_total ?? 0) : null,
    },
  };
}
