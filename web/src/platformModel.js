// Rechenmodell der Plattform-Seite. ALLES HIER SIND SCHÄTZUNGEN auf Basis von Datenblattwerten und einem einfachen
// Roofline-Modell (Speicherbandbreite gegen Rechenleistung); sie ersetzen keinen Lasttest. Reine Funktionen ohne Abhängigkeiten.

// GPU-Katalog (Datenblattwerte, gerundet): VRAM in GB, Speicherbandbreite in GB/s, dichte Tensor-TFLOPS (FP16/BF16 und FP8),
// NVLink-Bandbreite je GPU in GB/s (0 = kein NVLink), Leistung in Watt.
export const GPUS = {
  'b200': { name: 'NVIDIA B200', vram_gb: 192, bw_gbs: 8000, tflops16: 2250, tflops8: 4500, nvlink_gbs: 1800, watt: 1000 },
  'h200': { name: 'NVIDIA H200 SXM', vram_gb: 141, bw_gbs: 4800, tflops16: 989, tflops8: 1979, nvlink_gbs: 900, watt: 700 },
  'h100-sxm': { name: 'NVIDIA H100 SXM', vram_gb: 80, bw_gbs: 3350, tflops16: 989, tflops8: 1979, nvlink_gbs: 900, watt: 700 },
  'h100-pcie': { name: 'NVIDIA H100 PCIe', vram_gb: 80, bw_gbs: 2000, tflops16: 756, tflops8: 1513, nvlink_gbs: 600, watt: 350 },
  'a100-80': { name: 'NVIDIA A100 80 GB', vram_gb: 80, bw_gbs: 2039, tflops16: 312, tflops8: 0, nvlink_gbs: 600, watt: 400 },
  'a100-40': { name: 'NVIDIA A100 40 GB', vram_gb: 40, bw_gbs: 1555, tflops16: 312, tflops8: 0, nvlink_gbs: 600, watt: 400 },
  'l40s': { name: 'NVIDIA L40S', vram_gb: 48, bw_gbs: 864, tflops16: 362, tflops8: 733, nvlink_gbs: 0, watt: 350 },
  'rtx6000-ada': { name: 'NVIDIA RTX 6000 Ada', vram_gb: 48, bw_gbs: 960, tflops16: 364, tflops8: 728, nvlink_gbs: 0, watt: 300 },
  'a6000': { name: 'NVIDIA RTX A6000', vram_gb: 48, bw_gbs: 768, tflops16: 155, tflops8: 0, nvlink_gbs: 112, watt: 300 },
  'rtx4090': { name: 'NVIDIA GeForce RTX 4090', vram_gb: 24, bw_gbs: 1008, tflops16: 165, tflops8: 330, nvlink_gbs: 0, watt: 450 },
  'a10': { name: 'NVIDIA A10', vram_gb: 24, bw_gbs: 600, tflops16: 125, tflops8: 0, nvlink_gbs: 0, watt: 150 },
  'l4': { name: 'NVIDIA L4', vram_gb: 24, bw_gbs: 300, tflops16: 121, tflops8: 242, nvlink_gbs: 0, watt: 72 },
};

// Referenzmodelle (Werte aus den Modellkarten, gerundet). params_b = alle Parameter, active_b = je Token aktive (MoE).
// kv_bytes_per_token überschreibt die Standardformel (z. B. DeepSeek mit Multi-head Latent Attention).
export const MODELS = [
  { id: 'llama-3.1-8b', name: 'Llama 3.1 8B', params_b: 8.03, active_b: 8.03, layers: 32, kv_heads: 8, head_dim: 128 },
  { id: 'qwen3-8b', name: 'Qwen3 8B', params_b: 8.2, active_b: 8.2, layers: 36, kv_heads: 8, head_dim: 128 },
  { id: 'gpt-oss-20b', name: 'gpt-oss 20B (MoE)', params_b: 21, active_b: 3.6, layers: 24, kv_heads: 8, head_dim: 64 },
  { id: 'mistral-small-24b', name: 'Mistral Small 24B', params_b: 24, active_b: 24, layers: 40, kv_heads: 8, head_dim: 128 },
  { id: 'qwen3-30b-a3b', name: 'Qwen3 30B-A3B (MoE)', params_b: 30.5, active_b: 3.3, layers: 48, kv_heads: 4, head_dim: 128 },
  { id: 'qwen3-32b', name: 'Qwen3 32B', params_b: 32.8, active_b: 32.8, layers: 64, kv_heads: 8, head_dim: 128 },
  { id: 'mixtral-8x7b', name: 'Mixtral 8x7B (MoE)', params_b: 46.7, active_b: 12.9, layers: 32, kv_heads: 8, head_dim: 128 },
  { id: 'llama-3.1-70b', name: 'Llama 3.1 70B', params_b: 70.6, active_b: 70.6, layers: 80, kv_heads: 8, head_dim: 128 },
  { id: 'gpt-oss-120b', name: 'gpt-oss 120B (MoE)', params_b: 117, active_b: 5.1, layers: 36, kv_heads: 8, head_dim: 64 },
  { id: 'qwen3-235b-a22b', name: 'Qwen3 235B-A22B (MoE)', params_b: 235, active_b: 22, layers: 94, kv_heads: 4, head_dim: 128 },
  { id: 'llama-3.1-405b', name: 'Llama 3.1 405B', params_b: 405, active_b: 405, layers: 126, kv_heads: 8, head_dim: 128 },
  { id: 'deepseek-v3', name: 'DeepSeek V3 (MoE, MLA)', params_b: 671, active_b: 37, layers: 61, kv_heads: 1, head_dim: 576, kv_bytes_per_token: 70272 },
];

export const DTYPES = { bf16: { label: 'BF16/FP16', bytes: 2 }, fp8: { label: 'FP8/INT8', bytes: 1 }, int4: { label: 'INT4 (AWQ/GPTQ)', bytes: 0.5 } };
export const KV_DTYPES = { fp16: { label: 'FP16', bytes: 2 }, fp8: { label: 'FP8', bytes: 1 } };

// Annahmen des Modells (alle als Schätzung zu verstehen):
export const ASSUME = {
  overhead_gb_per_gpu: 2, // CUDA-Kontext, Aktivierungen
  weight_overhead: 1.05, // Puffer, Embeddings, Metadaten
  mem_efficiency: 0.7, // erreichbarer Anteil der Speicherbandbreite
  mfu: 0.4, // erreichbarer Anteil der Rechenleistung
  tp_eff_nvlink: 0.9, // Skalierungseffizienz bei Tensor-Parallelität mit NVLink
  tp_eff_pcie: 0.65, // ohne NVLink (PCIe)
};

export const gpuOf = (id, custom) => (id === 'custom' && custom ? { name: custom.name || 'Eigene GPU', vram_gb: +custom.vram_gb, bw_gbs: +custom.bw_gbs, tflops16: +custom.tflops16, tflops8: +(custom.tflops8 || 0), nvlink_gbs: +(custom.nvlink_gbs || 0), watt: +(custom.watt || 0) } : GPUS[id] ?? GPUS['h100-sxm']);

export const kvBytesPerToken = (m, kvDtype) => m.kv_bytes_per_token ?? 2 * m.layers * m.kv_heads * m.head_dim * KV_DTYPES[kvDtype].bytes;

// Kenndaten eines Pools gleicher GPUs.
export function poolStats(gpu, count, nvlink) {
  const link = nvlink && gpu.nvlink_gbs > 0;
  return { vram_gb: gpu.vram_gb * count, bw_gbs: gpu.bw_gbs * count, tflops16: gpu.tflops16 * count, nvlink_gbs: link ? gpu.nvlink_gbs : 0, watt: gpu.watt * count };
}

// Passt das Modell auf eine Replika-Gruppe aus tp GPUs? Liefert Gewichte, freien KV-Speicher und Kontextkapazität.
export function fit(model, dtype, kvDtype, gpu, tp, util = 0.9, avgContext = 4000) {
  const usable = tp * gpu.vram_gb * util - tp * ASSUME.overhead_gb_per_gpu;
  const weights = model.params_b * DTYPES[dtype].bytes * ASSUME.weight_overhead;
  const freeKv = usable - weights;
  const perToken = kvBytesPerToken(model, kvDtype);
  const kvTokens = freeKv > 0 ? (freeKv * 1e9) / perToken : 0;
  const status = freeKv <= 0 ? 'no' : kvTokens < avgContext * 4 ? 'tight' : 'ok';
  return { status, weights_gb: weights, usable_gb: usable, free_kv_gb: Math.max(0, freeKv), kv_per_token: perToken, kv_tokens: kvTokens };
}

// Kleinste Gruppengröße (Potenz von zwei, höchstens maxGpus), auf die das Modell passt; sonst null.
export function minGpus(model, dtype, kvDtype, gpu, maxGpus, util, avgContext) {
  for (let tp = 1; tp <= maxGpus; tp *= 2) if (fit(model, dtype, kvDtype, gpu, tp, util, avgContext).status !== 'no') return tp;
  return null;
}

// Eine Replika-Gruppe (tp GPUs): Zeit eines Decode-Schritts bei Batchgröße b und mittlerem Kontext c.
function replica(model, dtype, kvDtype, gpu, tp, nvlink, util, avgContext) {
  const f = fit(model, dtype, kvDtype, gpu, tp, util, avgContext);
  const eff = tp === 1 ? 1 : nvlink && gpu.nvlink_gbs > 0 ? ASSUME.tp_eff_nvlink : ASSUME.tp_eff_pcie;
  const bw = tp * gpu.bw_gbs * 1e9 * ASSUME.mem_efficiency * eff;
  const tflops = dtype !== 'bf16' && gpu.tflops8 ? gpu.tflops8 : gpu.tflops16;
  const flops = tp * tflops * 1e12 * ASSUME.mfu * eff;
  const totalBytes = model.params_b * 1e9 * DTYPES[dtype].bytes;
  const share = model.active_b / model.params_b;
  const step = (b) => {
    // MoE: mit größerem Batch werden mehr Experten angesprochen und gelesen.
    const touched = 1 - (1 - share) ** b;
    const mem = (totalBytes * touched + b * avgContext * f.kv_per_token) / bw;
    const compute = (b * 2 * model.active_b * 1e9) / flops;
    return Math.max(mem, compute);
  };
  const bMax = Math.max(0, Math.min(f.kv_tokens / avgContext, 1e6));
  return { fit: f, step, bMax, prefill: (tokens) => (tokens * 2 * model.active_b * 1e9) / flops };
}

// Kapazität eines Pools: Replikas, Sättigung, Nutzerzahl bei Ziel-Geschwindigkeit.
export function poolCapacity({ gpu, count, nvlink, tp, util, maxSeqs, model, dtype, kvDtype, workload }) {
  const R = Math.floor(count / tp);
  const empty = { replicas: 0, fits: false, b_max: 0, max_tps: 0, users: 0, concurrent_target: 0, fit: fit(model, dtype, kvDtype, gpu, tp, util, workload.avg_context), request_s: 0, curve: () => ({ per_user_tps: 0, total_tps: 0, queued: false }) };
  if (R < 1) return empty;
  const rep = replica(model, dtype, kvDtype, gpu, tp, nvlink, util, workload.avg_context);
  if (rep.fit.status === 'no') return { ...empty, replicas: R, fit: rep.fit };
  const bMax = Math.max(1, Math.min(maxSeqs, Math.floor(rep.bMax)));
  // Größter Batch, bei dem jeder Nutzer noch das Ziel-Tempo erreicht.
  let bOk = 0;
  for (let b = 1; b <= bMax; b++) if (1 / rep.step(b) >= workload.target_tps) bOk = b;
  const tpsOk = bOk ? 1 / rep.step(bOk) : 1 / rep.step(1);
  const request_s = rep.prefill(workload.avg_context) + workload.avg_output / tpsOk;
  const users = bOk ? (R * bOk * (workload.think_time_s + request_s)) / request_s : 0;
  // x = gleichzeitige Anfragen an alle Replikas dieses Pools
  const curve = (x) => {
    if (x <= R) {
      const t = rep.step(1);
      return { per_user_tps: 1 / t, total_tps: x / t, queued: false };
    }
    const b = x / R;
    if (b <= bMax) {
      const t = rep.step(b);
      return { per_user_tps: 1 / t, total_tps: x / t, queued: false };
    }
    const t = rep.step(bMax);
    return { per_user_tps: (1 / t) * ((R * bMax) / x), total_tps: (R * bMax) / t, queued: true };
  };
  return { replicas: R, fits: true, b_max: bMax, b_ok: bOk, max_tps: (R * bMax) / rep.step(bMax), users, concurrent_target: R * bOk, request_s, fit: rep.fit, curve, kv_limited: rep.bMax < maxSeqs };
}

// Gesamtbild aus Basis-Pool und optionaler Erweiterung. cfg: { cluster, workload, extra, custom_gpu }, model aus MODELS/JSON.
export function evaluate(cfg, model, { withExtra = false } = {}) {
  const { cluster, workload } = cfg;
  const base = gpuOf(cluster.gpu_type, cluster.custom_gpu);
  const pools = [{ gpu: base, count: cluster.gpu_count }];
  if (withExtra && cfg.extra?.gpu_count > 0) pools.push({ gpu: gpuOf(cfg.extra.gpu_type, cluster.custom_gpu), count: Number(cfg.extra.gpu_count) });
  const tp = Math.max(1, cluster.inference.tensor_parallel);
  const caps = pools.map((p) =>
    poolCapacity({ ...p, nvlink: cluster.nvlink, tp, util: cluster.inference.gpu_memory_utilization, maxSeqs: cluster.inference.max_num_seqs, model, dtype: workload.dtype, kvDtype: workload.kv_dtype, workload }),
  );
  const stats = pools.map((p) => poolStats(p.gpu, p.count, cluster.nvlink));
  const users = caps.reduce((n, c) => n + c.users, 0);
  const cycle = Math.max(...caps.map((c) => (c.request_s ? workload.think_time_s + c.request_s : 0)), 1);
  const rps = users / cycle;
  const gwCap = cluster.gateway.instances * cluster.gateway.rps_per_instance;
  const replicas = caps.reduce((n, c) => n + c.replicas, 0);
  return {
    gpus: pools.reduce((n, p) => n + p.count, 0),
    vram_gb: stats.reduce((n, s) => n + s.vram_gb, 0),
    bw_tbs: stats.reduce((n, s) => n + s.bw_gbs, 0) / 1000,
    tflops16: stats.reduce((n, s) => n + s.tflops16, 0),
    nvlink_gbs: Math.max(...stats.map((s) => s.nvlink_gbs)),
    watt: stats.reduce((n, s) => n + s.watt, 0),
    fits: caps.some((c) => c.fits),
    fit: caps[0].fit,
    replicas,
    users: Math.floor(users),
    concurrent: caps.reduce((n, c) => n + c.concurrent_target, 0),
    max_tps: caps.reduce((n, c) => n + c.max_tps, 0),
    request_s: caps[0].request_s,
    gateway: { capacity_rps: gwCap, needed_rps: rps, ok: gwCap >= rps },
    // Verhalten unter Last: x gleichzeitige Anfragen -> Tempo je Nutzer und Gesamtdurchsatz (Pools anteilig nach Replikas).
    at(x) {
      const total = caps.reduce((n, c) => n + (c.fits ? c.replicas : 0), 0);
      if (!total) return { per_user_tps: 0, total_tps: 0, queued: false };
      let tps = 0;
      let per = 0;
      let queued = false;
      for (const c of caps) {
        if (!c.fits) continue;
        const share = (x * c.replicas) / total;
        const r = c.curve(share);
        tps += r.total_tps;
        per += (r.per_user_tps * share) / x;
        queued ||= r.queued;
      }
      return { per_user_tps: per, total_tps: tps, queued };
    },
  };
}

// Messpunkte der Kurve für das Diagramm (gleichzeitige Anfragen logarithmisch verteilt).
export function loadCurve(ev, maxX) {
  const xs = new Set([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048]);
  const out = [];
  for (const x of [...xs].filter((v) => v <= Math.max(maxX, 8)).sort((a, b) => a - b)) out.push({ x, ...ev.at(x) });
  return out;
}
