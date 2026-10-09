// POST /api/search {query, k, documentIds?} — vector search over the visitor's
// own documents and the shared samples. Row-level security in the database
// decides what is visible; this code cannot widen it.

import { send, readJson, visitorOf, asOwner, logEvent, embed, vectorLiteral, fail } from './_lib.js';
import { ensureSamples } from './docs.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  try {
    const visitor = visitorOf(req);
    const { query, k = 5, documentIds = null } = await readJson(req);
    const q = String(query || '').trim().slice(0, 4000);
    if (!q) return send(res, 400, { error: 'Empty query' });
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
    send(res, 200, { results });
  } catch (err) {
    fail(res, err);
  }
}
