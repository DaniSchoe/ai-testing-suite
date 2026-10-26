import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, fit, gpuOf, loadCurve, MODELS, minGpus } from '../../web/src/platformModel.js';

const model = (id) => MODELS.find((m) => m.id === id);
const cfg = (over = {}) => ({
  cluster: { gpu_type: 'h100-sxm', gpu_count: 8, nvlink: true, inference: { tensor_parallel: 4, gpu_memory_utilization: 0.9, max_num_seqs: 256 }, gateway: { instances: 2, rps_per_instance: 250 }, ...over.cluster },
  workload: { dtype: 'fp8', kv_dtype: 'fp16', avg_context: 4000, avg_output: 400, think_time_s: 30, target_tps: 15, ...over.workload },
  extra: { gpu_type: 'h100-sxm', gpu_count: 0, ...over.extra },
});

test('Passform: 32B in FP8 auf 4×H100, 405B in BF16 nicht auf 8×L4', () => {
  assert.equal(fit(model('qwen3-32b'), 'fp8', 'fp16', gpuOf('h100-sxm'), 4).status, 'ok');
  assert.equal(fit(model('llama-3.1-405b'), 'bf16', 'fp16', gpuOf('l4'), 8).status, 'no');
  assert.equal(minGpus(model('llama-3.1-70b'), 'bf16', 'fp16', gpuOf('h100-sxm'), 8, 0.9, 4000), 4);
  assert.equal(minGpus(model('llama-3.1-405b'), 'bf16', 'fp16', gpuOf('l4'), 8, 0.9, 4000), null);
});

test('Auslegung: Nutzer und Durchsatz, Kurve sättigt', () => {
  const c = cfg();
  const ev = evaluate(c, model('qwen3-32b'));
  assert.equal(ev.fits, true);
  assert.equal(ev.replicas, 2);
  assert.ok(ev.users > 50 && ev.max_tps > 1000, JSON.stringify({ users: ev.users, tps: ev.max_tps }));
  const curve = loadCurve(ev, 1024);
  assert.ok(curve.every((p, i) => i === 0 || p.per_user_tps <= curve[i - 1].per_user_tps + 1e-9), 'Tempo je Nutzer sinkt mit der Last');
  assert.ok(curve.at(-1).total_tps >= curve[0].total_tps, 'Gesamtdurchsatz steigt');
  assert.equal(curve.at(-1).queued, true, 'bei sehr hoher Last stauen sich Anfragen');
});

test('Erweiterung: zusätzliche GPUs erhöhen VRAM, Bandbreite und Nutzerzahl', () => {
  const c = cfg({ extra: { gpu_type: 'h100-sxm', gpu_count: 4 } });
  const base = evaluate(c, model('qwen3-32b'));
  const more = evaluate(c, model('qwen3-32b'), { withExtra: true });
  assert.equal(more.gpus, 12);
  assert.ok(more.vram_gb > base.vram_gb && more.bw_tbs > base.bw_tbs && more.users > base.users && more.max_tps > base.max_tps);
});

test('NVLink verbessert die Skalierung der Tensor-Parallelität', () => {
  const a = evaluate(cfg({ cluster: { nvlink: true } }), model('llama-3.1-70b'));
  const b = evaluate(cfg({ cluster: { nvlink: false } }), model('llama-3.1-70b'));
  assert.ok(a.max_tps > b.max_tps);
});

test('Modell passt nicht: keine Nutzer', () => {
  const ev = evaluate(cfg({ cluster: { gpu_type: 'l4', gpu_count: 4, inference: { tensor_parallel: 4, gpu_memory_utilization: 0.9, max_num_seqs: 256 } }, workload: { dtype: 'bf16' } }), model('llama-3.1-70b'));
  assert.equal(ev.fits, false);
  assert.equal(ev.users, 0);
});

test('Prometheus-Text wird gelesen und je Komponente verdichtet', async () => {
  const { parsePrometheus, EXTRACTORS } = await import('../src/platformMetrics.js');
  const text = [
    '# HELP DCGM_FI_DEV_GPU_UTIL GPU utilization',
    'DCGM_FI_DEV_GPU_UTIL{gpu="0",Hostname="n1"} 80',
    'DCGM_FI_DEV_GPU_UTIL{gpu="1",Hostname="n1"} 40',
    'DCGM_FI_DEV_FB_USED{gpu="0",Hostname="n1"} 1000',
    'vllm:num_requests_running 7',
    'kaputte zeile',
  ].join('\n');
  const samples = parsePrometheus(text);
  assert.equal(samples.length, 4);
  const gpu = EXTRACTORS.gpu(samples);
  assert.equal(gpu.gpus, 2);
  assert.equal(gpu.util_pct, 60);
  assert.equal(gpu.mem_used_mib, 1000);
  assert.equal(gpu.power_w, null);
  assert.equal(EXTRACTORS.inference(samples).running, 7);
});
