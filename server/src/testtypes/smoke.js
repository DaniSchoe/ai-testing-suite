// Health & Verfügbarkeit: schneller Check, ob Endpoint und alle erwarteten Modelle antworten.
export default {
  type: 'smoke',
  label: 'Health / Smoke',
  description: 'Prüft Erreichbarkeit, /v1/models und eine Mini-Anfrage pro Modell. Gut als häufiger Schedule (z. B. alle 5 Minuten).',
  defaults: { models: [], prompt: 'Antworte nur mit OK.' },
  async run(ctx) {
    const llm = ctx.llm();
    const t0 = performance.now();
    const available = await llm.models();
    const listMs = performance.now() - t0;
    // Erwartet: konfigurierte Modelle, sonst alle bekannten des Katalogs (auch zuletzt verschwundene).
    const known = ctx.endpoint.modelRows.map((m) => m.name);
    const expected = ctx.config.models?.length ? ctx.config.models.map(ctx.resolveModel) : known.length ? known : available;
    const missing = expected.filter((m) => !available.includes(m));
    const checks = [];
    for (const model of expected.filter((m) => available.includes(m))) {
      try {
        const r = await llm.chat({ model, max_tokens: 5, messages: [{ role: 'user', content: ctx.config.prompt }] });
        checks.push({ model, ok: true, latencyMs: Math.round(r.latencyMs) });
      } catch (err) {
        checks.push({ model, ok: false, error: err.message });
      }
    }
    for (const m of missing) checks.push({ model: m, ok: false, error: 'nicht in /v1/models' });
    const healthy = checks.filter((x) => x.ok).length;
    return {
      status: healthy === checks.length && checks.length > 0 ? 'passed' : 'failed',
      score: checks.length ? healthy / checks.length : 0,
      metrics: { models_expected: expected.length, models_healthy: healthy, models_list_ms: listMs },
      details: { available, checks },
    };
  },
};
