// SQLite-based search cache
// Replaces Redis from original plan, follows existing database patterns

import { createHash } from 'crypto';
import db from '../../db/index.js';

// Cache TTL in minutes (default 15)
const DEFAULT_TTL_MINUTES = parseInt(process.env.SEARCH_CACHE_TTL_MINUTES) || 15;

/**
 * Get cache key from query (SHA-256 hash of normalized query)
 * @param {string} query - Search query
 * @returns {string} First 32 characters of SHA-256 hash
 */
function getCacheKey(query) {
  const normalized = query.toLowerCase().trim();
  return createHash('sha256').update(normalized).digest('hex').substring(0, 32);
}

/**
 * Get cached search results
 * @param {string} query - Search query
 * @returns {Object|null} Cached results or null if not found/expired
 */
export function getCached(query) {
  const hash = getCacheKey(query);

  try {
    const stmt = db.prepare(`
      SELECT results, answer
      FROM search_cache
      WHERE query_hash = ? AND expires_at > datetime('now')
    `);

    const row = stmt.get(hash);

    if (row) {
      return {
        results: JSON.parse(row.results),
        answer: row.answer || null
      };
    }
  } catch (error) {
    console.error('[SearchCache] Get failed:', error.message);
  }

  return null;
}

/**
 * Store search results in cache
 * @param {string} query - Search query
 * @param {Object[]} results - Search results
 * @param {string} [answer] - AI summary
 * @param {number} [ttlMinutes] - Cache TTL in minutes
 */
export function setCache(query, results, answer, ttlMinutes = DEFAULT_TTL_MINUTES) {
  const hash = getCacheKey(query);

  try {
    const stmt = db.prepare(`
      INSERT INTO search_cache (query_hash, query, results, answer, expires_at)
      VALUES (?, ?, ?, ?, datetime('now', '+' || ? || ' minutes'))
      ON CONFLICT(query_hash) DO UPDATE SET
        results = excluded.results,
        answer = excluded.answer,
        expires_at = excluded.expires_at,
        created_at = CURRENT_TIMESTAMP
    `);

    stmt.run(hash, query, JSON.stringify(results), answer || null, ttlMinutes);
  } catch (error) {
    console.error('[SearchCache] Set failed:', error.message);
  }
}

/**
 * Get or fetch search results with caching
 * @param {string} query - Search query
 * @param {Function} fetcher - Async function to fetch results if not cached
 * @param {number} [ttlMs] - Optional custom TTL in milliseconds
 * @returns {Promise<{results: Object[], answer: string|null, cached: boolean}>}
 */
export async function getOrFetch(query, fetcher, ttlMs) {
  const cached = getCached(query);

  if (cached) {
    return { ...cached, cached: true };
  }

  const fresh = await fetcher();
  // Convert ms to minutes if provided
  const ttlMinutes = ttlMs ? Math.floor(ttlMs / 60000) : DEFAULT_TTL_MINUTES;
  setCache(query, fresh.results, fresh.answer, ttlMinutes);

  return { ...fresh, cached: false };
}

/**
 * Clean up expired cache entries
 * Should be called periodically (e.g., daily cron or on startup)
 * @returns {number} Number of entries deleted
 */
export function cleanupExpired() {
  try {
    const stmt = db.prepare(`
      DELETE FROM search_cache
      WHERE expires_at < datetime('now')
    `);

    const result = stmt.run();
    console.log(`[SearchCache] Cleaned up ${result.changes} expired entries`);
    return result.changes;
  } catch (error) {
    console.error('[SearchCache] Cleanup failed:', error.message);
    return 0;
  }
}

/**
 * Get cache statistics
 * @returns {{totalEntries: number, validEntries: number, expiredEntries: number}}
 */
export function getCacheStats() {
  try {
    const total = db.prepare('SELECT COUNT(*) as count FROM search_cache').get();
    const valid = db.prepare(`
      SELECT COUNT(*) as count FROM search_cache
      WHERE expires_at > datetime('now')
    `).get();

    return {
      totalEntries: total?.count || 0,
      validEntries: valid?.count || 0,
      expiredEntries: (total?.count || 0) - (valid?.count || 0)
    };
  } catch (error) {
    console.error('[SearchCache] Stats failed:', error.message);
    return { totalEntries: 0, validEntries: 0, expiredEntries: 0 };
  }
}

/**
 * Clear all cache entries (for testing/maintenance)
 * @returns {number} Number of entries deleted
 */
export function clearAll() {
  try {
    const stmt = db.prepare('DELETE FROM search_cache');
    const result = stmt.run();
    console.log(`[SearchCache] Cleared ${result.changes} entries`);
    return result.changes;
  } catch (error) {
    console.error('[SearchCache] Clear failed:', error.message);
    return 0;
  }
}
