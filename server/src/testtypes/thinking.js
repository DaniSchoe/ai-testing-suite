import { avg } from '../runner/clients.js';
import { buildMessages, checkAll } from './assertions.js';

// Thinking vs. Non-Thinking: dieselben Aufgaben mit unterschiedlichen Reasoning-Einstellungen.
// Wie Thinking geschaltet wird, hängt vom Modell ab, deshalb sind die Varianten frei konfigurierbar:
//   Qwen3 auf vLLM:  { "chat_template_kwargs": { "enable_thinking": false } }
//   gpt-oss:         { "reasoning_effort": "low" | "medium" | "high" }
//   über LiteLLM:    { "reasoning_effort": "..." } oder { "thinking": { "type": "enabled", "budget_tokens": 2048 } }

const estimateTokens = (text) => Math.round((text?.length ?? 0) / 4);

const JUDGE_PROMPT =
  'Du bewertest die Begründung eines KI-Modells. Ist der Gedankengang schlüssig, ohne Widersprüche ' +
  'und führt er nachvollziehbar zur Antwort? Antworte nur mit JSON {"score": <1-10>, "reason": "<kurz>"}.';

async function judgeReasoning(ctx, judgeModel, testCase, res) {
  try {
    const out = await ctx.llm().chat({
      model: judgeModel,
      temperature: 0,
      messages: [
        { role: 'system', content: JUDGE_PROMPT },
        {
          role: 'user',
          content: `Aufgabe:\n${testCase.prompt}\n\nGedankengang:\n${(res.reasoning || '(keiner)').slice(0, 6000)}\n\nAntwort:\n${res.content}`,
        },
      ],
    });
    const parsed = JSON.parse(out.content.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
    return Number(parsed.score) / 10 || null;
  } catch {
    return null;
  }
}

export const THINKING_CASES = [
  {
    name: 'Schläger und Ball',
    prompt:
      'Ein Schläger und ein Ball kosten zusammen 1,10 €. Der Schläger kostet 1 € mehr als der Ball. Wie viel kostet der Ball in Cent? Schließe mit "Antwort: <Zahl>".',
    assert: [{ type: 'regex', value: 'Antwort:\\s*5\\b' }],
  },
  {
    name: 'Maschinen',
    prompt:
      '5 Maschinen brauchen 5 Minuten für 5 Teile. Wie viele Minuten brauchen 100 Maschinen für 100 Teile? Schließe mit "Antwort: <Zahl>".',
    assert: [{ type: 'regex', value: 'Antwort:\\s*5\\b' }],
  },
  {
    name: 'Reihenfolge',
    prompt:
      'Anna ist älter als Ben. Ben ist älter als Carla. Dana ist jünger als Carla. Wer ist die zweitjüngste Person? Schließe mit "Antwort: <Name>".',
    assert: [{ type: 'regex', value: 'Antwort:\\s*Carla' }],
  },
  {
    name: 'Primzahlen',
    prompt: 'Wie viele Primzahlen liegen zwischen 30 und 50? Schließe mit "Antwort: <Zahl>".',
    assert: [{ type: 'regex', value: 'Antwort:\\s*5\\b' }],
  },
  {
    name: 'Fahrzeit',
    prompt: 'Ein Zug fährt um 9:40 Uhr ab und ist 2 Stunden 35 Minuten unterwegs. Wann kommt er an? Schließe mit "Antwort: HH:MM".',
    assert: [{ type: 'regex', value: 'Antwort:\\s*12:15' }],
  },
];

export default {
  type: 'thinking',
  label: 'Thinking vs. Non-Thinking',
  description:
    'Vergleicht Reasoning-Varianten auf denselben Aufgaben: Genauigkeit, Token-Verbrauch (inkl. Reasoning-Tokens), Latenz, Tokens pro richtiger Antwort und Schlüssigkeit der Begründung (Judge).',
  defaults: {
    model: '',
    maxTokens: 4096,
    variants: [
      { name: 'Thinking', params: { chat_template_kwargs: { enable_thinking: true } } },
      { name: 'Non-Thinking', params: { chat_template_kwargs: { enable_thinking: false } } },
    ],
    // Modell für die Bewertung der Begründung; leer = kein Judge.
    judgeModel: '',
    minAccuracy: 0,
    expectThinkingBetter: false,
    cases: [],
  },
  async run(ctx) {
    const c = ctx.config;
    const model = ctx.model();
    const llm = ctx.llm();
    const variants = [];
    if (!c.cases?.length) throw new Error('Kein Datensatz zugeordnet');

    for (const variant of c.variants) {
      ctx.log('info', `Variante ${variant.name}: ${c.cases.length} Aufgaben`);
      const cases = [];
      for (const testCase of c.cases) {
        if (ctx.signal.aborted) break;
        try {
          const res = await llm.chat({
            model,
            temperature: testCase.temperature ?? 0,
            max_tokens: c.maxTokens,
            messages: buildMessages(testCase),
            ...variant.params,
          });
          const verdict = await checkAll(testCase.assert, res.content, ctx);
          const completion = res.usage?.completion_tokens ?? estimateTokens(res.content + res.reasoning);
          const reasoningTokens = res.reasoningTokens ?? (res.reasoning ? estimateTokens(res.reasoning) : 0);
          cases.push({
            name: testCase.name,
            ok: verdict.ok,
            outcomes: verdict.outcomes,
            latencyMs: Math.round(res.latencyMs),
            completionTokens: completion,
            reasoningTokens,
            reasoningEstimated: res.reasoningTokens === null && Boolean(res.reasoning),
            judge: c.judgeModel ? await judgeReasoning(ctx, ctx.resolveModel(c.judgeModel), testCase, res) : null,
            prompt: testCase.prompt,
            answer: res.content.slice(0, 1000),
            reasoning: res.reasoning.slice(0, 2000),
          });
        } catch (err) {
          cases.push({ name: testCase.name, ok: false, error: err.message });
        }
      }
      const done = cases.filter((x) => !x.error);
      const correct = cases.filter((x) => x.ok).length;
      const totalTokens = done.reduce((s, x) => s + x.completionTokens, 0);
      variants.push({
        name: variant.name,
        params: variant.params,
        accuracy: cases.length ? correct / cases.length : 0,
        correct,
        cases,
        latency_ms_avg: avg(done.map((x) => x.latencyMs)),
        completion_tokens_avg: avg(done.map((x) => x.completionTokens)),
        reasoning_tokens_avg: avg(done.map((x) => x.reasoningTokens)),
        tokens_per_correct: correct ? totalTokens / correct : null,
        judge_score: avg(done.map((x) => x.judge).filter((x) => x !== null)),
        errors: cases.length - done.length,
      });
    }

    const [first, second] = variants;
    const metrics = {};
    for (const v of variants) {
      for (const k of ['accuracy', 'latency_ms_avg', 'completion_tokens_avg', 'reasoning_tokens_avg', 'tokens_per_correct', 'judge_score']) {
        metrics[`${k}:${v.name}`] = v[k];
      }
    }
    // Kennzahlen der ersten beiden Varianten gegeneinander (typisch: Thinking vs. Non-Thinking).
    if (first && second) {
      metrics.accuracy_gain = first.accuracy - second.accuracy;
      metrics.token_factor = second.completion_tokens_avg ? first.completion_tokens_avg / second.completion_tokens_avg : null;
      metrics.latency_factor = second.latency_ms_avg ? first.latency_ms_avg / second.latency_ms_avg : null;
      const extraTokens = (first.completion_tokens_avg ?? 0) - (second.completion_tokens_avg ?? 0);
      metrics.accuracy_gain_per_1k_tokens = extraTokens > 0 ? (metrics.accuracy_gain / extraTokens) * 1000 : null;
    }

    const violations = variants.filter((v) => v.accuracy < c.minAccuracy).map((v) => `${v.name}: Genauigkeit unter ${c.minAccuracy}`);
    if (c.expectThinkingBetter && first && second && first.accuracy < second.accuracy) {
      violations.push(`${first.name} ist ungenauer als ${second.name}`);
    }
    return {
      status: violations.length ? 'failed' : 'passed',
      model,
      score: first?.accuracy ?? null,
      metrics,
      details: { variants, violations },
    };
  },
};
