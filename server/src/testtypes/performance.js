import { avg, percentile } from '../runner/clients.js';

// Führt `count` Streaming-Requests mit gegebener Parallelität aus und misst Latenzen.
export async function measureStreaming(ctx, { model, prompt, prompts, maxTokens, count, concurrency }) {
  const samples = [];
  const errors = [];
  let next = 0;
  const llm = ctx.llm();
  async function worker() {
    while (next < count && !ctx.signal.aborted) {
      next += 1;
      // Mit Prompt-Pool (Datensatz) reihum, sonst immer derselbe Prompt.
      const item = prompts?.length ? prompts[(next - 1) % prompts.length] : { prompt, maxTokens };
      try {
        samples.push(
          await llm.chatStream({ model, max_tokens: item.maxTokens ?? maxTokens, messages: [{ role: 'user', content: item.prompt }] }),
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

// Rohwerte begrenzen (gleichmäßig ausdünnen), damit Ergebnisse klein bleiben.
export function capSamples(values, max = 1000) {
  const v = values.filter((x) => typeof x === 'number').map((x) => Math.round(x * 10) / 10);
  if (v.length <= max) return v;
  const step = v.length / max;
  return Array.from({ length: max }, (_, i) => v[Math.floor(i * step)]);
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
    // Optionaler Prompt-Pool aus einem Datensatz; ohne Pool gilt "prompt".
    prompts: [],
    // Schwellwerte legt die Prüfung fest; ohne Angabe wird nur gemessen.
    thresholds: {},
  },
  async run(ctx) {
    const c = ctx.config;
    const model = ctx.model();
    ctx.log('info', `Starte ${c.requests} Requests mit Parallelität ${c.concurrency} gegen ${model}`);
    const { metrics, errors, samples } = await measureStreaming(ctx, {
      model,
      prompt: c.prompt,
      prompts: c.prompts,
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
      // Rohwerte für Perzentile über mehrere Läufe (Dashboard) statt gemittelter Perzentile.
      details: { violations, samples: { ttft_ms: capSamples(samples.map((x) => x.ttftMs)), latency_ms: capSamples(samples.map((x) => x.totalMs)) } },
    };
  },
};
