// Function Calling & strukturierte Ausgabe: wichtig für Agenten und MCP-Nutzung über das Modell.
export default {
  type: 'structured',
  label: 'Tool-Calling / JSON',
  description: 'Prüft, ob das Modell Tools korrekt aufruft (Name, gültige Argumente) und JSON-Schema-Ausgaben einhält.',
  defaults: {
    model: '',
    minScore: 0.8,
    cases: [
      {
        name: 'Wetter-Tool',
        prompt: 'Wie ist das Wetter in Hamburg?',
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Aktuelles Wetter für eine Stadt',
              parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
            },
          },
        ],
        expectTool: 'get_weather',
        expectArgs: { city: 'Hamburg' },
      },
    ],
  },
  async run(ctx) {
    const llm = ctx.llm();
    const model = ctx.model();
    const outcomes = [];
    for (const tc of ctx.config.cases) {
      try {
        const res = await llm.chat({
          model,
          temperature: 0,
          messages: [{ role: 'user', content: tc.prompt }],
          ...(tc.tools ? { tools: tc.tools, tool_choice: 'auto' } : {}),
          ...(tc.responseFormat ? { response_format: tc.responseFormat } : {}),
        });
        let ok = true;
        const notes = [];
        if (tc.expectTool) {
          const call = res.toolCalls.find((t) => t.function?.name === tc.expectTool);
          if (!call) {
            ok = false;
            notes.push(`Tool ${tc.expectTool} nicht aufgerufen`);
          } else {
            let args = {};
            try {
              args = JSON.parse(call.function.arguments || '{}');
            } catch {
              ok = false;
              notes.push('Argumente sind kein gültiges JSON');
            }
            for (const [k, v] of Object.entries(tc.expectArgs ?? {})) {
              if (String(args[k] ?? '').toLowerCase() !== String(v).toLowerCase()) {
                ok = false;
                notes.push(`Argument ${k}=${args[k]} statt ${v}`);
              }
            }
          }
        }
        if (tc.responseFormat) {
          try {
            JSON.parse(res.content);
          } catch {
            ok = false;
            notes.push('Antwort ist kein JSON');
          }
        }
        outcomes.push({ name: tc.name, ok, notes, toolCalls: res.toolCalls, latencyMs: Math.round(res.latencyMs) });
      } catch (err) {
        outcomes.push({ name: tc.name, ok: false, error: err.message });
      }
    }
    const passed = outcomes.filter((o) => o.ok).length;
    const score = outcomes.length ? passed / outcomes.length : 0;
    return {
      status: score >= ctx.config.minScore ? 'passed' : 'failed',
      model,
      score,
      metrics: { cases: outcomes.length, passed },
      details: { cases: outcomes },
    };
  },
};
