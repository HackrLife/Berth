// Provider adapters. Every model call in Berth goes through `runTurn`.
//
// Three wire formats cover all seven models:
//   anthropic  – Anthropic Messages API
//   openai     – OpenAI-compatible Chat Completions (OpenAI, xAI, OpenRouter)
//   gemini     – Google Gemini generateContent
//
// Calls go straight from the browser to the provider with the user's own key.

import { modelById } from './models.js';
import { state } from './store.js';

const OPENAI_COMPAT = {
  openai: 'https://api.openai.com/v1',
  xai: 'https://api.x.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

export class ProviderError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

/** Resolve which API, key and model id a catalogue entry uses right now. */
export function resolve(catalogueId) {
  const m = modelById(catalogueId);
  if (!m) throw new ProviderError(`Unknown model "${catalogueId}"`);
  let provider = m.provider;
  let model = state.modelIds[m.id] || m.defaultModel;
  if (m.id === 'grok' && state.grokRoute === 'openrouter') {
    provider = 'openrouter';
    model = state.modelIds['grok@openrouter'] || m.openrouterModel;
  }
  const key = state.keys[provider];
  const format = provider === 'anthropic' ? 'anthropic' : provider === 'google' ? 'gemini' : 'openai';
  return { entry: m, provider, model, key, format };
}

export function hasKey(catalogueId) {
  try { return Boolean(resolve(catalogueId).key); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Low-level HTTP

async function post(url, headers, body, signal) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ProviderError(
      'The request could not reach the provider.',
      'Check your connection. For Grok, switch Settings › Grok route to OpenRouter if direct calls are blocked by the browser.',
    );
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j.error?.message || j.message || JSON.stringify(j).slice(0, 300);
    } catch { /* ignore */ }
    const hint = res.status === 401 || res.status === 403
      ? 'The API key was rejected. Check it in Settings.'
      : res.status === 404
        ? 'The model id may be wrong. Load the available models in Settings.'
        : res.status === 429 ? 'Rate limit or quota reached on your provider account.' : '';
    throw new ProviderError(`${res.status}: ${detail || res.statusText}`, hint);
  }
  return res;
}

async function* sseLines(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('data:')) yield t.slice(5).trim();
    }
  }
  if (buf.trim().startsWith('data:')) yield buf.trim().slice(5).trim();
}

// ---------------------------------------------------------------------------
// Anthropic

const anthropic = {
  headers(key) {
    return {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  },
  toNative(history) {
    return history.map((m) => ({ role: m.role, content: m.content }));
  },
  tools(defs) {
    return defs.map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters }));
  },
  async call(r, { system, native, tools, signal }) {
    const body = { model: r.model, max_tokens: 4096, system, messages: native };
    if (tools?.length) body.tools = this.tools(tools);
    const res = await post('https://api.anthropic.com/v1/messages', this.headers(r.key), body, signal);
    const j = await res.json();
    const text = j.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const calls = j.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
    return { text, calls, assistant: { role: 'assistant', content: j.content }, usage: j.usage };
  },
  results(calls, outputs) {
    return [{
      role: 'user',
      content: calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: String(outputs[i]) })),
    }];
  },
  async stream(r, { system, native, onText, signal }) {
    const body = { model: r.model, max_tokens: 4096, system, messages: native, stream: true };
    const res = await post('https://api.anthropic.com/v1/messages', this.headers(r.key), body, signal);
    let text = '';
    for await (const data of sseLines(res)) {
      try {
        const ev = JSON.parse(data);
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          text += ev.delta.text;
          onText(text);
        }
        if (ev.type === 'error') throw new ProviderError(ev.error?.message || 'Stream error');
      } catch (e) { if (e instanceof ProviderError) throw e; }
    }
    return text;
  },
  async list(key) {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: this.headers(key) });
    if (!res.ok) throw new ProviderError(`Could not list models (${res.status})`);
    return (await res.json()).data.map((m) => m.id);
  },
};

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenAI, xAI, OpenRouter)

const openai = {
  headers(r) {
    const h = { 'content-type': 'application/json', authorization: `Bearer ${r.key}` };
    if (r.provider === 'openrouter') {
      h['HTTP-Referer'] = location.origin;
      h['X-Title'] = 'Berth';
    }
    return h;
  },
  url(r) { return `${OPENAI_COMPAT[r.provider]}/chat/completions`; },
  toNative(history, system) {
    return [{ role: 'system', content: system }, ...history.map((m) => ({ role: m.role, content: m.content }))];
  },
  tools(defs) {
    return defs.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } }));
  },
  async call(r, { native, tools, signal }) {
    const body = { model: r.model, messages: native };
    if (tools?.length) body.tools = this.tools(tools);
    const res = await post(this.url(r), this.headers(r), body, signal);
    const j = await res.json();
    const msg = j.choices?.[0]?.message || {};
    const calls = (msg.tool_calls || []).map((c) => {
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* leave empty */ }
      return { id: c.id, name: c.function.name, args };
    });
    const assistant = { role: 'assistant', content: msg.content ?? null };
    if (msg.tool_calls?.length) assistant.tool_calls = msg.tool_calls;
    return { text: msg.content || '', calls, assistant, usage: j.usage };
  },
  results(calls, outputs) {
    return calls.map((c, i) => ({ role: 'tool', tool_call_id: c.id, content: String(outputs[i]) }));
  },
  async stream(r, { native, onText, signal }) {
    const body = { model: r.model, messages: native, stream: true };
    const res = await post(this.url(r), this.headers(r), body, signal);
    let text = '';
    for await (const data of sseLines(res)) {
      if (data === '[DONE]') break;
      try {
        const ev = JSON.parse(data);
        if (ev.error) throw new ProviderError(ev.error.message || 'Stream error');
        const d = ev.choices?.[0]?.delta?.content;
        if (d) { text += d; onText(text); }
      } catch (e) { if (e instanceof ProviderError) throw e; }
    }
    return text;
  },
  async list(r) {
    const res = await fetch(`${OPENAI_COMPAT[r.provider]}/models`, {
      headers: r.provider === 'openrouter' ? {} : { authorization: `Bearer ${r.key}` },
    });
    if (!res.ok) throw new ProviderError(`Could not list models (${res.status})`);
    return (await res.json()).data.map((m) => m.id);
  },
};

// ---------------------------------------------------------------------------
// Google Gemini

const gemini = {
  base: 'https://generativelanguage.googleapis.com/v1beta',
  headers(key) { return { 'content-type': 'application/json', 'x-goog-api-key': key }; },
  toNative(history) {
    return history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  },
  body(system, native, tools) {
    const b = { contents: native, systemInstruction: { parts: [{ text: system }] } };
    if (tools?.length) {
      b.tools = [{ functionDeclarations: tools.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters })) }];
    }
    return b;
  },
  async call(r, { system, native, tools, signal }) {
    const url = `${this.base}/models/${encodeURIComponent(r.model)}:generateContent`;
    const res = await post(url, this.headers(r.key), this.body(system, native, tools), signal);
    const j = await res.json();
    const content = j.candidates?.[0]?.content || { role: 'model', parts: [] };
    const parts = content.parts || [];
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
    const calls = parts.filter((p) => p.functionCall).map((p, i) => ({
      id: `${p.functionCall.name}_${i}`, name: p.functionCall.name, args: p.functionCall.args || {},
    }));
    return { text, calls, assistant: { role: 'model', parts }, usage: j.usageMetadata };
  },
  results(calls, outputs) {
    return [{
      role: 'user',
      parts: calls.map((c, i) => ({ functionResponse: { name: c.name, response: { result: String(outputs[i]) } } })),
    }];
  },
  async stream(r, { system, native, onText, signal }) {
    const url = `${this.base}/models/${encodeURIComponent(r.model)}:streamGenerateContent?alt=sse`;
    const res = await post(url, this.headers(r.key), this.body(system, native), signal);
    let text = '';
    for await (const data of sseLines(res)) {
      try {
        const ev = JSON.parse(data);
        if (ev.error) throw new ProviderError(ev.error.message || 'Stream error');
        const parts = ev.candidates?.[0]?.content?.parts || [];
        const d = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
        if (d) { text += d; onText(text); }
      } catch (e) { if (e instanceof ProviderError) throw e; }
    }
    return text;
  },
  async list(key) {
    const res = await fetch(`${this.base}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw new ProviderError(`Could not list models (${res.status})`);
    return (await res.json()).models
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));
  },
};

const ADAPTERS = { anthropic, openai, gemini };

// ---------------------------------------------------------------------------
// Public API

/**
 * Run one assistant turn.
 * - Without tools the answer streams through `onText`.
 * - With tools the model may call them up to `maxSteps` times; each call goes
 *   through `onToolCall(call)` which returns the tool's output (or throws).
 */
export async function runTurn({ modelId, system, history, tools = [], maxSteps = 6, onText, onToolCall, signal }) {
  const r = resolve(modelId);
  if (!r.key) {
    throw new ProviderError(`No API key for ${r.provider}.`, 'Add it in Settings. Keys stay in this browser.');
  }
  const a = ADAPTERS[r.format];
  const native = a.toNative(history, system);

  if (!tools.length) {
    const text = await a.stream(r, { system, native, onText, signal });
    return { text, steps: [], resolved: r };
  }

  const steps = [];
  for (let i = 0; i < maxSteps; i++) {
    const out = await a.call(r, { system, native, tools, signal });
    if (!out.calls.length) {
      onText?.(out.text);
      return { text: out.text, steps, resolved: r };
    }
    native.push(out.assistant);
    const outputs = [];
    for (const call of out.calls) {
      let result;
      try {
        result = await onToolCall(call);
      } catch (err) {
        result = `Error: ${err.message}`;
      }
      steps.push({ ...call, result });
      outputs.push(typeof result === 'string' ? result : JSON.stringify(result));
    }
    native.push(...a.results(out.calls, outputs));
  }
  // Step budget used up: ask for a final answer without tools.
  native.push(r.format === 'gemini'
    ? { role: 'user', parts: [{ text: 'Step limit reached. Give your best final answer now without using tools.' }] }
    : { role: 'user', content: 'Step limit reached. Give your best final answer now without using tools.' });
  const final = await a.call(r, { system, native, tools: [], signal });
  onText?.(final.text);
  return { text: final.text, steps, resolved: r, stepLimitHit: true };
}

/** Single non-streaming completion, used for risk classification. */
export async function complete({ modelId, system, prompt, signal }) {
  const r = resolve(modelId);
  if (!r.key) throw new ProviderError(`No API key for ${r.provider}.`, 'Add it in Settings.');
  const a = ADAPTERS[r.format];
  const native = a.toNative([{ role: 'user', content: prompt }], system);
  const out = await a.call(r, { system, native, tools: [], signal });
  return out.text;
}

/** List the model ids a provider currently offers. */
export async function listModels(provider) {
  const key = state.keys[provider];
  if (provider === 'anthropic') return anthropic.list(key);
  if (provider === 'google') return gemini.list(key);
  return openai.list({ provider, key });
}
