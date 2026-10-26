import { avg, percentile } from '../runner/clients.js';

// Führt `count` Streaming-Requests mit gegebener Parallelität aus und misst Latenzen.
export async function measureStreaming(ctx, { model, prompt, maxTokens, count, concurrency }) {
  const samples = [];
  const errors = [];
  let next = 0;
  const llm = ctx.llm();
  async function worker() {
    while (next < count && !ctx.signal.aborted) {
      next += 1;
      try {
        samples.push(
          await llm.chatStream({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
        );
      } catch (err) {
        errors.push(err.status ? `HTTP ${err.status}` : err.message);
      }
    }
  }
  const started = performance.now();
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  const wallMs = performance.now() - started;
  const ttft = samples.map((s) => s.ttftMs).filter((v) => v !== null);
  const total = samples.map((s) => s.totalMs);
  const tps = samples.map((s) => s.tokensPerSecond).filter((v) => v !== null);
  const totalTokens = samples.reduce((sum, s) => sum + (s.completionTokens ?? 0), 0);
  return {
    samples,
    errors,
    metrics: {
      requests: count,
      errors: errors.length,
      error_rate: count ? errors.length / count : 0,
      ttft_ms_p50: percentile(ttft, 50),
      ttft_ms_p95: percentile(ttft, 95),
      latency_ms_p50: percentile(total, 50),
      latency_ms_p95: percentile(total, 95),
      tokens_per_s_avg: avg(tps),
      throughput_tokens_per_s: wallMs > 0 ? (totalTokens / wallMs) * 1000 : null,
      requests_per_s: wallMs > 0 ? (samples.length / wallMs) * 1000 : null,
    },
  };
}

// Schwellwerte wie { ttft_ms_p95: { max: 800 }, tokens_per_s_avg: { min: 20 } } prüfen.
export function checkThresholds(metrics, thresholds = {}) {
  const violations = [];
  for (const [key, rule] of Object.entries(thresholds)) {
    const value = metrics[key];
    if (value === null || value === undefined) {
      violations.push(`${key}: kein Messwert`);
      continue;
    }
    if (rule.max !== undefined && value > rule.max) violations.push(`${key} = ${round(value)} > ${rule.max}`);
    if (rule.min !== undefined && value < rule.min) violations.push(`${key} = ${round(value)} < ${rule.min}`);
  }
  return violations;
}

function round(v) {
  return Math.round(v * 100) / 100;
}

export default {
  type: 'performance',
  label: 'Performance',
  description: 'Latenz, Time-to-first-Token und Token-Durchsatz über Streaming-Requests mit fester Parallelität.',
  defaults: {
    model: '',
    prompt: 'Erkläre in drei Sätzen, was Kubernetes ist.',
    maxTokens: 128,
    requests: 20,
    concurrency: 4,
    thresholds: { ttft_ms_p95: { max: 1500 }, error_rate: { max: 0.05 } },
  },
  async run(ctx) {
    const c = ctx.config;
    const model = ctx.model();
    ctx.log('info', `Starte ${c.requests} Requests mit Parallelität ${c.concurrency} gegen ${model}`);
    const { metrics, errors } = await measureStreaming(ctx, {
      model,
      prompt: c.prompt,
      maxTokens: c.maxTokens,
      count: c.requests,
      concurrency: c.concurrency,
    });
    if (errors.length) ctx.log('warn', `${errors.length} fehlgeschlagene Requests`, { errors: errors.slice(0, 10) });
    const violations = checkThresholds(metrics, c.thresholds);
    return {
      status: violations.length ? 'failed' : 'passed',
      model,
      metrics,
      details: { violations },
    };
  },
};
