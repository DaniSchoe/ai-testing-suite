// HTTP-Clients für OpenAI-kompatible APIs (LiteLLM, vLLM) und MCP-Server (Streamable HTTP).

export class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

function joinUrl(base, path) {
  return `${base.replace(/\/$/, '')}${path}`;
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function avg(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

const CLAUDE_STOP = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls' };

function claudeUsage(u = {}) {
  const prompt = u?.input_tokens ?? u?.prompt_tokens ?? 0;
  const completion = u?.output_tokens ?? u?.completion_tokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

// OpenAI-Inhaltsteile (text, image_url mit data:-URL) in Anthropic-Blöcke übersetzen.
function claudeContent(content) {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part.type !== 'image_url') return part.type === 'text' ? { type: 'text', text: part.text } : part;
    const url = part.image_url?.url ?? '';
    const m = url.match(/^data:([^;]+);base64,(.*)$/);
    return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'image', source: { type: 'url', url } };
  });
}

// OpenAI-Chat-Request in einen Anthropic-Messages-Request übersetzen.
export function toClaudeRequest(body) {
  const { model, messages = [], tools, tool_choice, max_tokens, max_completion_tokens, temperature, top_p, stop, thinking } = body;
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const out = {
    model,
    max_tokens: max_tokens ?? max_completion_tokens ?? 1024,
    messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: claudeContent(m.content) })),
  };
  if (system) out.system = system;
  if (temperature !== undefined) out.temperature = temperature;
  if (top_p !== undefined) out.top_p = top_p;
  if (stop) out.stop_sequences = [].concat(stop);
  if (thinking) out.thinking = thinking;
  if (tools?.length) {
    out.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
    if (tool_choice === 'required') out.tool_choice = { type: 'any' };
    else if (tool_choice?.function?.name) out.tool_choice = { type: 'tool', name: tool_choice.function.name };
    else if (tool_choice === 'auto') out.tool_choice = { type: 'auto' };
  }
  return out;
}

export class LlmClient {
  // baseUrl zeigt auf die OpenAI-kompatible Basis, z. B. https://litellm.example.com (ohne /v1).
  // flavor: 'openai' (Standard) oder 'claude' (Anthropic Messages API). Für Claude werden Requests und
  // Antworten ins OpenAI-Format übersetzt, damit alle Testarten unverändert funktionieren.
  constructor({ baseUrl, headers = {}, timeoutMs = 120_000, flavor = 'openai' }) {
    this.baseUrl = baseUrl;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.flavor = flavor;
  }

  async request(method, path, body, extraHeaders = {}) {
    const res = await fetch(joinUrl(this.baseUrl, path), {
      method,
      headers: { 'content-type': 'application/json', ...this.headers, ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, headers: res.headers, json, text };
  }

  async models() {
    const res = await this.request('GET', this.flavor === 'claude' ? '/v1/models?limit=1000' : '/v1/models');
    if (!res.ok) throw new HttpError(res.status, res.text);
    return (res.json?.data ?? []).map((m) => m.id);
  }

  async chat(body, extraHeaders) {
    const started = performance.now();
    if (this.flavor === 'claude') return this.claudeChat(body, extraHeaders, started);
    const res = await this.request('POST', '/v1/chat/completions', { ...body, stream: false }, extraHeaders);
    const latencyMs = performance.now() - started;
    if (!res.ok) throw new HttpError(res.status, res.text);
    const choice = res.json?.choices?.[0];
    const raw = choice?.message?.content ?? '';
    // Reasoning kommt je nach Server als eigenes Feld (vLLM: reasoning_content, neuer: reasoning)
    // oder als <think>-Block im Content.
    const think = raw.match(/<think>([\s\S]*?)<\/think>/);
    return {
      latencyMs,
      content: think ? raw.replace(think[0], '').trim() : raw,
      reasoning: choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? think?.[1]?.trim() ?? '',
      reasoningTokens: res.json?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      toolCalls: choice?.message?.tool_calls ?? [],
      finishReason: choice?.finish_reason,
      usage: res.json?.usage ?? {},
      headers: res.headers,
      raw: res.json,
    };
  }

  async claudeChat(body, extraHeaders, started) {
    const res = await this.request('POST', '/v1/messages', toClaudeRequest(body), extraHeaders);
    const latencyMs = performance.now() - started;
    if (!res.ok) throw new HttpError(res.status, res.text);
    const blocks = res.json?.content ?? [];
    return {
      latencyMs,
      content: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      reasoning: blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n'),
      reasoningTokens: null,
      toolCalls: blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })),
      finishReason: CLAUDE_STOP[res.json?.stop_reason] ?? res.json?.stop_reason,
      usage: claudeUsage(res.json?.usage),
      headers: res.headers,
      raw: res.json,
    };
  }

  // Streaming-Request mit Messung von Time-to-first-Token und Token-Durchsatz.
  async chatStream(body, extraHeaders = {}) {
    const started = performance.now();
    const claude = this.flavor === 'claude';
    const res = await fetch(joinUrl(this.baseUrl, claude ? '/v1/messages' : '/v1/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers, ...extraHeaders },
      body: JSON.stringify(claude ? { ...toClaudeRequest(body), stream: true } : { ...body, stream: true, stream_options: { include_usage: true } }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new HttpError(res.status, await res.text());

    let ttftMs = null;
    let content = '';
    let chunks = 0;
    let usage = null;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const part of res.body) {
      buffer += decoder.decode(part, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let evt;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        let delta;
        if (claude) {
          // message_start liefert die Eingabe-Tokens, message_delta die Ausgabe-Tokens, Text kommt als text_delta.
          if (evt.type === 'message_start') usage = claudeUsage(evt.message?.usage);
          if (evt.type === 'message_delta') usage = claudeUsage({ ...usage, input_tokens: usage?.prompt_tokens, ...evt.usage });
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') delta = evt.delta.text;
        } else {
          if (evt.usage) usage = evt.usage;
          delta = evt.choices?.[0]?.delta?.content;
        }
        if (delta) {
          if (ttftMs === null) ttftMs = performance.now() - started;
          content += delta;
          chunks += 1;
        }
      }
    }
    const totalMs = performance.now() - started;
    const completionTokens = usage?.completion_tokens ?? chunks;
    const genMs = ttftMs === null ? totalMs : totalMs - ttftMs;
    return {
      ttftMs,
      totalMs,
      content,
      usage: usage ?? { completion_tokens: chunks },
      completionTokens,
      tokensPerSecond: genMs > 0 ? (completionTokens / genMs) * 1000 : null,
    };
  }
}

// Minimaler MCP-Client für Streamable HTTP (JSON-RPC 2.0, Antwort als JSON oder SSE).
export class McpClient {
  constructor({ url, headers = {}, timeoutMs = 60_000 }) {
    this.url = url;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.nextId = 1;
  }

  async rpc(method, params, { notification = false } = {}) {
    const message = { jsonrpc: '2.0', method, ...(params ? { params } : {}) };
    if (!notification) message.id = this.nextId++;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (notification) return null;
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text);

    let payload;
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      // Letzte JSON-RPC-Antwort mit unserer id aus dem SSE-Stream nehmen.
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const evt = JSON.parse(line.slice(5).trim());
          if (evt.id === message.id) payload = evt;
        } catch {
          /* keine JSON-Zeile */
        }
      }
    } else {
      payload = JSON.parse(text);
    }
    if (!payload) throw new Error(`Keine Antwort auf ${method}`);
    if (payload.error) {
      const err = new Error(`MCP-Fehler ${payload.error.code}: ${payload.error.message}`);
      err.rpcError = payload.error;
      throw err;
    }
    return payload.result;
  }

  async initialize() {
    const result = await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'ai-testing-suite', version: '0.1.0' },
    });
    await this.rpc('notifications/initialized', undefined, { notification: true });
    return result;
  }

  async listTools() {
    return (await this.rpc('tools/list', {})).tools ?? [];
  }

  async callTool(name, args = {}) {
    return this.rpc('tools/call', { name, arguments: args });
  }
}
