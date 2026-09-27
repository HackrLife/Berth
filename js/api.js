// Talks to Berth's own server functions (demo mode and retrieval).
// On a static host with no functions, `status()` resolves to { demo: false }.

let _status = null;

export function visitorId() {
  try {
    let v = localStorage.getItem('berth.visitor');
    if (!v || !/^v_[a-z0-9]{12,40}$/.test(v)) {
      v = `v_${crypto.getRandomValues(new Uint32Array(4)).reduce((s, n) => s + n.toString(36), '')}`.slice(0, 30);
      localStorage.setItem('berth.visitor', v);
    }
    return v;
  } catch {
    return 'v_ephemeral0000000';
  }
}

export function currentStatus() {
  return _status || { demo: false, retrieval: false, providers: {} };
}

export async function loadStatus() {
  try {
    const r = await fetch('/api/status', { headers: { accept: 'application/json' } });
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('no api');
    _status = await r.json();
  } catch {
    _status = { demo: false, retrieval: false, providers: {} };
  }
  return _status;
}

async function call(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-berth-visitor': visitorId() },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {};
  try { j = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

/** Forward a provider request through the demo proxy. Returns the raw Response. */
export function proxyFetch(url, body, signal) {
  return fetch('/api/proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-berth-visitor': visitorId() },
    body: JSON.stringify({ url, body }),
    signal,
  });
}

export const docs = {
  list: () => call('/api/docs').then((j) => j.documents),
  add: (name, text, redactions) => call('/api/docs', { method: 'POST', body: { name, text, redactions } }).then((j) => j.document),
  remove: (id) => call(`/api/docs?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  eraseAll: () => call('/api/docs?all=1', { method: 'DELETE' }),
  search: (query, k = 5, documentIds = null) => call('/api/search', { method: 'POST', body: { query, k, documentIds } }).then((j) => j.results),
};
