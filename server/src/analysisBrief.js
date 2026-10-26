// Ergebnis eines Tests auf das Wesentliche verkürzen, damit der Prompt der KI-Analyse klein bleibt.
const round = (v, d = 2) => (typeof v === 'number' ? Math.round(v * 10 ** d) / 10 ** d : v);

export function briefResult(r) {
  const d = r.details ?? {};
  const out = {
    test: r.test_name,
    art: r.type,
    endpoint: r.endpoint_name,
    modell: r.model_alias ?? r.model,
    status: r.status,
    score: round(r.score),
    dauer_s: r.duration_ms ? round(r.duration_ms / 1000, 1) : null,
    kennzahlen: Object.fromEntries(Object.entries(r.metrics ?? {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, round(v)])),
  };
  if (r.error) out.fehler = String(r.error).slice(0, 300);
  if (Array.isArray(d.cases)) {
    out.faelle = d.cases.slice(0, 12).map((c) => ({
      name: c.name ?? c.model,
      ok: c.ok,
      stufe: c.difficulty,
      hinweis: (c.error ?? c.notes?.join('; ') ?? c.outcomes?.map((o) => o.message).join('; '))?.slice(0, 200),
    }));
  }
  if (Array.isArray(d.stages)) {
    out.laststufen = d.stages.map((s) => ({
      parallel: s.concurrency,
      req_s: round(s.requests_per_s, 1),
      fehlerquote: round(s.error_rate),
      p95_ms: round(s.latency_ms_p95, 0),
      gedrosselt_429: s.rate_limited,
      p95_nach_schwierigkeit_ms: Object.fromEntries(Object.entries(s.by_difficulty ?? {}).map(([k, v]) => [k, round(v.latency_ms_p95, 0)])),
    }));
  }
  if (Array.isArray(d.variants)) out.varianten = d.variants.map((v) => ({ name: v.name, genauigkeit: round(v.accuracy), tokens: round(v.completion_tokens_avg, 0), latenz_ms: round(v.latency_ms_avg, 0) }));
  if (d.violations?.length) out.verletzte_schwellen = d.violations;
  const regs = d.regression?.regressions;
  if (regs?.length) out.regression = regs.map((x) => ({ kennzahl: x.metric, vorher: round(x.baseline), jetzt: round(x.current) }));
  return out;
}

