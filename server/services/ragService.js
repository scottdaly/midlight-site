/**
 * RAG Service — Server-side document indexing and hybrid search for web users.
 *
 * Indexes user documents stored in R2 into a local SQLite vector store,
 * then provides hybrid search (vector cosine similarity + BM25 FTS5)
 * merged via Reciprocal Rank Fusion (k=60).
 *
 * Chunking logic is replicated from packages/core/src/rag/chunker.ts.
 * See that file for the canonical implementation and rationale.
 */

import crypto from 'crypto';
import db from '../db/index.js';
import { embed } from './llm/index.js';
import { downloadDocument } from './storageService.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ service: 'rag' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CHUNK_TOKENS = 500;
const MIN_CHUNK_TOKENS = 50;
const OVERLAP_TOKENS = 50;
const EMBED_BATCH_SIZE = 20;
const EMBED_TEXT_CAP = 8000; // max chars sent to embedding API per text
const RRF_K = 60;

// Track users currently being indexed to prevent concurrent runs
const indexingUsers = new Set();

// ---------------------------------------------------------------------------
// Prepared statements (lazily initialised)
// ---------------------------------------------------------------------------

let _stmts = null;

function stmts() {
  if (_stmts) return _stmts;

  _stmts = {
    // Reads
    getSyncDocs: db.prepare(`
      SELECT id, user_id, path, content_hash, r2_content_key
      FROM sync_documents
      WHERE user_id = ? AND deleted_at IS NULL
    `),
    getIndexedDocs: db.prepare(`
      SELECT document_id, content_hash
      FROM rag_indexed_documents
      WHERE user_id = ?
    `),
    getIndexedDoc: db.prepare(`
      SELECT document_id, content_hash
      FROM rag_indexed_documents
      WHERE user_id = ? AND document_id = ?
    `),
    countChunks: db.prepare(`
      SELECT COUNT(*) AS cnt FROM rag_chunks WHERE user_id = ?
    `),
    countIndexed: db.prepare(`
      SELECT COUNT(*) AS cnt FROM rag_indexed_documents WHERE user_id = ?
    `),
    lastIndexed: db.prepare(`
      SELECT MAX(indexed_at) AS last_indexed FROM rag_indexed_documents WHERE user_id = ?
    `),
    totalTokenEstimate: db.prepare(`
      SELECT COALESCE(SUM(token_estimate), 0) AS total FROM rag_chunks WHERE user_id = ?
    `),
    allChunksForUser: db.prepare(`
      SELECT id, document_id, document_path, chunk_index, content, heading,
             embedding, token_estimate
      FROM rag_chunks
      WHERE user_id = ?
    `),

    // Writes
    insertChunk: db.prepare(`
      INSERT OR REPLACE INTO rag_chunks
        (id, user_id, document_id, document_path, chunk_index, content, heading, embedding, token_estimate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertFts: db.prepare(`
      INSERT INTO rag_chunks_fts (rowid, content, heading)
      VALUES (?, ?, ?)
    `),
    upsertIndexedDoc: db.prepare(`
      INSERT INTO rag_indexed_documents (user_id, document_id, document_path, content_hash, chunk_count, total_chars, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, document_id) DO UPDATE SET
        document_path = excluded.document_path,
        content_hash = excluded.content_hash,
        chunk_count = excluded.chunk_count,
        total_chars = excluded.total_chars,
        indexed_at = datetime('now')
    `),

    // Deletes
    deleteChunksByDoc: db.prepare(`
      DELETE FROM rag_chunks WHERE user_id = ? AND document_id = ?
    `),
    deleteIndexedDoc: db.prepare(`
      DELETE FROM rag_indexed_documents WHERE user_id = ? AND document_id = ?
    `),
    deleteAllChunks: db.prepare(`
      DELETE FROM rag_chunks WHERE user_id = ?
    `),
    deleteAllIndexed: db.prepare(`
      DELETE FROM rag_indexed_documents WHERE user_id = ?
    `),

    // Search
    ftsSearch: db.prepare(`
      SELECT rowid, rank
      FROM rag_chunks_fts
      WHERE rag_chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `),
    chunkByRowid: db.prepare(`
      SELECT id, document_id, document_path, chunk_index, content, heading,
             embedding, token_estimate
      FROM rag_chunks
      WHERE rowid = ? AND user_id = ?
    `),
  };

  return _stmts;
}

// ---------------------------------------------------------------------------
// Chunking — replicated from packages/core/src/rag/chunker.ts
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a string (~4 chars per token for English text).
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Generate a deterministic chunk ID from document + chunk index + content prefix.
 * Matches the approach in packages/core/src/rag/chunker.ts#generateChunkId.
 */
function generateChunkId(documentId, chunkIndex, content) {
  const key = `${documentId}:${chunkIndex}:${content.slice(0, 50)}`;
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return `chunk_${hash}`;
}

/**
 * Extract markdown headings from text content.
 * Returns array of { level, text, offset }.
 */
function extractHeadings(content) {
  const headings = [];
  const lines = content.split('\n');
  let offset = 0;

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim(),
        offset,
      });
    }
    offset += line.length + 1;
  }

  return headings;
}

/**
 * Get the most recent heading before a character offset.
 */
function getHeadingContext(headings, offset) {
  let current = undefined;
  for (const h of headings) {
    if (h.offset <= offset) {
      current = h;
    } else {
      break;
    }
  }
  return current?.text;
}

/**
 * Split content into paragraph-level sections on double-newline boundaries.
 */
function splitIntoSections(content) {
  return content.split(/\n\s*\n/).filter(s => s.trim().length > 0);
}

/**
 * Chunk a document into pieces suitable for embedding.
 *
 * Algorithm (mirrors packages/core/src/rag/chunker.ts):
 * 1. Split by double-newline into sections.
 * 2. Accumulate sections into chunks up to MAX_CHUNK_TOKENS.
 * 3. When a section would overflow, flush the current chunk (if >= MIN_CHUNK_TOKENS)
 *    and carry forward OVERLAP_TOKENS worth of trailing text.
 * 4. Oversized sections are further split on sentence boundaries.
 */
function chunkDocument(content, documentId, documentPath) {
  const headings = extractHeadings(content);
  const sections = splitIntoSections(content);
  const chunks = [];

  let chunkIndex = 0;
  let charOffset = 0;
  let currentChunkContent = '';
  let currentChunkStart = 0;

  for (const section of sections) {
    const sectionTokens = estimateTokens(section);
    const currentTokens = estimateTokens(currentChunkContent);

    // If adding this section would exceed max, flush current chunk
    if (currentTokens + sectionTokens > MAX_CHUNK_TOKENS && currentChunkContent.length > 0) {
      if (currentTokens >= MIN_CHUNK_TOKENS) {
        const heading = getHeadingContext(headings, currentChunkStart);
        chunks.push({
          id: generateChunkId(documentId, chunkIndex, currentChunkContent),
          documentId,
          documentPath,
          chunkIndex,
          content: currentChunkContent.trim(),
          heading: heading || null,
          tokenEstimate: currentTokens,
        });
        chunkIndex++;
      }

      // Carry overlap
      if (OVERLAP_TOKENS > 0) {
        const overlapChars = OVERLAP_TOKENS * 4;
        currentChunkContent = currentChunkContent.slice(-overlapChars);
        currentChunkStart = charOffset - currentChunkContent.length;
      } else {
        currentChunkContent = '';
        currentChunkStart = charOffset;
      }
    }

    // If the section itself is too large, split by sentence boundaries
    if (sectionTokens > MAX_CHUNK_TOKENS) {
      const sentences = section.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        const sentenceTokens = estimateTokens(sentence);
        const newTotal = estimateTokens(currentChunkContent) + sentenceTokens;

        if (newTotal > MAX_CHUNK_TOKENS && currentChunkContent.length > 0) {
          const ct = estimateTokens(currentChunkContent);
          if (ct >= MIN_CHUNK_TOKENS) {
            const heading = getHeadingContext(headings, currentChunkStart);
            chunks.push({
              id: generateChunkId(documentId, chunkIndex, currentChunkContent),
              documentId,
              documentPath,
              chunkIndex,
              content: currentChunkContent.trim(),
              heading: heading || null,
              tokenEstimate: ct,
            });
            chunkIndex++;
          }
          currentChunkContent = '';
          currentChunkStart = charOffset;
        }

        currentChunkContent += (currentChunkContent ? ' ' : '') + sentence;
        charOffset += sentence.length + 1;
      }
    } else {
      currentChunkContent += (currentChunkContent ? '\n\n' : '') + section;
      charOffset += section.length + 2; // +2 for paragraph break
    }
  }

  // Flush remaining content
  if (currentChunkContent.trim().length > 0) {
    const ct = estimateTokens(currentChunkContent);
    if (ct >= MIN_CHUNK_TOKENS) {
      const heading = getHeadingContext(headings, currentChunkStart);
      chunks.push({
        id: generateChunkId(documentId, chunkIndex, currentChunkContent),
        documentId,
        documentPath,
        chunkIndex,
        content: currentChunkContent.trim(),
        heading: heading || null,
        tokenEstimate: ct,
      });
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Embedding helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Float64 embedding array (from OpenAI) to a Buffer of Float32 LE.
 */
function embeddingToBlob(embedding) {
  const f32 = new Float32Array(embedding);
  return Buffer.from(f32.buffer);
}

/**
 * Convert a stored BLOB back to a Float32Array.
 */
function blobToEmbedding(blob) {
  // blob is a Buffer in better-sqlite3 — copy to ensure 4-byte alignment
  const aligned = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(aligned);
}

/**
 * Compute cosine similarity between two Float32Arrays.
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Batch-embed an array of texts, sending at most EMBED_BATCH_SIZE per API call.
 * Each text is capped at EMBED_TEXT_CAP characters.
 *
 * @param {number} userId  - User ID for quota tracking
 * @param {string[]} texts - Array of texts to embed
 * @returns {Promise<number[][]>} Array of embedding vectors (Float64 from API)
 */
async function batchEmbed(userId, texts) {
  const all = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE).map(t =>
      t.length > EMBED_TEXT_CAP ? t.slice(0, EMBED_TEXT_CAP) : t
    );

    const result = await embed({ userId, texts: batch });
    all.push(...result.embeddings);
  }

  return all;
}

// ---------------------------------------------------------------------------
// FTS helpers
// ---------------------------------------------------------------------------

/**
 * Delete FTS entries for a document before deleting the actual chunks.
 * We need to do this before the chunks are removed because rag_chunks_fts
 * is a content-sync'd FTS5 table whose rowids reference rag_chunks.
 */
function deleteFtsForDocument(userId, documentId) {
  // Retrieve rowids that belong to this document before deleting
  const rows = db.prepare(
    `SELECT rowid FROM rag_chunks WHERE user_id = ? AND document_id = ?`
  ).all(userId, documentId);

  if (rows.length > 0) {
    const deleteStmt = db.prepare(
      `INSERT INTO rag_chunks_fts (rag_chunks_fts, rowid, content, heading)
       VALUES ('delete', ?, ?, ?)`
    );
    for (const row of rows) {
      const chunk = db.prepare(
        `SELECT content, heading FROM rag_chunks WHERE rowid = ?`
      ).get(row.rowid);
      if (chunk) {
        deleteStmt.run(row.rowid, chunk.content, chunk.heading || '');
      }
    }
  }
}

/**
 * Delete all FTS entries for a user.
 */
function deleteAllFtsForUser(userId) {
  const rows = db.prepare(
    `SELECT rowid, content, heading FROM rag_chunks WHERE user_id = ?`
  ).all(userId);

  if (rows.length > 0) {
    const deleteStmt = db.prepare(
      `INSERT INTO rag_chunks_fts (rag_chunks_fts, rowid, content, heading)
       VALUES ('delete', ?, ?, ?)`
    );
    for (const row of rows) {
      deleteStmt.run(row.rowid, row.content, row.heading || '');
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Index (or re-index) all documents for a user.
 *
 * Compares sync_documents.content_hash against rag_indexed_documents.content_hash
 * to determine which documents need (re-)indexing and which have been deleted.
 *
 * @param {number} userId
 * @param {{ force?: boolean }} options
 * @returns {Promise<{ indexed: number, deleted: number, skipped: number, errors: number, totalChunks: number }>}
 */
export async function indexProject(userId, { force = false } = {}) {
  if (indexingUsers.has(userId)) {
    log.warn({ userId }, 'Indexing already in progress for user, skipping');
    return { indexed: 0, deleted: 0, skipped: 0, errors: 0, totalChunks: 0, alreadyRunning: true };
  }

  indexingUsers.add(userId);
  log.info({ userId, force }, 'Starting document indexing');

  const result = { indexed: 0, deleted: 0, skipped: 0, errors: 0, totalChunks: 0 };

  try {
    const s = stmts();

    // 1. Gather current state
    const syncDocs = s.getSyncDocs.all(userId);
    const indexedRows = s.getIndexedDocs.all(userId);
    const indexedMap = new Map(indexedRows.map(r => [r.document_id, r.content_hash]));
    const syncDocIds = new Set(syncDocs.map(d => d.id));

    // 2. Detect deleted documents (in index but no longer in sync_documents)
    for (const [docId] of indexedMap) {
      if (!syncDocIds.has(docId)) {
        log.debug({ userId, docId }, 'Removing deleted document from index');
        deleteFtsForDocument(userId, docId);
        s.deleteChunksByDoc.run(userId, docId);
        s.deleteIndexedDoc.run(userId, docId);
        result.deleted++;
      }
    }

    // 3. Determine which documents need indexing
    const toIndex = [];
    for (const doc of syncDocs) {
      const existingHash = indexedMap.get(doc.id);
      if (force || !existingHash || existingHash !== doc.content_hash) {
        toIndex.push(doc);
      } else {
        result.skipped++;
      }
    }

    if (toIndex.length === 0) {
      log.info({ userId, skipped: result.skipped, deleted: result.deleted }, 'No documents to index');
      result.totalChunks = s.countChunks.get(userId).cnt;
      return result;
    }

    log.info({ userId, count: toIndex.length }, 'Documents to index');

    // 4. Process each document
    for (const doc of toIndex) {
      try {
        // Download content from R2
        const downloaded = await downloadDocument(userId, doc.id);
        if (!downloaded || !downloaded.content) {
          log.warn({ userId, docId: doc.id }, 'Failed to download document content, skipping');
          result.errors++;
          continue;
        }

        const content = downloaded.content;

        // Remove old chunks for this document if re-indexing
        if (indexedMap.has(doc.id)) {
          deleteFtsForDocument(userId, doc.id);
          s.deleteChunksByDoc.run(userId, doc.id);
        }

        // Chunk the document
        const chunks = chunkDocument(content, doc.id, doc.path);

        if (chunks.length === 0) {
          // Document too small to chunk; still record it so we don't re-process
          s.upsertIndexedDoc.run(userId, doc.id, doc.path, doc.content_hash, 0, content.length);
          result.indexed++;
          continue;
        }

        // Batch embed all chunks
        const texts = chunks.map(c => c.content);
        const embeddings = await batchEmbed(userId, texts);

        // Insert chunks and FTS entries inside a transaction for atomicity
        const insertAll = db.transaction(() => {
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const blob = embeddingToBlob(embeddings[i]);

            s.insertChunk.run(
              chunk.id,
              userId,
              chunk.documentId,
              chunk.documentPath,
              chunk.chunkIndex,
              chunk.content,
              chunk.heading,
              blob,
              chunk.tokenEstimate
            );

            // Get the rowid just inserted for FTS
            const rowid = db.prepare(
              `SELECT rowid FROM rag_chunks WHERE id = ?`
            ).get(chunk.id)?.rowid;

            if (rowid != null) {
              s.insertFts.run(rowid, chunk.content, chunk.heading || '');
            }
          }

          // Update indexed document record
          s.upsertIndexedDoc.run(
            userId, doc.id, doc.path, doc.content_hash, chunks.length, content.length
          );
        });

        insertAll();
        result.indexed++;

        log.debug({ userId, docId: doc.id, chunks: chunks.length }, 'Indexed document');
      } catch (err) {
        log.error({ userId, docId: doc.id, err: err.message }, 'Error indexing document');
        result.errors++;
      }
    }

    result.totalChunks = s.countChunks.get(userId).cnt;
    log.info({ userId, ...result }, 'Indexing complete');
    return result;
  } finally {
    indexingUsers.delete(userId);
  }
}

/**
 * Hybrid search: vector cosine similarity + BM25 FTS5, merged via RRF (k=60).
 *
 * @param {number} userId
 * @param {string} query
 * @param {{ topK?: number, minScore?: number }} options
 * @returns {Promise<Array<{ content: string, heading: string|null, documentPath: string, score: number }>>}
 */
export async function search(userId, query, { topK = 5, minScore = 0.3 } = {}) {
  if (!query || query.trim().length === 0) {
    return [];
  }

  const s = stmts();

  // 1. Embed the query
  const queryEmbeddings = await batchEmbed(userId, [query.trim()]);
  const queryVec = new Float32Array(queryEmbeddings[0]);

  // 2. Vector search — scan all user chunks and rank by cosine similarity
  const allChunks = s.allChunksForUser.all(userId);

  if (allChunks.length === 0) {
    return [];
  }

  const vectorResults = [];
  for (const row of allChunks) {
    const embedding = blobToEmbedding(row.embedding);
    const score = cosineSimilarity(queryVec, embedding);
    vectorResults.push({ id: row.id, score, row });
  }
  vectorResults.sort((a, b) => b.score - a.score);

  // Take top candidates for RRF (more than topK to allow fusion to work)
  const vectorTopN = vectorResults.slice(0, topK * 3);

  // 3. BM25 FTS5 search
  let ftsResults = [];
  try {
    // Escape FTS5 special characters and format as query
    const ftsQuery = query
      .trim()
      .replace(/['"]/g, '')           // remove quotes
      .split(/\s+/)                    // split into words
      .filter(w => w.length > 0)
      .map(w => `"${w}"`)             // quote each word for prefix matching safety
      .join(' OR ');

    if (ftsQuery.length > 0) {
      const ftsRows = s.ftsSearch.all(ftsQuery, topK * 3);
      for (const ftsRow of ftsRows) {
        const chunk = s.chunkByRowid.get(ftsRow.rowid, userId);
        if (chunk) {
          ftsResults.push({
            id: chunk.id,
            rank: ftsRow.rank,  // FTS5 rank (negative = more relevant)
            row: chunk,
          });
        }
      }
    }
  } catch (err) {
    // FTS queries can fail on unusual input; fall back to vector-only
    log.warn({ userId, err: err.message }, 'FTS search failed, using vector-only');
  }

  // 4. Reciprocal Rank Fusion (k=60)
  //    RRF_score(d) = sum over rankings: 1 / (k + rank_i)
  //    where rank_i is 1-based position in each ranking.
  const rrfScores = new Map();

  // Score from vector ranking
  for (let i = 0; i < vectorTopN.length; i++) {
    const entry = vectorTopN[i];
    const rrfScore = 1 / (RRF_K + (i + 1));
    rrfScores.set(entry.id, {
      rrfScore,
      vectorScore: entry.score,
      row: entry.row,
    });
  }

  // Score from FTS ranking
  for (let i = 0; i < ftsResults.length; i++) {
    const entry = ftsResults[i];
    const rrfScore = 1 / (RRF_K + (i + 1));
    const existing = rrfScores.get(entry.id);
    if (existing) {
      existing.rrfScore += rrfScore;
    } else {
      rrfScores.set(entry.id, {
        rrfScore,
        vectorScore: 0,
        row: entry.row,
      });
    }
  }

  // 5. Sort by fused score and apply minScore filter
  const merged = Array.from(rrfScores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK);

  // Normalise RRF scores to [0, 1] range for filtering
  const maxRrf = merged.length > 0 ? merged[0].rrfScore : 1;
  const results = [];

  for (const entry of merged) {
    const normalisedScore = maxRrf > 0 ? entry.rrfScore / maxRrf : 0;
    // Use vector cosine similarity as a secondary filter when available
    const effectiveScore = entry.vectorScore > 0
      ? (normalisedScore + entry.vectorScore) / 2
      : normalisedScore;

    if (effectiveScore < minScore) continue;

    results.push({
      content: entry.row.content,
      heading: entry.row.heading || null,
      documentPath: entry.row.document_path,
      score: effectiveScore,
    });
  }

  log.debug({
    userId,
    query: query.slice(0, 80),
    vectorCandidates: vectorTopN.length,
    ftsCandidates: ftsResults.length,
    returned: results.length,
  }, 'Search complete');

  return results;
}

/**
 * Get indexing status for a user.
 *
 * @param {number} userId
 * @returns {{ totalDocuments: number, indexedDocuments: number, totalChunks: number, isIndexing: boolean, lastIndexed: string|null }}
 */
export function getStatus(userId) {
  const s = stmts();

  const totalDocuments = db.prepare(
    `SELECT COUNT(*) AS cnt FROM sync_documents WHERE user_id = ? AND deleted_at IS NULL`
  ).get(userId).cnt;

  const indexedDocuments = s.countIndexed.get(userId).cnt;
  const totalChunks = s.countChunks.get(userId).cnt;
  const lastIndexedRow = s.lastIndexed.get(userId);

  return {
    totalDocuments,
    indexedDocuments,
    totalChunks,
    isIndexing: indexingUsers.has(userId),
    lastIndexed: lastIndexedRow?.last_indexed || null,
  };
}

/**
 * Delete the entire index for a user.
 *
 * @param {number} userId
 */
export function deleteIndex(userId) {
  log.info({ userId }, 'Deleting entire RAG index');

  const run = db.transaction(() => {
    deleteAllFtsForUser(userId);
    stmts().deleteAllChunks.run(userId);
    stmts().deleteAllIndexed.run(userId);
  });

  run();
}

/**
 * Get the total estimated token count across all indexed chunks for a user.
 *
 * @param {number} userId
 * @returns {number}
 */
export function getProjectTokenEstimate(userId) {
  return stmts().totalTokenEstimate.get(userId).total;
}
