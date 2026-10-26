// Rate-Limits & Budgets: Werden RPM/TPM-Limits (z. B. LiteLLM Virtual Keys) tatsächlich durchgesetzt?
export default {
  type: 'ratelimit',
  label: 'Rate-Limits',
  description: 'Sendet einen Burst an Requests und erwartet ab dem konfigurierten Limit HTTP 429 (RPM/TPM, Budgets pro Key/Team).',
  defaults: { model: '', burst: 30, expectedLimit: 10, tolerance: 2 },
  async run(ctx) {
    const c = ctx.config;
    const llm = ctx.llm();
    const model = ctx.model();
    const statuses = await Promise.all(
      Array.from({ length: c.burst }, () =>
        llm
          .request('POST', '/v1/chat/completions', { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
          .then((r) => ({ status: r.status, remaining: r.headers.get('x-ratelimit-remaining-requests') }))
          .catch((err) => ({ status: 0, error: err.message })),
      ),
    );
    const ok200 = statuses.filter((s) => s.status === 200).length;
    const limited = statuses.filter((s) => s.status === 429).length;
    const withinTolerance = Math.abs(ok200 - c.expectedLimit) <= c.tolerance;
    const ok = limited > 0 && withinTolerance;
    ctx.log('info', `${ok200} erfolgreich, ${limited} mit 429 begrenzt (erwartet ~${c.expectedLimit} erfolgreich)`);
    return {
      status: ok ? 'passed' : 'failed',
      model,
      metrics: { burst: c.burst, succeeded: ok200, rate_limited: limited, other_errors: c.burst - ok200 - limited },
      details: { statuses },
    };
  },
};
