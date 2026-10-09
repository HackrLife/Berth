// Berth API — one Supabase Edge Function serving demo mode and governed retrieval.
//
//   GET    /status            what this deployment supports
//   POST   /proxy             forward a model request with the server's keys (demo mode)
//   GET    /docs              list the visitor's documents plus shared samples
//   POST   /docs              index a document (text is redacted in the browser)
//   DELETE /docs?id=…|all=1   delete one document, or erase everything the visitor stored
//   POST   /search            vector search under row-level security
//
// Every database transaction runs as the restricted `berth_app` role with the
// visitor id set, so row-level security decides what is visible.

import postgres from 'npm:postgres@3.4.4';
import { SAMPLES } from './samples.ts';

const env = (k: string, d = '') => Deno.env.get(k) || d;

const ALLOWED_ORIGINS = [
  'https://hackrlife.github.io',
  'http://localhost:8000', 'http://localhost:8765', 'http://127.0.0.1:8000', 'http://127.0.0.1:8765',
  ...env('BERTH_ALLOWED_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean),
];

const LIMITS = {
  perVisitor: Number(env('DEMO_VISITOR_LIMIT', '40')),
  global: Number(env('DEMO_DAILY_LIMIT', '400')),
};

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMS = 512;
const MAX_CHARS = 150_000;
const MAX_DOCS = 10;
const MAX_OUT = 2048;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ---------------------------------------------------------------------------
// HTTP helpers

function cors(req: Request) {
  const origin = req.headers.get('origin') || '';
  return {
    'access-control-allow-origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, x-berth-visitor, x-region, authorization, apikey',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function visitorOf(req: Request) {
  const v = req.headers.get('x-berth-visitor') || '';
  if (!/^v_[a-z0-9]{12,40}$/.test(v)) throw new HttpError(400, 'Missing or invalid visitor id');
  return v;
}

const clientIp = (req: Request) => (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

// ---------------------------------------------------------------------------
// Database

let _sql: ReturnType<typeof postgres> | null = null;
function db() {
  const url = env('SUPABASE_DB_URL');
  if (!url) return null;
  if (!_sql) _sql = postgres(url, { prepare: false, max: 3, idle_timeout: 20 });
  return _sql;
}

/** Run queries as the restricted role, scoped to one owner. */
async function asOwner<T>(owner: string, fn: (tx: any) => Promise<T>): Promise<T> {
  const sql = db();
  if (!sql) throw new HttpError(503, 'Retrieval is not configured on this deployment');
  return sql.begin(async (tx: any) => {
    await tx`set local role berth_app`;
    await tx`select set_config('berth.owner', ${owner}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

async function logEvent(tx: any, owner: string, event: string, detail: Record<string, unknown> = {}) {
  await tx`insert into berth.events (owner, event, detail) values (${owner}, ${event}, ${tx.json(detail)})`;
}

/** Count one request against today's demo limits. */
async function spend(visitor: string, ip: string) {
  await asOwner(visitor, async (tx) => {
    const [g] = await tx`select berth.bump_usage('global') as n`;
    const [v] = await tx`select berth.bump_usage(${`visitor:${visitor}`}) as n`;
    const [i] = await tx`select berth.bump_usage(${`ip:${ip}`}) as n`;
    if (g.n > LIMITS.global) throw new HttpError(429, 'The demo has reached its daily limit. Add your own API keys in Settings to keep going.');
    if (v.n > LIMITS.perVisitor || i.n > LIMITS.perVisitor * 3) {
      throw new HttpError(429, `You have used today's ${LIMITS.perVisitor} demo requests. Add your own API keys in Settings to keep going.`);
    }
  });
}

// ---------------------------------------------------------------------------
// Embeddings and chunking

async function embed(texts: string[]) {
  const key = env('OPENAI_API_KEY');
  if (!key) throw new HttpError(503, 'Embeddings need the OPENAI_API_KEY secret');
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 96) {
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts.slice(i, i + 96), dimensions: EMBED_DIMS }),
    });
    if (!r.ok) throw new HttpError(502, `Embedding failed (${r.status})`);
    const j = await r.json();
    for (const d of j.data) out.push(d.embedding);
  }
  return out;
}

const vectorLiteral = (v: number[]) => `[${v.map((x) => Number(x).toFixed(6)).join(',')}]`;

function chunkText(text: string, size = 700, overlap = 120) {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const parts = clean.split(/\n\n|(?<=[.!?])\s+(?=[A-Z0-9])/);
  const chunks: string[] = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + '\n' + p).length > size && cur) {
      chunks.push(cur.trim());
      cur = cur.slice(-overlap) + '\n' + p;
    } else {
      cur = cur ? `${cur}\n${p}` : p;
    }
    while (cur.length > size * 1.6) {
      chunks.push(cur.slice(0, size).trim());
      cur = cur.slice(size - overlap);
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter((c) => c.length > 20);
}

async function insertChunks(tx: any, documentId: string, owner: string, chunks: string[], vectors: number[][]) {
  const rows = chunks.map((content, idx) => ({ document_id: documentId, owner, idx, content, embedding: vectorLiteral(vectors[idx]) }));
  for (let i = 0; i < rows.length; i += 100) {
    await tx`insert into berth.chunks ${tx(rows.slice(i, i + 100), 'document_id', 'owner', 'idx', 'content', 'embedding')}`;
  }
}

// ---------------------------------------------------------------------------
// Sample documents (fictional company), indexed once on first use

async function ensureSamples() {
  await asOwner('sample', async (tx) => {
    await tx`select pg_advisory_xact_lock(424242)`;
    const [{ n }] = await tx`select count(*)::int as n from berth.documents where owner = 'sample'`;
    if (n > 0) return;
    for (const s of SAMPLES) {
      const chunks = chunkText(s.text);
      const vectors = await embed(chunks);
      const [doc] = await tx`insert into berth.documents (owner, name, chars, chunk_count)
        values ('sample', ${s.name}, ${s.text.length}, ${chunks.length}) returning id`;
      await insertChunks(tx, doc.id, 'sample', chunks, vectors);
    }
  });
}

// ---------------------------------------------------------------------------
// Demo proxy

const ROUTES = [
  { provider: 'anthropic', key: 'ANTHROPIC_API_KEY', match: /^https:\/\/api\.anthropic\.com\/v1\/messages$/ },
  { provider: 'openai', key: 'OPENAI_API_KEY', match: /^https:\/\/api\.openai\.com\/v1\/chat\/completions$/ },
  { provider: 'xai', key: 'XAI_API_KEY', match: /^https:\/\/api\.x\.ai\/v1\/chat\/completions$/ },
  { provider: 'openrouter', key: 'OPENROUTER_API_KEY', match: /^https:\/\/openrouter\.ai\/api\/v1\/chat\/completions$/ },
  { provider: 'google', key: 'GEMINI_API_KEY', match: /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent\?alt=sse)$/ },
];

const DEFAULT_MODELS = [
  'claude-sonnet-5', 'claude-haiku-4-5-20251001',
  'gpt-5-mini', 'gpt-4o-mini',
  'gemini-2.5-flash', 'gemini-2.5-flash-lite',
  'grok-3-mini', 'x-ai/grok-3-mini',
  'mistralai/mistral-small-3.2-24b-instruct', 'meta-llama/llama-3.3-70b-instruct', 'qwen/qwen-2.5-72b-instruct',
];

const allowedModels = () => [...new Set([...DEFAULT_MODELS, ...env('DEMO_MODELS').split(',').map((s) => s.trim()).filter(Boolean)])];

async function proxy(req: Request) {
  const visitor = visitorOf(req);
  const { url, body } = await req.json();
  const route = ROUTES.find((r) => r.match.test(String(url)));
  if (!route) throw new HttpError(400, 'This endpoint is not available in demo mode.');
  const key = env(route.key);
  if (!key) throw new HttpError(503, `The demo has no ${route.provider} key configured. Add your own key in Settings.`);
  const model = route.provider === 'google' ? String(url).match(route.match)![1] : body?.model;
  if (!allowedModels().includes(model)) throw new HttpError(400, `Model "${model}" is not enabled for the demo. Add your own key in Settings to use it.`);

  if (route.provider === 'anthropic') body.max_tokens = Math.min(Number(body.max_tokens) || MAX_OUT, MAX_OUT);
  else if (route.provider === 'openai') body.max_completion_tokens = Math.min(Number(body.max_completion_tokens) || 4096, 4096);
  else if (route.provider === 'google') body.generationConfig = { ...(body.generationConfig || {}), maxOutputTokens: MAX_OUT };
  else body.max_tokens = Math.min(Number(body.max_tokens) || MAX_OUT, MAX_OUT);

  await spend(visitor, clientIp(req));

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (route.provider === 'anthropic') Object.assign(headers, { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
  else if (route.provider === 'google') headers['x-goog-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  if (route.provider === 'openrouter') Object.assign(headers, { 'HTTP-Referer': 'https://github.com/HackrLife/Berth', 'X-Title': 'Berth' });

  const upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { ...cors(req), 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' },
  });
}

// ---------------------------------------------------------------------------
// Handlers

function status(req: Request) {
  const providers = {
    anthropic: Boolean(env('ANTHROPIC_API_KEY')),
    openai: Boolean(env('OPENAI_API_KEY')),
    google: Boolean(env('GEMINI_API_KEY')),
    xai: Boolean(env('XAI_API_KEY')),
    openrouter: Boolean(env('OPENROUTER_API_KEY')),
  };
  return json(req, 200, {
    demo: Object.values(providers).some(Boolean),
    providers,
    models: allowedModels(),
    retrieval: Boolean(db()) && providers.openai,
    embedding: EMBED_MODEL,
    storage: 'Supabase · Sydney (ap-southeast-2)',
    limits: LIMITS,
  });
}

async function documents(req: Request) {
  const visitor = visitorOf(req);
  if (req.method === 'GET') {
    await ensureSamples();
    const docs = await asOwner(visitor, (tx) => tx`
      select id, name, chars, chunk_count, redactions, created_at, owner = 'sample' as sample
      from berth.documents order by sample desc, created_at desc`);
    return json(req, 200, { documents: docs });
  }
  if (req.method === 'POST') {
    const { name, text, redactions = {} } = await req.json();
    const body = String(text || '').trim();
    if (!body) throw new HttpError(400, 'The document has no text.');
    if (body.length > MAX_CHARS) throw new HttpError(413, `Documents are limited to ${MAX_CHARS.toLocaleString()} characters in the demo.`);
    await spend(visitor, clientIp(req));
    const chunks = chunkText(body).slice(0, 400);
    const vectors = await embed(chunks);
    const doc = await asOwner(visitor, async (tx) => {
      const [{ n }] = await tx`select count(*)::int as n from berth.documents where owner = ${visitor}`;
      if (n >= MAX_DOCS) throw new HttpError(409, `You can keep up to ${MAX_DOCS} documents in the demo. Delete one first.`);
      const [d] = await tx`insert into berth.documents (owner, name, chars, chunk_count, redactions)
        values (${visitor}, ${String(name || 'Untitled').slice(0, 200)}, ${body.length}, ${chunks.length}, ${tx.json(redactions)})
        returning id, name, chars, chunk_count, redactions, created_at`;
      await insertChunks(tx, d.id, visitor, chunks, vectors);
      await logEvent(tx, visitor, 'document.indexed', { id: d.id, chunks: chunks.length, chars: body.length, redactions });
      return d;
    });
    return json(req, 201, { document: doc });
  }
  if (req.method === 'DELETE') {
    const url = new URL(req.url);
    const all = url.searchParams.get('all') === '1';
    const id = url.searchParams.get('id');
    const out = await asOwner(visitor, async (tx) => {
      if (all) {
        const r = await tx`delete from berth.documents where owner = ${visitor} returning id`;
        await tx`delete from berth.events where owner = ${visitor}`;
        await logEvent(tx, visitor, 'erasure.completed', { documents: r.length });
        return { deleted: r.length, erased: true };
      }
      if (!id) throw new HttpError(400, 'Missing id');
      const r = await tx`delete from berth.documents where id = ${id} and owner = ${visitor} returning id`;
      await logEvent(tx, visitor, 'document.deleted', { id, found: r.length > 0 });
      return { deleted: r.length };
    });
    return json(req, 200, out);
  }
  throw new HttpError(405, 'Method not allowed');
}

async function search(req: Request) {
  const visitor = visitorOf(req);
  const { query, k = 5, documentIds = null } = await req.json();
  const q = String(query || '').trim().slice(0, 4000);
  if (!q) throw new HttpError(400, 'Empty query');
  await ensureSamples();
  const [vector] = await embed([q]);
  const ids = Array.isArray(documentIds) && documentIds.length ? documentIds.map(String) : null;
  const results = await asOwner(visitor, async (tx) => {
    const rows = await tx`
      select id, document_id, document_name, idx, content, similarity
      from berth.match_chunks(${vectorLiteral(vector)}::extensions.vector, ${Math.min(Number(k) || 5, 12)}, ${ids}::uuid[])`;
    await logEvent(tx, visitor, 'retrieval', { k, returned: rows.length, top: rows[0]?.similarity ?? null });
    return rows;
  });
  return json(req, 200, { results });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  const route = new URL(req.url).pathname.split('/').filter(Boolean).pop();
  try {
    if (route === 'status') return status(req);
    if (route === 'proxy' && req.method === 'POST') return await proxy(req);
    if (route === 'docs') return await documents(req);
    if (route === 'search' && req.method === 'POST') return await search(req);
    return json(req, 404, { error: 'Not found' });
  } catch (err) {
    const statusCode = err instanceof HttpError ? err.status : 500;
    if (statusCode >= 500) console.error(err);
    return json(req, statusCode, { error: (err as Error).message || 'Server error' });
  }
});
