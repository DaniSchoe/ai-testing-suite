import { check } from './assertions.js';

// MCP-Tests: Verbindung, Tool-Katalog je API-Key, Tool-Aufrufe und Berechtigungen.
export default {
  type: 'mcp',
  label: 'MCP',
  description:
    'Verbindet sich mit einem MCP-Server (Streamable HTTP), prüft sichtbare Tools je API-Key, Tool-Aufrufe und Freigaben.',
  endpointKinds: ['mcp', 'ai_proxy'],
  defaults: {
    // Pfad relativ zur Endpoint-URL; bei LiteLLM als MCP-Gateway z. B. "/mcp/".
    path: '',
    apiKeys: [
      {
        apiKey: '',
        expectTools: [],
        forbiddenTools: [],
      },
    ],
    calls: [{ apiKey: '', tool: '', arguments: {}, expect: 'allow', assert: [] }],
  },
  async run(ctx) {
    const c = ctx.config;
    const checks = [];
    const toolCatalog = {};

    // "personas"/"persona" sind die alten Namen für "apiKeys"/"apiKey".
    for (const p of c.apiKeys ?? c.personas ?? []) {
      const key = p.apiKey ?? p.persona;
      const label = key || ctx.apiKey?.name || 'Standard';
      const name = `Tools sichtbar für ${label}`;
      try {
        const mcp = ctx.mcp({ apiKey: key || undefined, path: c.path });
        const t0 = performance.now();
        const info = await mcp.initialize();
        const tools = (await mcp.listTools()).map((t) => t.name);
        toolCatalog[label] = tools;
        const missing = (p.expectTools ?? []).filter((t) => !tools.includes(t));
        const leaked = (p.forbiddenTools ?? []).filter((t) => tools.includes(t));
        checks.push({
          name,
          ok: missing.length === 0 && leaked.length === 0,
          server: info?.serverInfo,
          latencyMs: Math.round(performance.now() - t0),
          tools: tools.length,
          missing,
          leaked,
        });
      } catch (err) {
        checks.push({ name, ok: false, error: err.message });
      }
    }

    for (const call of c.calls ?? []) {
      if (!call.tool) continue;
      const callKey = call.apiKey ?? call.persona;
      const label = `${callKey || ctx.apiKey?.name || 'Standard'} → ${call.tool}`;
      try {
        const mcp = ctx.mcp({ apiKey: callKey || undefined, path: c.path });
        await mcp.initialize();
        const t0 = performance.now();
        let result;
        let denied = false;
        let error;
        try {
          result = await mcp.callTool(call.tool, call.arguments ?? {});
          denied = result?.isError === true && /forbid|denied|unauthori|permission|not allowed/i.test(JSON.stringify(result));
        } catch (err) {
          denied = err.status === 401 || err.status === 403 || Boolean(err.rpcError);
          error = err.message;
        }
        const text = (result?.content ?? []).map((x) => x.text ?? '').join('\n');
        let ok = call.expect === 'deny' ? denied : !denied && !error && result?.isError !== true;
        const outcomes = [];
        if (ok && call.expect !== 'deny') {
          for (const a of call.assert ?? []) {
            const o = await check(a, text, ctx);
            outcomes.push(o);
            ok &&= o.ok;
          }
        }
        checks.push({
          name: label,
          ok,
          expect: call.expect ?? 'allow',
          denied,
          error,
          latencyMs: Math.round(performance.now() - t0),
          outcomes,
          output: text.slice(0, 1000),
        });
      } catch (err) {
        checks.push({ name: label, ok: false, error: err.message });
      }
    }

    for (const ch of checks.filter((x) => !x.ok)) ctx.log('warn', `MCP-Check nicht bestanden: ${ch.name}`, ch);
    const passed = checks.filter((x) => x.ok).length;
    return {
      status: checks.length && passed === checks.length ? 'passed' : 'failed',
      score: checks.length ? passed / checks.length : 0,
      metrics: {
        checks: checks.length,
        passed,
        tools_leaked: checks.reduce((s, x) => s + (x.leaked?.length ?? 0), 0),
      },
      details: { checks, toolCatalog },
    };
  },
};
