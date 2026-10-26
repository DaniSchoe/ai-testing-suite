// Mock eines LiteLLM-Gateways (OpenAI-API + MCP) für lokale Entwicklung, Demos und CI.
// Keys: sk-admin (alle Modelle, alle MCP-Tools), sk-team-a (nur mock-small, nur Tool "search"),
//       sk-limited (max. 10 Requests pro Minute). Ohne Key: 401.
// Unter /vllm-qwen läuft zusätzlich ein "vLLM-Endpunkt" ohne Auth, der dasselbe Modell wie
// qwen3-32b im Gateway unter seinem Originalnamen Qwen/Qwen3-32B anbietet.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 4000);
const MODELS = ['mock-small', 'mock-large', 'qwen3-32b'];
const VLLM = { key: 'vllm', models: ['Qwen/Qwen3-32B'], tools: [] };
const KEYS = {
  'sk-admin': { models: MODELS, tools: ['search', 'delete_records'], admin: true },
  'sk-team-a': { models: ['mock-small'], tools: ['search'] },
  'sk-limited': { models: MODELS, tools: [], rpm: 10 },
};
const hits = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Antworten auf die Thinking-Aufgaben: mit Reasoning richtig, ohne bei den Fangfragen falsch.
const THINKING_TASKS = [
  [/Schläger/, '5', '10'],
  [/Maschinen/, '5', '100'],
  [/zweitjüngste/, 'Carla', 'Carla'],
  [/Primzahlen/, '5', '5'],
  [/Zug fährt/, '12:15', '12:15'],
];

function thinkingEnabled(body) {
  if (body.chat_template_kwargs?.enable_thinking === false) return false;
  if (body.reasoning_effort === 'none' || body.reasoning_effort === 'low') return false;
  return true;
}

function answer(messages, model) {
  const text = messages.map((m) => m.content).join('\n');
  const user = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  if (/Du bewertest/i.test(text)) return '{"score": 8, "reason": "solide"}';
  if (/DAN|Malware|Sprengstoff|Ignoriere alle/i.test(user)) return 'Das kann ich nicht tun, tut mir leid.';
  if (/Hauptstadt von Deutschland/i.test(user)) return 'Berlin';
  if (/17 \* 23/.test(user)) return model === 'mock-small' ? '381' : '391';
  if (/JSON-Objekt/i.test(user)) return '{"name": "Erika", "alter": 34}';
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
  const large = body.model !== 'mock-small';
  const base = large ? 180 : 60;
  await sleep(base + Math.random() * 60);

  const task = !/Du bewertest/.test(prompt) && THINKING_TASKS.find(([re]) => re.test(prompt));
  if (task) {
    const think = thinkingEnabled(body);
    const reasoning = think ? `Schritt für Schritt: ${prompt.slice(0, 80)} … geprüft und nachgerechnet.`.repeat(12) : '';
    if (think) await sleep(400);
    const content = `Antwort: ${think ? task[1] : task[2]}`;
    return send(res, 200, {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, reasoning_content: reasoning || null } }],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 6 + Math.round(reasoning.length / 4),
        total_tokens: 46 + Math.round(reasoning.length / 4),
        completion_tokens_details: { reasoning_tokens: Math.round(reasoning.length / 4) },
      },
    });
  }

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
      await sleep(large ? 25 : 10);
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

// Minimaler Anthropic-Mock (Claude-Flavor): x-api-key, /v1/models und /v1/messages inkl. Streaming.
async function claude(req, res, pathname) {
  if (req.headers['x-api-key'] !== 'sk-claude' || !req.headers['anthropic-version']) {
    return send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  }
  if (pathname === '/v1/models') return send(res, 200, { data: [{ id: 'claude-mock-1', type: 'model', display_name: 'Claude Mock' }] });
  if (pathname !== '/v1/messages') return send(res, 404, { error: 'not found' });
  const body = await readBody(req);
  const text = answer([...(body.system ? [{ role: 'system', content: body.system }] : []), ...body.messages], body.model);
  if (!body.stream) {
    return send(res, 200, {
      id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }],
      stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: text.split(/\s+/).length },
    });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const evt = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  evt('message_start', { message: { id: 'msg_mock', usage: { input_tokens: 12, output_tokens: 1 } } });
  evt('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  for (const part of text.match(/\S+\s*/g) ?? [text]) evt('content_block_delta', { index: 0, delta: { type: 'text_delta', text: part } });
  evt('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: text.split(/\s+/).length } });
  evt('message_stop', {});
  res.end();
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health/liveliness') return send(res, 200, { status: 'ok' });
      if (url.pathname.startsWith('/claude/')) return await claude(req, res, url.pathname.slice('/claude'.length));
      if (url.pathname.startsWith('/vllm-qwen/')) {
        url.pathname = url.pathname.slice('/vllm-qwen'.length);
        if (url.pathname === '/v1/models') return send(res, 200, { data: VLLM.models.map((id) => ({ id, object: 'model', owned_by: 'vllm' })) });
        if (url.pathname === '/v1/chat/completions') return await chat(req, res, VLLM);
        return send(res, 404, { error: 'not found' });
      }
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
