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

export class LlmClient {
  // baseUrl zeigt auf die OpenAI-kompatible Basis, z. B. https://litellm.example.com (ohne /v1).
  constructor({ baseUrl, headers = {}, timeoutMs = 120_000 }) {
    this.baseUrl = baseUrl;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
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
    const res = await this.request('GET', '/v1/models');
    if (!res.ok) throw new HttpError(res.status, res.text);
    return (res.json?.data ?? []).map((m) => m.id);
  }

  async chat(body, extraHeaders) {
    const started = performance.now();
    const res = await this.request('POST', '/v1/chat/completions', { ...body, stream: false }, extraHeaders);
    const latencyMs = performance.now() - started;
    if (!res.ok) throw new HttpError(res.status, res.text);
    const choice = res.json?.choices?.[0];
    return {
      latencyMs,
      content: choice?.message?.content ?? '',
      toolCalls: choice?.message?.tool_calls ?? [],
      finishReason: choice?.finish_reason,
      usage: res.json?.usage ?? {},
      headers: res.headers,
      raw: res.json,
    };
  }

  // Streaming-Request mit Messung von Time-to-first-Token und Token-Durchsatz.
  async chatStream(body, extraHeaders = {}) {
    const started = performance.now();
    const res = await fetch(joinUrl(this.baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers, ...extraHeaders },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
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
        if (evt.usage) usage = evt.usage;
        const delta = evt.choices?.[0]?.delta?.content;
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
