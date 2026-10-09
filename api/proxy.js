// POST /api/proxy — demo mode. Forwards a model request to the provider with
// the server's own key, so visitors can use Berth without keys of their own.
// Only known provider endpoints and an allow-list of models are accepted, and
// output length and daily request counts are capped.

import { env, send, readJson, visitorOf, clientIp, spend, fail } from './_lib.js';

const ROUTES = [
  { provider: 'anthropic', key: 'ANTHROPIC_API_KEY', match: /^https:\/\/api\.anthropic\.com\/v1\/messages$/ },
  { provider: 'openai', key: 'OPENAI_API_KEY', match: /^https:\/\/api\.openai\.com\/v1\/chat\/completions$/ },
  { provider: 'xai', key: 'XAI_API_KEY', match: /^https:\/\/api\.x\.ai\/v1\/chat\/completions$/ },
  { provider: 'openrouter', key: 'OPENROUTER_API_KEY', match: /^https:\/\/openrouter\.ai\/api\/v1\/chat\/completions$/ },
  { provider: 'google', key: 'GEMINI_API_KEY', match: /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent\?alt=sse)$/ },
];

// Models the demo will pay for. Extend with DEMO_MODELS (comma separated).
const DEFAULT_MODELS = [
  'claude-sonnet-5', 'claude-haiku-4-5-20251001',
  'gpt-5-mini', 'gpt-4o-mini',
  'gemini-2.5-flash', 'gemini-2.5-flash-lite',
  'grok-3-mini', 'x-ai/grok-3-mini',
  'mistralai/mistral-small-3.2-24b-instruct', 'meta-llama/llama-3.3-70b-instruct', 'qwen/qwen-2.5-72b-instruct',
];

const MAX_OUT = 2048;

export function allowedModels() {
  const extra = env('DEMO_MODELS').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...DEFAULT_MODELS, ...extra])];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  try {
    const visitor = visitorOf(req);
    const { url, body } = await readJson(req);
    const route = ROUTES.find((r) => r.match.test(String(url)));
    if (!route) return send(res, 400, { error: 'This endpoint is not available in demo mode.' });
    const key = env(route.key);
    if (!key) return send(res, 503, { error: `The demo has no ${route.provider} key configured. Add your own key in Settings.` });

    const model = route.provider === 'google' ? String(url).match(route.match)[1] : body?.model;
    if (!allowedModels().includes(model)) {
      return send(res, 400, { error: `Model "${model}" is not enabled for the demo. Add your own key in Settings to use it.` });
    }

    // Cap output length.
    if (route.provider === 'anthropic') body.max_tokens = Math.min(Number(body.max_tokens) || MAX_OUT, MAX_OUT);
    else if (route.provider === 'openai') body.max_completion_tokens = Math.min(Number(body.max_completion_tokens) || 4096, 4096);
    else if (route.provider === 'google') body.generationConfig = { ...(body.generationConfig || {}), maxOutputTokens: MAX_OUT };
    else body.max_tokens = Math.min(Number(body.max_tokens) || MAX_OUT, MAX_OUT);

    await spend(visitor, clientIp(req));

    const headers = { 'content-type': 'application/json' };
    if (route.provider === 'anthropic') Object.assign(headers, { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
    else if (route.provider === 'google') headers['x-goog-api-key'] = key;
    else headers.authorization = `Bearer ${key}`;
    if (route.provider === 'openrouter') Object.assign(headers, { 'HTTP-Referer': 'https://github.com/HackrLife/Berth', 'X-Title': 'Berth' });

    const upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    res.statusCode = upstream.status;
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    fail(res, err);
  }
}
