import { runCases } from './quality.js';
import quality from './quality.js';

// Gleicher Datensatz gegen mehrere Modelle: Qualität, Latenz und Tokenverbrauch nebeneinander.
export default {
  type: 'comparison',
  label: 'Modell-Vergleich',
  description: 'Führt denselben Datensatz gegen mehrere Modelle aus und vergleicht Score, Latenz und Tokens.',
  defaults: {
    models: [],
    maxTokens: 256,
    judgeModel: '',
    minScore: 0,
    cases: quality.defaults.cases,
  },
  async run(ctx) {
    const models = ctx.config.models?.length ? ctx.config.models : ctx.endpoint.models;
    if (!models?.length) throw new Error('Keine Modelle für den Vergleich angegeben');
    const table = [];
    for (const model of models) {
      ctx.log('info', `Vergleich: ${model}`);
      const r = await runCases(ctx, model, ctx.config.cases);
      table.push({
        model,
        score: r.score,
        latency_ms_avg: r.latencyAvg,
        tokens_total: r.results.reduce((s, x) => s + (x.tokens ?? 0), 0),
        cases: r.results,
      });
    }
    table.sort((a, b) => b.score - a.score || (a.latency_ms_avg ?? 0) - (b.latency_ms_avg ?? 0));
    const best = table[0];
    const failing = table.filter((t) => t.score < (ctx.config.minScore ?? 0));
    return {
      status: failing.length ? 'failed' : 'passed',
      model: models.join(', '),
      score: best.score,
      metrics: {
        models: models.length,
        best_model: best.model,
        best_score: best.score,
        ...Object.fromEntries(table.map((t) => [`score:${t.model}`, t.score])),
        ...Object.fromEntries(table.map((t) => [`latency_ms_avg:${t.model}`, t.latency_ms_avg])),
      },
      details: { ranking: table },
    };
  },
};
