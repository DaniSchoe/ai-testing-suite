// Berechtigungstests: Darf Persona X Modell Y bzw. Admin-Route Z nutzen?
// Typischer Einsatz: LiteLLM mit Keycloak-JWT-Auth oder Virtual Keys pro Team.
export default {
  type: 'access',
  label: 'Zugriff / Berechtigungen',
  description:
    'Prüft pro Test-Persona, ob Modelle und API-Routen erlaubt bzw. verweigert werden (RBAC, Teams, Virtual Keys).',
  defaults: {
    cases: [
      { persona: '', model: '', expect: 'allow' },
      { persona: '', model: '', expect: 'deny' },
      { persona: '', method: 'GET', path: '/key/list', expect: 'deny' },
      { persona: null, model: '', expect: 'deny', name: 'Ohne Credentials' },
    ],
  },
  async run(ctx) {
    const outcomes = [];
    for (const tc of ctx.config.cases) {
      // persona: null -> ganz ohne Credentials; persona fehlt/leer -> Persona der Testdefinition.
      const llm = tc.persona === null ? ctx.llm({ anonymous: true }) : ctx.llm({ persona: tc.persona || undefined });
      let status;
      let error;
      try {
        if (tc.path) {
          status = (await llm.request(tc.method ?? 'GET', tc.path, tc.body)).status;
        } else {
          const res = await llm.request('POST', '/v1/chat/completions', {
            model: tc.model || ctx.model(),
            max_tokens: 5,
            messages: [{ role: 'user', content: 'ping' }],
          });
          status = res.status;
        }
      } catch (err) {
        error = err.message;
      }
      const allowed = status >= 200 && status < 300;
      const denied = status === 401 || status === 403 || (status === 400 && tc.denyOn400 !== false);
      const ok = tc.expect === 'allow' ? allowed : denied;
      const label = tc.name ?? `${tc.persona ?? 'anonym'} → ${tc.path ?? tc.model ?? ctx.model()}`;
      if (!ok) ctx.log('warn', `Berechtigung falsch: ${label} erwartet ${tc.expect}, erhalten ${status ?? error}`);
      outcomes.push({ name: label, persona: tc.persona, target: tc.path ?? tc.model, expect: tc.expect, status, ok, error });
    }
    const passed = outcomes.filter((o) => o.ok).length;
    return {
      status: passed === outcomes.length ? 'passed' : 'failed',
      score: outcomes.length ? passed / outcomes.length : 0,
      metrics: {
        cases: outcomes.length,
        passed,
        // Falsch erlaubt ist kritischer als falsch verweigert.
        false_allow: outcomes.filter((o) => !o.ok && o.expect === 'deny').length,
        false_deny: outcomes.filter((o) => !o.ok && o.expect === 'allow').length,
      },
      details: { cases: outcomes },
    };
  },
};
