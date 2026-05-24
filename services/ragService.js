/**
 * RAG Service — services/ragService.js
 *
 * Embedding pipeline + semantic search for Chat AI Kiné.
 *
 * Pipeline:
 *   1. Ingest document → chunk into ~400-token paragraphs
 *   2. Embed each chunk via OpenAI text-embedding-3-small (via Polsia proxy)
 *   3. Store in rag_chunks with pgvector embedding column
 *
 * Search:
 *   - Embed the query
 *   - Run cosine-distance nearest-neighbor search via HNSW index
 *   - Return top N chunks with similarity score and source document metadata
 *
 * Designed to stay decoupled from chatAI.js — future tasks wire them together.
 */

const OpenAI = require('openai');
const { Pool } = require('pg');

// ── Clients ──────────────────────────────────────────────────────────────────

const openai = new OpenAI();
// Uses OPENAI_BASE_URL + OPENAI_API_KEY from environment (Polsia proxy)

// SSL required for cloud-hosted PostgreSQL (Scalingo, Clever Cloud, Neon)
const dbUrl = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl && !dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1')
    ? { rejectUnauthorized: false }
    : false
});

// ── Constants ────────────────────────────────────────────────────────────────

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMS = 1536;
const CHUNK_TARGET_CHARS = 1500;   // ~400 tokens at ~3.7 chars/token
const CHUNK_OVERLAP_CHARS = 150;   // overlap to preserve context at boundaries
const DEFAULT_TOP_K = 5;
const DEFAULT_SIMILARITY_THRESHOLD = 0.30; // cosine similarity (0 = unrelated, 1 = identical)

// ── Embedding helper ─────────────────────────────────────────────────────────

/**
 * Embed a single string. Returns float array of length 1536.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embed(text) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.trim().slice(0, 8000), // hard cap at model input limit
  });
  return response.data[0].embedding;
}

/**
 * Embed multiple strings in one API call (batch, up to 100).
 * Returns array of float arrays.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedBatch(texts) {
  if (texts.length === 0) return [];

  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts.map(t => t.trim().slice(0, 8000)),
  });

  // Sort by index to guarantee order
  return response.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding);
}

// ── Chunking ─────────────────────────────────────────────────────────────────

/**
 * Split document content into overlapping chunks.
 * Strategy: paragraph-aware — prefer splitting at double newlines.
 *
 * @param {string} text
 * @returns {{ content: string, index: number }[]}
 */
function chunkText(text) {
  const chunks = [];

  // Normalize whitespace
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // Split into paragraphs first
  const paragraphs = normalized.split(/\n\n+/);

  let current = '';
  let chunkIndex = 0;

  for (const para of paragraphs) {
    const paraText = para.trim();
    if (!paraText) continue;

    // If adding this paragraph stays within target, append it
    if (current.length + paraText.length + 2 <= CHUNK_TARGET_CHARS) {
      current = current ? `${current}\n\n${paraText}` : paraText;
    } else {
      // Save current chunk (if any)
      if (current) {
        chunks.push({ content: current, index: chunkIndex++ });
        // Carry overlap from end of current chunk into next
        const overlapStart = Math.max(0, current.length - CHUNK_OVERLAP_CHARS);
        current = current.slice(overlapStart);
        if (current) current += '\n\n';
      }

      // If a single paragraph exceeds target, hard-split it
      if (paraText.length > CHUNK_TARGET_CHARS) {
        let pos = 0;
        while (pos < paraText.length) {
          const slice = paraText.slice(pos, pos + CHUNK_TARGET_CHARS);
          chunks.push({ content: slice, index: chunkIndex++ });
          pos += CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS;
        }
        current = '';
      } else {
        current = paraText;
      }
    }
  }

  // Flush remaining
  if (current.trim()) {
    chunks.push({ content: current.trim(), index: chunkIndex++ });
  }

  return chunks;
}

// ── Ingest pipeline ──────────────────────────────────────────────────────────

/**
 * Ingest a document into the RAG store.
 *
 * 1. Inserts into rag_documents
 * 2. Chunks the content
 * 3. Embeds all chunks (batched)
 * 4. Inserts all chunks with embeddings into rag_chunks
 *
 * @param {{ title: string, category?: string, source_type?: string, source_url?: string, content: string, metadata?: object }} doc
 * @returns {Promise<{ document_id: number, chunk_count: number }>}
 */
async function ingestDocument(doc) {
  const {
    title,
    category = 'general',
    source_type = 'internal',
    source_url = null,
    content,
    metadata = {},
  } = doc;

  if (!title || !content) throw new Error('ingestDocument: title and content are required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insert document
    const docResult = await client.query(
      `INSERT INTO rag_documents (title, category, source_type, source_url, content, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [title, category, source_type, source_url, content, JSON.stringify(metadata)]
    );
    const documentId = docResult.rows[0].id;

    // 2. Chunk
    const chunks = chunkText(content);

    if (chunks.length === 0) {
      await client.query('COMMIT');
      return { document_id: documentId, chunk_count: 0 };
    }

    // 3. Embed (batch)
    const chunkTexts = chunks.map(c => c.content);
    const embeddings = await embedBatch(chunkTexts);

    // 4. Insert chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i];
      // pgvector expects '[f1,f2,...]' string format
      const vectorStr = `[${embedding.join(',')}]`;

      await client.query(
        `INSERT INTO rag_chunks (document_id, chunk_index, content, token_count, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [documentId, chunk.index, chunk.content, Math.round(chunk.content.length / 4), vectorStr]
      );
    }

    await client.query('COMMIT');
    return { document_id: documentId, chunk_count: chunks.length };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Semantic search ───────────────────────────────────────────────────────────

/**
 * Search for the most relevant chunks for a given query.
 *
 * @param {string} query - Natural language question or phrase
 * @param {{ topK?: number, threshold?: number, category?: string }} options
 * @returns {Promise<Array<{
 *   chunk_id: number,
 *   document_id: number,
 *   document_title: string,
 *   category: string,
 *   source_url: string|null,
 *   content: string,
 *   similarity: number
 * }>>}
 */
async function semanticSearch(query, options = {}) {
  const {
    topK = DEFAULT_TOP_K,
    threshold = DEFAULT_SIMILARITY_THRESHOLD,
    category = null,
  } = options;

  // Embed the query
  const queryEmbedding = await embed(query);
  const vectorStr = `[${queryEmbedding.join(',')}]`;

  // Build SQL — filter by category if provided
  const params = [vectorStr, threshold, topK];
  let categoryFilter = '';
  if (category) {
    params.push(category);
    categoryFilter = `AND d.category = $${params.length}`;
  }

  const sql = `
    SELECT
      c.id            AS chunk_id,
      c.document_id,
      d.title         AS document_title,
      d.category,
      d.source_url,
      c.content,
      1 - (c.embedding <=> $1::vector) AS similarity
    FROM rag_chunks c
    JOIN rag_documents d ON d.id = c.document_id
    WHERE 1 - (c.embedding <=> $1::vector) >= $2
      ${categoryFilter}
    ORDER BY c.embedding <=> $1::vector
    LIMIT $3
  `;

  const result = await pool.query(sql, params);
  return result.rows.map(row => ({
    ...row,
    similarity: parseFloat(row.similarity),
  }));
}

// ── Convenience: context block for prompts ────────────────────────────────────

/**
 * Build a formatted context string to inject into an LLM prompt.
 * Returns null if no relevant documents found.
 *
 * @param {string} query
 * @param {{ topK?: number, threshold?: number, category?: string }} options
 * @returns {Promise<string|null>}
 */
async function buildRagContext(query, options = {}) {
  const results = await semanticSearch(query, options);

  if (results.length === 0) return null;

  const blocks = results.map((r, i) =>
    `[Source ${i + 1}: ${r.document_title}]\n${r.content}`
  );

  return `## Contexte clinique pertinent\n\n${blocks.join('\n\n---\n\n')}`;
}

/**
 * Build RAG context AND return structured source references for citation links.
 *
 * Returns null if no relevant documents found.
 *
 * @param {string} query
 * @param {{ topK?: number, threshold?: number, category?: string }} options
 * @returns {Promise<{ context: string, sources: Array<{ index: number, title: string, category: string, document_id: number, source_url: string|null }> }|null>}
 */
async function searchAndBuildContext(query, options = {}) {
  const results = await semanticSearch(query, options);

  if (results.length === 0) return null;

  // Deduplicate by document_id (keep best similarity per document)
  const seen = new Map();
  for (const r of results) {
    if (!seen.has(r.document_id) || r.similarity > seen.get(r.document_id).similarity) {
      seen.set(r.document_id, r);
    }
  }
  const unique = Array.from(seen.values());

  const blocks = unique.map((r, i) =>
    `[Source ${i + 1}: ${r.document_title}]\n${r.content}`
  );

  const context = `## Contexte clinique pertinent (base Kinévia)\n\n${blocks.join('\n\n---\n\n')}`;

  const sources = unique.map((r, i) => ({
    index: i + 1,
    title: r.document_title,
    category: r.category,
    document_id: r.document_id,
    source_url: r.source_url || null,
  }));

  return { context, sources };
}

// ── Document management ───────────────────────────────────────────────────────

/**
 * Delete a document and all its chunks.
 * @param {number} documentId
 */
async function deleteDocument(documentId) {
  await pool.query('DELETE FROM rag_documents WHERE id = $1', [documentId]);
}

/**
 * List all documents (no content, for admin UI).
 * @returns {Promise<Array<{id, title, category, source_type, chunk_count, created_at}>>}
 */
async function listDocuments() {
  const result = await pool.query(`
    SELECT
      d.id,
      d.title,
      d.category,
      d.source_type,
      d.source_url,
      COUNT(c.id)::int AS chunk_count,
      d.created_at
    FROM rag_documents d
    LEFT JOIN rag_chunks c ON c.document_id = d.id
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `);
  return result.rows;
}

/**
 * Get RAG store stats (document count, chunk count, categories).
 */
async function getStats() {
  const result = await pool.query(`
    SELECT
      COUNT(DISTINCT d.id)::int   AS document_count,
      COUNT(c.id)::int            AS chunk_count,
      jsonb_object_agg(
        COALESCE(d.category, 'unknown'),
        cat_counts.cnt
      ) AS by_category
    FROM rag_documents d
    LEFT JOIN rag_chunks c ON c.document_id = d.id
    LEFT JOIN (
      SELECT category, COUNT(*)::int AS cnt FROM rag_documents GROUP BY category
    ) cat_counts ON cat_counts.category = d.category
  `);
  return result.rows[0];
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Core pipeline
  embed,
  embedBatch,
  ingestDocument,

  // Search
  semanticSearch,
  buildRagContext,
  searchAndBuildContext,

  // Management
  deleteDocument,
  listDocuments,
  getStats,

  // Constants (for callers)
  EMBEDDING_MODEL,
  EMBEDDING_DIMS,
  DEFAULT_TOP_K,
};
