import { buildMessages, checkAll } from './assertions.js';
import { avg } from '../runner/clients.js';

// Führt einen Testdatensatz gegen ein Modell aus. Wird auch vom Modell-Vergleich genutzt.
export async function runCases(ctx, model, cases, llm = ctx.llm()) {
  const results = [];
  for (const testCase of cases) {
    if (ctx.signal.aborted) break;
    try {
      const res = await llm.chat({
        model,
        temperature: testCase.temperature ?? ctx.config.temperature ?? 0,
        max_tokens: testCase.maxTokens ?? ctx.config.maxTokens,
        messages: buildMessages(testCase),
      });
      const verdict = await checkAll(testCase.assert, res.content, ctx);
      results.push({
        name: testCase.name ?? testCase.prompt?.slice(0, 60),
        ok: verdict.ok,
        outcomes: verdict.outcomes,
        latencyMs: Math.round(res.latencyMs),
        tokens: res.usage?.total_tokens ?? null,
        answer: res.content.slice(0, 2000),
      });
    } catch (err) {
      results.push({ name: testCase.name ?? testCase.prompt?.slice(0, 60), ok: false, error: err.message });
    }
  }
  const passed = results.filter((r) => r.ok).length;
  return {
    results,
    score: results.length ? passed / results.length : 0,
    latencyAvg: avg(results.filter((r) => r.latencyMs).map((r) => r.latencyMs)),
  };
}

export default {
  type: 'quality',
  label: 'Qualität',
  description: 'Prüft Antworten gegen einen Testdatensatz (Regeln, Regex, JSON, LLM-as-a-Judge). Score = Anteil bestandener Fälle.',
  defaults: {
    model: '',
    minScore: 0.8,
    maxTokens: 256,
    judgeModel: '',
    cases: [
      {
        name: 'Faktenwissen',
        prompt: 'Was ist die Hauptstadt von Deutschland? Antworte mit einem Wort.',
        assert: [{ type: 'contains', value: 'Berlin' }],
      },
      {
        name: 'Rechnen',
        prompt: 'Was ist 17 * 23? Antworte nur mit der Zahl.',
        assert: [{ type: 'regex', value: '\\b391\\b' }],
      },
      {
        name: 'JSON-Format',
        prompt: 'Gib ein JSON-Objekt mit den Feldern "name" und "alter" für eine fiktive Person zurück. Nur JSON.',
        assert: [{ type: 'json', required: ['name', 'alter'] }],
      },
    ],
  },
  async run(ctx) {
    const model = ctx.model();
    ctx.log('info', `${ctx.config.cases.length} Fälle gegen ${model}`);
    const { results, score, latencyAvg } = await runCases(ctx, model, ctx.config.cases);
    for (const r of results.filter((x) => !x.ok)) ctx.log('warn', `Fall nicht bestanden: ${r.name}`, r);
    return {
      status: score >= ctx.config.minScore ? 'passed' : 'failed',
      model,
      score,
      metrics: { cases: results.length, passed: results.filter((r) => r.ok).length, latency_ms_avg: latencyAvg },
      details: { cases: results },
    };
  },
};
