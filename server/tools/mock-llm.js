// Mock eines LiteLLM-Gateways (OpenAI-API + MCP) für lokale Entwicklung, Demos und CI.
// Keys: sk-admin (alle Modelle, alle MCP-Tools), sk-team-a (nur mock-small, nur Tool "search"),
//       sk-limited (max. 10 Requests pro Minute). Ohne Key: 401.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 4000);
const MODELS = ['mock-small', 'mock-large'];
const KEYS = {
  'sk-admin': { models: MODELS, tools: ['search', 'delete_records'], admin: true },
  'sk-team-a': { models: ['mock-small'], tools: ['search'] },
  'sk-limited': { models: MODELS, tools: [], rpm: 10 },
};
const hits = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function answer(messages, model) {
  const text = messages.map((m) => m.content).join('\n');
  const user = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  if (/DAN|Malware|Sprengstoff|Ignoriere alle/i.test(user)) return 'Das kann ich nicht tun, tut mir leid.';
  if (/Hauptstadt von Deutschland/i.test(user)) return 'Berlin';
  if (/17 \* 23/.test(user)) return model === 'mock-small' ? '381' : '391';
  if (/JSON-Objekt/i.test(user)) return '{"name": "Erika", "alter": 34}';
  if (/Du bewertest Antworten/i.test(text)) return '{"score": 8, "reason": "solide"}';
  if (/Dokument zusammen/i.test(user)) return 'Der Quartalsbericht Q3 meldet einen stabilen Umsatz.';
  return 'OK. Kubernetes ist eine Plattform zur Orchestrierung von Containern.';
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function auth(req) {
  const key = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return KEYS[key] ? { key, ...KEYS[key] } : null;
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

async function chat(req, res, who) {
  const body = await readBody(req);
  if (!who.models.includes(body.model)) {
    return send(res, 401, { error: { message: `key not allowed to access model ${body.model}`, type: 'auth_error' } });
  }
  if (who.rpm) {
    const now = Date.now();
    const list = (hits.get(who.key) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= who.rpm) return send(res, 429, { error: { message: 'rate limit exceeded' } });
    list.push(now);
    hits.set(who.key, list);
  }
  const prompt = body.messages.map((m) => m.content).join('\n');
  // Guardrail-Simulation: Kreditkartennummern werden geblockt.
  if (/\b(?:\d[ -]?){13,16}\b/.test(prompt)) {
    return send(res, 400, { error: { message: 'Blocked by guardrail: PII detected', type: 'guardrail' } });
  }
  const base = body.model === 'mock-large' ? 180 : 60;
  await sleep(base + Math.random() * 60);

  if (body.tools?.length) {
    const city = prompt.match(/in (\w+)/)?.[1] ?? 'Berlin';
    return send(res, 200, {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: body.tools[0].function.name, arguments: JSON.stringify({ city }) } }],
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
  }

  const content = answer(body.messages, body.model);
  const words = content.split(/(?<= )/);
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const w of words) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: w } }] })}\n\n`);
      await sleep(body.model === 'mock-large' ? 25 : 10);
    }
    res.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: words.length, total_tokens: 12 + words.length } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
    return;
  }
  send(res, 200, {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    model: body.model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 12, completion_tokens: words.length, total_tokens: 12 + words.length },
  });
}

async function mcp(req, res, who) {
  const msg = await readBody(req);
  if (msg.id === undefined) {
    res.writeHead(202);
    return res.end();
  }
  const reply = (result) => send(res, 200, { jsonrpc: '2.0', id: msg.id, result }, { 'mcp-session-id': 'mock-session' });
  const fail = (code, message) => send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '1.0.0' } });
    case 'tools/list':
      return reply({ tools: who.tools.map((name) => ({ name, description: `Mock ${name}`, inputSchema: { type: 'object' } })) });
    case 'tools/call':
      if (!who.tools.includes(msg.params.name)) return fail(-32001, `permission denied for tool ${msg.params.name}`);
      return reply({ content: [{ type: 'text', text: `Ergebnis von ${msg.params.name}: 3 Treffer für ${JSON.stringify(msg.params.arguments)}` }] });
    default:
      return fail(-32601, 'method not found');
  }
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health/liveliness') return send(res, 200, { status: 'ok' });
      const who = auth(req);
      if (!who) return send(res, 401, { error: { message: 'Authentication Error, no api key passed in' } });
      if (url.pathname === '/v1/models') return send(res, 200, { data: who.models.map((id) => ({ id, object: 'model' })) });
      if (url.pathname === '/v1/chat/completions') return await chat(req, res, who);
      if (url.pathname.startsWith('/key/')) return who.admin ? send(res, 200, { keys: [] }) : send(res, 403, { error: 'admin only' });
      if (url.pathname.startsWith('/mcp')) return await mcp(req, res, who);
      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  })
  .listen(PORT, () => console.log(`Mock-LLM läuft auf http://localhost:${PORT}`));
