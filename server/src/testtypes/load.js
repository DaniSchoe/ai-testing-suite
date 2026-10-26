import { avg, percentile } from '../runner/clients.js';
import { checkThresholds } from './performance.js';

// Lasttest mit Stufen (Ramp-up). Läuft im Worker-Pod; für sehr hohe Last siehe k6-Jobs im Architekturplan.
export default {
  type: 'load',
  label: 'Last',
  description: 'Stufenweise steigende Parallelität über eine feste Dauer; misst Durchsatz, Fehlerquote und p95 je Stufe.',
  defaults: {
    model: '',
    prompt: 'Antworte mit einem kurzen Satz: Was ist ein Load Balancer?',
    maxTokens: 64,
    stages: [
      { durationS: 20, concurrency: 5 },
      { durationS: 20, concurrency: 20 },
      { durationS: 20, concurrency: 50 },
    ],
    thresholds: { error_rate: { max: 0.02 }, latency_ms_p95: { max: 10000 } },
  },
  async run(ctx) {
    const c = ctx.config;
    const model = ctx.model();
    const llm = ctx.llm();
    const stages = [];
    const allLatencies = [];
    let allErrors = 0;
    let allRequests = 0;

    for (const [i, stage] of c.stages.entries()) {
      ctx.log('info', `Stufe ${i + 1}: ${stage.concurrency} parallel für ${stage.durationS}s`);
      const deadline = Date.now() + stage.durationS * 1000;
      const latencies = [];
      const statusCodes = {};
      let errors = 0;
      let tokens = 0;
      async function vu() {
        while (Date.now() < deadline && !ctx.signal.aborted) {
          const t0 = performance.now();
          try {
            const r = await llm.chat({ model, max_tokens: c.maxTokens, messages: [{ role: 'user', content: c.prompt }] });
            latencies.push(performance.now() - t0);
            tokens += r.usage?.completion_tokens ?? 0;
            statusCodes[200] = (statusCodes[200] ?? 0) + 1;
          } catch (err) {
            errors += 1;
            const code = err.status ?? 'net';
            statusCodes[code] = (statusCodes[code] ?? 0) + 1;
          }
        }
      }
      const t0 = performance.now();
      await Promise.all(Array.from({ length: stage.concurrency }, vu));
      const secs = (performance.now() - t0) / 1000;
      const requests = latencies.length + errors;
      stages.push({
        stage: i + 1,
        concurrency: stage.concurrency,
        requests,
        errors,
        error_rate: requests ? errors / requests : 0,
        requests_per_s: requests / secs,
        tokens_per_s: tokens / secs,
        latency_ms_p50: percentile(latencies, 50),
        latency_ms_p95: percentile(latencies, 95),
        status_codes: statusCodes,
      });
      allLatencies.push(...latencies);
      allErrors += errors;
      allRequests += requests;
    }

    const metrics = {
      requests: allRequests,
      errors: allErrors,
      error_rate: allRequests ? allErrors / allRequests : 0,
      latency_ms_avg: avg(allLatencies),
      latency_ms_p95: percentile(allLatencies, 95),
      peak_requests_per_s: Math.max(...stages.map((s) => s.requests_per_s)),
      peak_tokens_per_s: Math.max(...stages.map((s) => s.tokens_per_s)),
    };
    const violations = checkThresholds(metrics, c.thresholds);
    return { status: violations.length ? 'failed' : 'passed', model, metrics, details: { stages, violations } };
  },
};
