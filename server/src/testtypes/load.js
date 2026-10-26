import { avg, percentile } from '../runner/clients.js';
import { checkThresholds } from './performance.js';

// Prompts unterschiedlicher Schwierigkeit: kurze Wissensfragen, Erklärungen und aufwendige Aufgaben mit langer Ausgabe.
// Gleiche Anfragen würden von Prefix-Caches und Batching begünstigt und die Last unrealistisch niedrig erscheinen lassen.
export const LOAD_PROMPTS = [
  { difficulty: 'leicht', maxTokens: 48, prompt: 'Was ist die Hauptstadt von Australien? Antworte in einem Satz.' },
  { difficulty: 'leicht', maxTokens: 48, prompt: 'Nenne drei Vorteile von Containern gegenüber virtuellen Maschinen, stichpunktartig.' },
  { difficulty: 'leicht', maxTokens: 64, prompt: 'Übersetze ins Englische: "Der Server ist heute Nacht nicht erreichbar gewesen."' },
  { difficulty: 'leicht', maxTokens: 32, prompt: 'Wie viele Sekunden hat ein Tag? Nur die Zahl.' },
  { difficulty: 'mittel', maxTokens: 220, prompt: 'Erkläre in einem Absatz den Unterschied zwischen einem Load Balancer und einem Reverse Proxy.' },
  { difficulty: 'mittel', maxTokens: 220, prompt: 'Schreibe eine Python-Funktion, die prüft, ob eine Zahl eine Primzahl ist, und erkläre sie kurz.' },
  { difficulty: 'mittel', maxTokens: 250, prompt: 'Fasse die Vor- und Nachteile von Microservices gegenüber einem Monolithen in einer Tabelle zusammen.' },
  { difficulty: 'mittel', maxTokens: 200, prompt: 'Formuliere eine höfliche E-Mail an einen Kunden, dem wir eine Lieferverzögerung von zwei Tagen mitteilen müssen.' },
  { difficulty: 'schwer', maxTokens: 500, prompt: 'Entwirf die Architektur eines Systems, das 10.000 Chatanfragen pro Sekunde an mehrere GPU-Server verteilt. Gehe auf Warteschlangen, Fehlerbehandlung und Skalierung ein.' },
  { difficulty: 'schwer', maxTokens: 450, prompt: 'Löse Schritt für Schritt: Drei Maschinen fertigen zusammen 1.200 Teile pro Stunde. Maschine A schafft doppelt so viele wie B, B ein Drittel mehr als C. Wie viele Teile fertigt jede Maschine pro Stunde?' },
  { difficulty: 'schwer', maxTokens: 500, prompt: 'Schreibe eine ausführliche Anleitung zur Fehlersuche, wenn ein Kubernetes-Pod im Status CrashLoopBackOff hängt, inklusive konkreter kubectl-Befehle.' },
  { difficulty: 'schwer', maxTokens: 500, prompt: 'Implementiere in JavaScript eine LRU-Cache-Klasse mit get und put in konstanter Laufzeit und begründe die Wahl der Datenstrukturen.' },
];

const DEFAULT_MIX = { leicht: 0.4, mittel: 0.4, schwer: 0.2 };

// Eine Anfrage aus dem Pool ziehen: erst die Schwierigkeit nach Mischung, dann zufällig einen Prompt dazu.
export function pickPrompt(pool, mix = DEFAULT_MIX, rnd = Math.random) {
  const levels = [...new Set(pool.map((p) => p.difficulty))];
  const weights = levels.map((l) => mix[l] ?? 0);
  let r = rnd() * weights.reduce((a, b) => a + b, 0);
  let level = levels[levels.length - 1];
  for (const [i, l] of levels.entries()) {
    r -= weights[i];
    if (r < 0) {
      level = l;
      break;
    }
  }
  const candidates = pool.filter((p) => p.difficulty === level);
  return candidates[Math.floor(rnd() * candidates.length)] ?? pool[0];
}

// Lasttest mit Stufen (Ramp-up). Läuft im Worker-Pod; für sehr hohe Last siehe k6-Jobs im Architekturplan.
export default {
  type: 'load',
  label: 'Last',
  description:
    'Stufenweise steigende Parallelität mit wechselnden Prompts unterschiedlicher Schwierigkeit; misst Durchsatz, Fehlerquote, p95 und gedrosselte Anfragen (HTTP 429) je Stufe.',
  defaults: {
    model: '',
    prompts: LOAD_PROMPTS,
    mix: DEFAULT_MIX,
    uniquePrefix: true,
    stages: [
      { durationS: 20, concurrency: 5 },
      { durationS: 20, concurrency: 20 },
      { durationS: 20, concurrency: 50 },
    ],
    thresholds: { error_rate: { max: 0.02 }, latency_ms_p95: { max: 30000 } },
  },
  async run(ctx) {
    const c = ctx.config;
    const model = ctx.model();
    const llm = ctx.llm();
    const stages = [];
    const allLatencies = [];
    let allErrors = 0;
    let allRequests = 0;
    const sampler = await ctx.metricsSampler?.();
    sampler?.start();

    for (const [i, stage] of c.stages.entries()) {
      ctx.log('info', `Stufe ${i + 1}: ${stage.concurrency} parallel für ${stage.durationS}s`);
      const stageStart = Date.now();
      const deadline = stageStart + stage.durationS * 1000;
      const latencies = [];
      const byDifficulty = {};
      const statusCodes = {};
      let errors = 0;
      let tokens = 0;
      async function vu() {
        while (Date.now() < deadline && !ctx.signal.aborted) {
          // Älterer Test mit einem festen "prompt" läuft unverändert; sonst wechselnde Prompts aus dem Pool.
          const item = c.prompt ? { difficulty: 'fest', prompt: c.prompt, maxTokens: c.maxTokens ?? 64 } : pickPrompt(c.prompts, c.mix);
          const content = c.uniquePrefix === false ? item.prompt : `[Anfrage ${Math.random().toString(36).slice(2, 8)}] ${item.prompt}`;
          const bucket = (byDifficulty[item.difficulty] ??= { latencies: [], errors: 0, tokens: 0 });
          const t0 = performance.now();
          try {
            const r = await llm.chat({ model, max_tokens: item.maxTokens, messages: [{ role: 'user', content }] });
            const ms = performance.now() - t0;
            latencies.push(ms);
            bucket.latencies.push(ms);
            bucket.tokens += r.usage?.completion_tokens ?? 0;
            tokens += r.usage?.completion_tokens ?? 0;
            statusCodes[200] = (statusCodes[200] ?? 0) + 1;
          } catch (err) {
            bucket.errors += 1;
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
        t_start: stageStart,
        t_end: Date.now(),
        concurrency: stage.concurrency,
        requests,
        errors,
        error_rate: requests ? errors / requests : 0,
        requests_per_s: requests / secs,
        tokens_per_s: tokens / secs,
        latency_ms_p50: percentile(latencies, 50),
        latency_ms_p95: percentile(latencies, 95),
        rate_limited: statusCodes[429] ?? 0,
        by_difficulty: Object.fromEntries(
          Object.entries(byDifficulty).map(([level, b]) => [
            level,
            { requests: b.latencies.length + b.errors, errors: b.errors, latency_ms_p50: percentile(b.latencies, 50), latency_ms_p95: percentile(b.latencies, 95), tokens: b.tokens },
          ]),
        ),
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
      rate_limited: stages.reduce((n, s) => n + s.rate_limited, 0),
    };
    const violations = checkThresholds(metrics, c.thresholds);
    // Plattformmetriken während der Last (nur wenn Metrik-Endpunkte konfiguriert sind).
    const platform = sampler?.configured.length ? await sampler.stop() : null;
    return { status: violations.length ? 'failed' : 'passed', model, metrics, details: { stages, violations, ...(platform ? { platform } : {}) } };
  },
};
