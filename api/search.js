// POST /api/search {query, k, documentIds?, documentNames?} — vector search over the visitor's
// own documents and the shared samples. Row-level security in the database
// decides what is visible; this code cannot widen it.

import { send, readJson, visitorOf, asOwner, logEvent, embed, vectorLiteral, fail } from './_lib.js';
import { ensureSamples } from './docs.js';
import { SAMPLES } from './_samples.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  try {
    const visitor = visitorOf(req);
    const { query, k = 5, documentIds = null, documentNames = null } = await readJson(req);
    const q = String(query || '').trim().slice(0, 4000);
    if (!q) return send(res, 400, { error: 'Empty query' });
    await ensureSamples();
    const [vector] = await embed([q]);
    let ids = Array.isArray(documentIds) && documentIds.length ? documentIds.map(String) : null;
    const names = Array.isArray(documentNames) && documentNames.length ? documentNames.map(String) : null;
    const results = await asOwner(visitor, async (tx) => {
      // A build can be scoped to named documents; if none match, search everything visible.
      if (names && !ids) {
        const found = await tx`select id from berth.documents where name = any(${names})`;
        if (found.length) ids = found.map((r) => r.id);
      }
      // Otherwise search the visitor's own documents and the current samples only.
      if (!ids) {
        const visible = await tx`select id from berth.documents
          where owner <> 'sample' or name = any(${SAMPLES.map((x) => x.name)})`;
        ids = visible.map((r) => r.id);
        if (!ids.length) return [];
      }
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
