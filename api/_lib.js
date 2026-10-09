// Shared helpers for Berth's Vercel functions. Files starting with "_" are
// not exposed as endpoints.

import postgres from 'postgres';

export const env = (k, d = '') => process.env[k] || d;

// ---------------------------------------------------------------------------
// Requests

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export async function readJson(req, limit = 400_000) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

/** Visitor ids are random strings the browser creates; nothing personal. */
export function visitorOf(req) {
  const v = String(req.headers['x-berth-visitor'] || '');
  if (!/^v_[a-z0-9]{12,40}$/.test(v)) throw Object.assign(new Error('Missing or invalid visitor id'), { status: 400 });
  return v;
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

// ---------------------------------------------------------------------------
// Database (restricted role, row-level security)

// Connection: set BERTH_DATABASE_URL, or just BERTH_DB_PASSWORD and Berth
// builds the pooler URL for its Supabase project (trying both pooler clusters).
const PROJECT_REF = 'cxtcwslqzrzjaulqcvvu';
const POOLER_HOSTS = ['aws-0-ap-southeast-2.pooler.supabase.com', 'aws-1-ap-southeast-2.pooler.supabase.com'];

let _sql = null;
let _ready = null;

export function dbConfigured() {
  return Boolean(env('BERTH_DATABASE_URL') || env('BERTH_DB_PASSWORD'));
}

async function connect() {
  const explicit = env('BERTH_DATABASE_URL');
  const candidates = explicit
    ? [explicit]
    : [env('BERTH_DB_HOST'), ...POOLER_HOSTS].filter(Boolean).map((h) =>
      `postgresql://berth_app.${PROJECT_REF}:${encodeURIComponent(env('BERTH_DB_PASSWORD'))}@${h}:6543/postgres`);
  let last;
  for (const url of candidates) {
    const sql = postgres(url, { prepare: false, max: 1, idle_timeout: 20, ssl: 'require', connect_timeout: 8 });
    try {
      await sql`select 1`;
      return sql;
    } catch (err) {
      last = err;
      await sql.end({ timeout: 1 }).catch(() => {});
    }
  }
  throw Object.assign(new Error(`Could not connect to the database: ${last?.message || 'unknown error'}`), { status: 503 });
}

export async function db() {
  if (!dbConfigured()) return null;
  if (_sql) return _sql;
  if (!_ready) _ready = connect().then((s) => { _sql = s; return s; }).finally(() => { _ready = null; });
  return _ready;
}

/** Run queries as one owner: the database only returns that owner's rows. */
export async function asOwner(owner, fn) {
  const sql = await db();
  if (!sql) throw Object.assign(new Error('Retrieval is not configured on this deployment'), { status: 503 });
  return sql.begin(async (tx) => {
    await tx`select set_config('berth.owner', ${owner}, true)`;
    return fn(tx);
  });
}

export async function logEvent(tx, owner, event, detail = {}) {
  await tx`insert into berth.events (owner, event, detail) values (${owner}, ${event}, ${tx.json(detail)})`;
}

// ---------------------------------------------------------------------------
// Demo-mode limits

export const LIMITS = {
  perVisitor: Number(env('DEMO_VISITOR_LIMIT', '40')),
  global: Number(env('DEMO_DAILY_LIMIT', '400')),
};

/** Count one request against today's limits. Throws 429 when exceeded. */
export async function spend(visitor, ip) {
  const sql = await db();
  if (!sql) return { visitor: 0, global: 0 }; // no database: rely on provider-side limits
  const [g] = await sql`select berth.bump_usage('global') as n`;
  const [v] = await sql`select berth.bump_usage(${`visitor:${visitor}`}) as n`;
  const [i] = await sql`select berth.bump_usage(${`ip:${ip}`}) as n`;
  if (g.n > LIMITS.global) throw Object.assign(new Error('The demo has reached its daily limit. Add your own API keys in Settings to keep going.'), { status: 429 });
  if (v.n > LIMITS.perVisitor || i.n > LIMITS.perVisitor * 3) {
    throw Object.assign(new Error(`You have used today's ${LIMITS.perVisitor} demo requests. Add your own API keys in Settings to keep going.`), { status: 429 });
  }
  return { visitor: v.n, global: g.n };
}

// ---------------------------------------------------------------------------
// Embeddings

export const EMBED_MODEL = 'text-embedding-3-small';
export const EMBED_DIMS = 512;

export async function embed(texts) {
  const key = env('OPENAI_API_KEY');
  if (!key) throw Object.assign(new Error('Embeddings need OPENAI_API_KEY on the server'), { status: 503 });
  const out = [];
  for (let i = 0; i < texts.length; i += 96) {
    const batch = texts.slice(i, i + 96);
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: batch, dimensions: EMBED_DIMS }),
    });
    if (!r.ok) throw Object.assign(new Error(`Embedding failed (${r.status})`), { status: 502 });
    const j = await r.json();
    for (const d of j.data) out.push(d.embedding);
  }
  return out;
}

export const vectorLiteral = (v) => `[${v.map((x) => Number(x).toFixed(6)).join(',')}]`;

/** Split text into overlapping chunks on paragraph and sentence boundaries. */
export function chunkText(text, size = 700, overlap = 120) {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const parts = clean.split(/\n\n|(?<=[.!?])\s+(?=[A-Z0-9])/);
  const chunks = [];
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

export function fail(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  send(res, status, { error: err.message || 'Server error' });
}
