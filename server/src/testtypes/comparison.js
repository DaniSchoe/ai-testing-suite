import { runCases } from './quality.js';
import quality from './quality.js';

// Gleicher Datensatz gegen mehrere Modelle: Qualität, Latenz und Tokenverbrauch nebeneinander.
// Ohne targets: Modelle des eigenen Endpoints. Mit targets auch endpointübergreifend, z. B.
// dasselbe Modell über LiteLLM und direkt am vLLM-Endpunkt (zeigt den Gateway-Overhead).
export default {
  type: 'comparison',
  label: 'Modell-Vergleich',
  description:
    'Führt denselben Datensatz gegen mehrere Modelle oder Endpoints aus (z. B. LiteLLM vs. vLLM direkt) und vergleicht Score, Latenz und Tokens.',
  // Wie die im Test-Builder gewählten Modelle wirken: each = ein Test je Modell, list = Modellliste im Test, first = erstes Modell, none = ignoriert.
  modelMode: 'list',
  defaults: {
    models: [],
    targets: [],
    maxTokens: 256,
    judgeModel: '',
    minScore: 0,
    cases: quality.defaults.cases,
  },
  async run(ctx) {
    const c = ctx.config;
    let targets;
    if (c.targets?.length) {
      targets = c.targets.map((t) => {
        const target = t.endpoint ? ctx.target(t.endpoint) : null;
        const resolved = target ? target.resolveModel(t.model) : { name: ctx.resolveModel(t.model), alias: t.model };
        return {
          label: `${resolved.alias} @ ${target ? target.endpoint.name : ctx.endpoint.name}`,
          model: resolved.name,
          alias: resolved.alias,
          endpoint: target ? target.endpoint.name : ctx.endpoint.name,
          llm: target ? target.llm() : ctx.llm(),
        };
      });
    } else {
      const models = c.models?.length ? c.models : ctx.endpoint.models;
      targets = (models ?? []).map((m) => {
        const name = ctx.resolveModel(m);
        return { label: ctx.aliasOf(name), model: name, alias: ctx.aliasOf(name), endpoint: ctx.endpoint.name, llm: ctx.llm() };
      });
    }
    if (!targets.length) throw new Error('Keine Modelle oder Ziele für den Vergleich angegeben');

    const table = [];
    for (const t of targets) {
      ctx.log('info', `Vergleich: ${t.label}`);
      const r = await runCases(ctx, t.model, c.cases, t.llm);
      table.push({
        label: t.label,
        model: t.model,
        alias: t.alias,
        endpoint: t.endpoint,
        score: r.score,
        latency_ms_avg: r.latencyAvg,
        tokens_total: r.results.reduce((s, x) => s + (x.tokens ?? 0), 0),
        cases: r.results,
      });
    }
    table.sort((a, b) => b.score - a.score || (a.latency_ms_avg ?? 0) - (b.latency_ms_avg ?? 0));
    const best = table[0];
    const failing = table.filter((t) => t.score < (c.minScore ?? 0));
    return {
      status: failing.length ? 'failed' : 'passed',
      model: table.map((t) => t.label).join(', '),
      modelAlias: [...new Set(table.map((t) => t.alias))].join(', '),
      score: best.score,
      metrics: {
        targets: table.length,
        best: best.label,
        best_score: best.score,
        ...Object.fromEntries(table.map((t) => [`score:${t.label}`, t.score])),
        ...Object.fromEntries(table.map((t) => [`latency_ms_avg:${t.label}`, t.latency_ms_avg])),
      },
      details: { ranking: table },
    };
  },
};
