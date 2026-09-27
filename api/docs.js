// /api/docs — the visitor's documents.
//   GET               list own documents plus shared samples
//   POST {name,text}  index a document (text is already redacted in the browser)
//   DELETE ?id=…      delete one document, or ?all=1 to erase everything this visitor stored

import { send, readJson, visitorOf, asOwner, logEvent, embed, vectorLiteral, chunkText, spend, clientIp, fail } from './_lib.js';
import { SAMPLES } from './_samples.js';

const MAX_CHARS = 150_000;
const MAX_DOCS = 10;

/** Insert chunks in batches: one round trip per 100 rows. */
async function insertChunks(tx, documentId, owner, chunks, vectors) {
  const rows = chunks.map((content, idx) => ({ document_id: documentId, owner, idx, content, embedding: vectorLiteral(vectors[idx]) }));
  for (let i = 0; i < rows.length; i += 100) {
    await tx`insert into berth.chunks ${tx(rows.slice(i, i + 100), 'document_id', 'owner', 'idx', 'content', 'embedding')}`;
  }
}

/** Index the sample documents once, the first time anyone needs them. */
export async function ensureSamples() {
  await asOwner('sample', async (tx) => {
    await tx`select pg_advisory_xact_lock(424242)`; // one seeder at a time
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

export default async function handler(req, res) {
  try {
    const visitor = visitorOf(req);

    if (req.method === 'GET') {
      await ensureSamples();
      const docs = await asOwner(visitor, (tx) => tx`
        select id, name, chars, chunk_count, redactions, created_at, owner = 'sample' as sample
        from berth.documents order by sample desc, created_at desc`);
      return send(res, 200, { documents: docs });
    }

    if (req.method === 'POST') {
      const { name, text, redactions = {} } = await readJson(req);
      const body = String(text || '').trim();
      if (!body) return send(res, 400, { error: 'The document has no text.' });
      if (body.length > MAX_CHARS) return send(res, 413, { error: `Documents are limited to ${MAX_CHARS.toLocaleString()} characters in the demo.` });
      await spend(visitor, clientIp(req));
      const chunks = chunkText(body).slice(0, 400);
      const vectors = await embed(chunks);
      const doc = await asOwner(visitor, async (tx) => {
        const [{ n }] = await tx`select count(*)::int as n from berth.documents where owner = ${visitor}`;
        if (n >= MAX_DOCS) throw Object.assign(new Error(`You can keep up to ${MAX_DOCS} documents in the demo. Delete one first.`), { status: 409 });
        const [d] = await tx`insert into berth.documents (owner, name, chars, chunk_count, redactions)
          values (${visitor}, ${String(name || 'Untitled').slice(0, 200)}, ${body.length}, ${chunks.length}, ${tx.json(redactions)})
          returning id, name, chars, chunk_count, redactions, created_at`;
        await insertChunks(tx, d.id, visitor, chunks, vectors);
        await logEvent(tx, visitor, 'document.indexed', { id: d.id, chunks: chunks.length, chars: body.length, redactions });
        return d;
      });
      return send(res, 201, { document: doc });
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url, 'http://x');
      const all = url.searchParams.get('all') === '1';
      const id = url.searchParams.get('id');
      const out = await asOwner(visitor, async (tx) => {
        if (all) {
          const r = await tx`delete from berth.documents where owner = ${visitor} returning id`;
          await tx`delete from berth.events where owner = ${visitor}`;
          await logEvent(tx, visitor, 'erasure.completed', { documents: r.length });
          return { deleted: r.length, erased: true };
        }
        if (!id) throw Object.assign(new Error('Missing id'), { status: 400 });
        const r = await tx`delete from berth.documents where id = ${id} and owner = ${visitor} returning id`;
        await logEvent(tx, visitor, 'document.deleted', { id, found: r.length > 0 });
        return { deleted: r.length };
      });
      return send(res, 200, out);
    }

    send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    fail(res, err);
  }
}
