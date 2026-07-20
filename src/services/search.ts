import { db } from '../db/index.js';
import * as repo from '../db/repo.js';
import { embed } from './ai.js';
import { esc } from '../views/html.js';

// Two search modes over interaction notes:
//  - text: SQLite FTS5, instant, always available
//  - semantic: local-model embeddings + cosine similarity, brute-forced in JS.
//    At local scale (hundreds of notes) brute force beats pulling in a vector
//    extension; vectors are cached in the embeddings table per model.

export interface SearchHit {
  interactionId: string;
  trrId: string;
  customer: string;
  title: string;
  type: string;
  date: string;
  snippet: string;   // HTML with <mark> highlights (text) or plain excerpt (semantic)
  score: number;
}

export function textSearch(q: string, limit = 30): SearchHit[] {
  const quoted = `"${q.replace(/"/g, '""')}"`;
  // Markers are control chars so we can escape note text BEFORE converting
  // them to <mark> tags — snippet() output is otherwise raw user text.
  const rows = db.prepare(`
    SELECT i.id, i.trr_id, i.type, i.date, t.customer, t.title,
           snippet(interactions_fts, 0, char(1), char(2), ' … ', 24) AS snip,
           bm25(interactions_fts) AS score
    FROM interactions_fts
    JOIN interactions i ON i.rowid = interactions_fts.rowid
    JOIN trrs t ON t.id = i.trr_id
    WHERE interactions_fts MATCH ?
    ORDER BY score LIMIT ?
  `).all(quoted, limit) as {
    id: string; trr_id: string; type: string; date: string;
    customer: string; title: string; snip: string; score: number;
  }[];
  return rows.map(r => ({
    interactionId: r.id, trrId: r.trr_id, customer: r.customer, title: r.title,
    type: r.type, date: r.date,
    snippet: esc(r.snip).replaceAll('\u0001', '<mark>').replaceAll('\u0002', '</mark>'),
    score: -r.score, // bm25: lower is better
  }));
}

// --- semantic ---------------------------------------------------------------

const CHUNK_CHARS = 1200;

function chunkNote(note: string): string[] {
  const clean = note.trim();
  if (clean.length <= CHUNK_CHARS) return clean ? [clean] : [];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > 0) {
    if (rest.length <= CHUNK_CHARS) { chunks.push(rest); break; }
    // prefer breaking at a sentence/paragraph boundary within the window
    let cut = rest.lastIndexOf('. ', CHUNK_CHARS);
    if (cut < CHUNK_CHARS / 2) cut = CHUNK_CHARS;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  return chunks;
}

function toBlob(v: number[]): Buffer {
  return Buffer.from(new Float32Array(v).buffer);
}

function fromBlob(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Embed any interactions that don't yet have vectors for the current model. */
export async function ensureIndex(model: string): Promise<number> {
  const missing = db.prepare(`
    SELECT i.id, i.note FROM interactions i
    WHERE length(trim(i.note)) > 0
      AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.interaction_id = i.id AND e.model = ?)
  `).all(model) as { id: string; note: string }[];
  if (missing.length === 0) return 0;

  let indexed = 0;
  const ins = db.prepare(`
    INSERT OR REPLACE INTO embeddings (interaction_id, chunk_index, chunk_text, model, vector)
    VALUES (?, ?, ?, ?, ?)
  `);
  // batch per interaction — keeps request sizes small and progress incremental
  for (const m of missing) {
    const chunks = chunkNote(m.note);
    if (chunks.length === 0) continue;
    const vectors = await embed(chunks, model);
    const tx = db.transaction(() => {
      chunks.forEach((c, idx) => {
        const v = vectors[idx];
        if (v) ins.run(m.id, idx, c, model, toBlob(v));
      });
    });
    tx();
    indexed++;
  }
  return indexed;
}

export async function semanticSearch(q: string, limit = 15): Promise<SearchHit[]> {
  const model = repo.getSettings().embedModel;
  await ensureIndex(model);
  const [qv] = await embed([q], model);
  if (!qv) return [];
  const query = new Float32Array(qv);

  const rows = db.prepare(`
    SELECT e.interaction_id, e.chunk_text, e.vector, i.trr_id, i.type, i.date, t.customer, t.title
    FROM embeddings e
    JOIN interactions i ON i.id = e.interaction_id
    JOIN trrs t ON t.id = i.trr_id
    WHERE e.model = ?
  `).all(model) as {
    interaction_id: string; chunk_text: string; vector: Buffer;
    trr_id: string; type: string; date: string; customer: string; title: string;
  }[];

  const best = new Map<string, SearchHit>();
  for (const r of rows) {
    const score = cosine(query, fromBlob(r.vector));
    const prev = best.get(r.interaction_id);
    if (!prev || score > prev.score) {
      best.set(r.interaction_id, {
        interactionId: r.interaction_id, trrId: r.trr_id, customer: r.customer,
        title: r.title, type: r.type, date: r.date,
        snippet: esc(r.chunk_text.slice(0, 260) + (r.chunk_text.length > 260 ? ' …' : '')),
        score,
      });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
