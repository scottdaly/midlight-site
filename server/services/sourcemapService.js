/**
 * Source Map Symbolication Service
 *
 * Resolves minified stack traces to original source positions using uploaded source maps.
 * Uses Mozilla's source-map library for resolution.
 */

import fs from 'fs';
import path from 'path';
import { SourceMapConsumer } from 'source-map';
import db from '../db/index.js';
import { logger } from '../utils/logger.js';

// ============================================================================
// Configuration
// ============================================================================

const SOURCEMAP_DIR = process.env.SOURCEMAP_DIR || '/var/data/midlight/sourcemaps';
const MAX_CACHED_CONSUMERS = 10;
const SOURCEMAP_MAX_AGE_DAYS = 90;

// ============================================================================
// LRU Cache for SourceMapConsumer instances
// ============================================================================

const consumerCache = new Map();

function getCachedConsumer(mapPath) {
  const entry = consumerCache.get(mapPath);
  if (entry) {
    entry.lastUsed = Date.now();
    return entry.consumer;
  }
  return null;
}

function setCachedConsumer(mapPath, consumer) {
  // Evict oldest if at capacity
  if (consumerCache.size >= MAX_CACHED_CONSUMERS) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, entry] of consumerCache) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const old = consumerCache.get(oldestKey);
      if (old?.consumer?.destroy) old.consumer.destroy();
      consumerCache.delete(oldestKey);
    }
  }

  consumerCache.set(mapPath, { consumer, lastUsed: Date.now() });
}

// ============================================================================
// Stack Frame Parsing
// ============================================================================

/**
 * Parse a stack trace string into structured frames
 * Handles Chrome/V8, Firefox, and Safari stack formats
 */
export function parseStackFrames(stackTrace) {
  if (!stackTrace) return [];

  const frames = [];
  const lines = stackTrace.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Chrome/V8: "    at functionName (file:line:col)"
    let match = trimmed.match(/^\s*at\s+(?:(.+?)\s+\()?(https?:\/\/[^)]+|\/[^)]+):(\d+):(\d+)\)?/);
    if (match) {
      frames.push({
        function: match[1] || '<anonymous>',
        file: match[2],
        line: parseInt(match[3]),
        col: parseInt(match[4]),
      });
      continue;
    }

    // Firefox: "functionName@file:line:col"
    match = trimmed.match(/^(.+?)@(https?:\/\/.+|\/[^:]+):(\d+):(\d+)$/);
    if (match) {
      frames.push({
        function: match[1] || '<anonymous>',
        file: match[2],
        line: parseInt(match[3]),
        col: parseInt(match[4]),
      });
      continue;
    }

    // Safari: "functionName@file:line:col" (similar to Firefox)
    match = trimmed.match(/^([^@]*)@(.+):(\d+):(\d+)$/);
    if (match) {
      frames.push({
        function: match[1] || '<anonymous>',
        file: match[2],
        line: parseInt(match[3]),
        col: parseInt(match[4]),
      });
    }
  }

  return frames;
}

/**
 * Extract the filename from a URL (e.g., "https://midlight.ai/_app/immutable/chunks/foo.abc123.js" → "_app/immutable/chunks/foo.abc123.js")
 */
function extractFilename(url) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\//, '');
  } catch {
    // Not a valid URL, try to use as-is
    return url.replace(/^\//, '');
  }
}

// ============================================================================
// Symbolication
// ============================================================================

/**
 * Symbolicate a stack trace using source maps for a given release
 *
 * @param {string} stackTrace - The raw (minified) stack trace
 * @param {string} releaseVersion - The release version to look up source maps for
 * @returns {string|null} - Symbolicated stack trace, or null if not possible
 */
export async function symbolicate(stackTrace, releaseVersion) {
  if (!stackTrace || !releaseVersion) return null;

  try {
    // Look up release
    const release = db.prepare('SELECT id FROM releases WHERE version = ?').get(releaseVersion);
    if (!release) {
      logger.debug({ version: releaseVersion }, 'No release found for symbolication');
      return null;
    }

    // Get source maps for this release
    const maps = db.prepare(
      'SELECT file_path, map_path FROM release_sourcemaps WHERE release_id = ?'
    ).all(release.id);

    if (maps.length === 0) return null;

    // Build lookup: filename → map file path
    const mapLookup = {};
    for (const m of maps) {
      mapLookup[m.file_path] = m.map_path;
    }

    // Parse frames
    const frames = parseStackFrames(stackTrace);
    if (frames.length === 0) return null;

    // Symbolicate each frame
    const symbolicatedLines = [];
    let anyResolved = false;

    for (const frame of frames) {
      const filename = extractFilename(frame.file);
      const mapPath = mapLookup[filename];

      if (!mapPath) {
        // No source map for this file
        symbolicatedLines.push(
          `    at ${frame.function} (${frame.file}:${frame.line}:${frame.col})`
        );
        continue;
      }

      try {
        const consumer = await loadConsumer(mapPath);
        if (!consumer) {
          symbolicatedLines.push(
            `    at ${frame.function} (${frame.file}:${frame.line}:${frame.col})`
          );
          continue;
        }

        const original = consumer.originalPositionFor({
          line: frame.line,
          column: frame.col,
        });

        if (original.source) {
          anyResolved = true;
          const fn = original.name || frame.function;
          symbolicatedLines.push(
            `    at ${fn} (${original.source}:${original.line}:${original.column})`
          );
        } else {
          symbolicatedLines.push(
            `    at ${frame.function} (${frame.file}:${frame.line}:${frame.col})`
          );
        }
      } catch (err) {
        logger.debug({ error: err?.message, file: filename }, 'Frame symbolication failed');
        symbolicatedLines.push(
          `    at ${frame.function} (${frame.file}:${frame.line}:${frame.col})`
        );
      }
    }

    return anyResolved ? symbolicatedLines.join('\n') : null;
  } catch (err) {
    logger.error({ error: err?.message }, 'Symbolication error');
    return null;
  }
}

/**
 * Load a SourceMapConsumer for a given map file path (with caching)
 */
async function loadConsumer(mapPath) {
  const fullPath = path.resolve(mapPath);

  // Check cache
  const cached = getCachedConsumer(fullPath);
  if (cached) return cached;

  // Load from disk
  try {
    if (!fs.existsSync(fullPath)) return null;

    const mapContent = fs.readFileSync(fullPath, 'utf-8');
    const rawMap = JSON.parse(mapContent);
    const consumer = await new SourceMapConsumer(rawMap);

    setCachedConsumer(fullPath, consumer);
    return consumer;
  } catch (err) {
    logger.debug({ error: err?.message, path: fullPath }, 'Failed to load source map');
    return null;
  }
}

// ============================================================================
// Storage
// ============================================================================

/**
 * Store uploaded source maps for a release
 *
 * @param {string} version - Release version
 * @param {string} platform - Platform (web, desktop)
 * @param {string} commitSha - Git commit SHA
 * @param {Array<{filePath: string, content: Buffer}>} maps - Source map files
 * @returns {object} - { releaseId, uploaded }
 */
export function storeSourceMaps(version, platform, commitSha, maps) {
  // Ensure storage directory exists
  const releaseDir = path.join(SOURCEMAP_DIR, version);
  fs.mkdirSync(releaseDir, { recursive: true });

  // Create or get release
  const txn = db.transaction(() => {
    let release = db.prepare('SELECT id FROM releases WHERE version = ?').get(version);

    if (!release) {
      const result = db.prepare(
        'INSERT INTO releases (version, platform, commit_sha) VALUES (?, ?, ?)'
      ).run(version, platform, commitSha);
      release = { id: result.lastInsertRowid };
    }

    let uploaded = 0;

    for (const map of maps) {
      const mapFilename = path.basename(map.filePath) + '.map';
      const mapDiskPath = path.join(releaseDir, mapFilename);

      // Write map file
      fs.writeFileSync(mapDiskPath, map.content);

      // Record in DB (upsert)
      db.prepare(`
        INSERT INTO release_sourcemaps (release_id, file_path, map_path)
        VALUES (?, ?, ?)
        ON CONFLICT(release_id, file_path) DO UPDATE SET map_path = excluded.map_path
      `).run(release.id, map.filePath, mapDiskPath);

      uploaded++;
    }

    return { releaseId: release.id, uploaded };
  });

  return txn();
}

/**
 * Clean up old source maps
 */
export function cleanupOldSourceMaps() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - SOURCEMAP_MAX_AGE_DAYS);

  try {
    const oldReleases = db.prepare(
      'SELECT id, version FROM releases WHERE created_at < ?'
    ).all(cutoffDate.toISOString());

    for (const release of oldReleases) {
      // Delete source map files
      const releaseDir = path.join(SOURCEMAP_DIR, release.version);
      if (fs.existsSync(releaseDir)) {
        fs.rmSync(releaseDir, { recursive: true, force: true });
      }

      // Delete from DB (cascades to release_sourcemaps)
      db.prepare('DELETE FROM releases WHERE id = ?').run(release.id);

      logger.info({ version: release.version }, 'Cleaned up old source maps');
    }

    return oldReleases.length;
  } catch (err) {
    logger.error({ error: err?.message }, 'Source map cleanup error');
    return 0;
  }
}

/**
 * List all releases with source map counts
 */
export function listReleases() {
  return db.prepare(`
    SELECT r.id, r.version, r.platform, r.commit_sha, r.created_at,
           COUNT(rs.id) as map_count
    FROM releases r
    LEFT JOIN release_sourcemaps rs ON rs.release_id = r.id
    GROUP BY r.id
    ORDER BY r.created_at DESC
  `).all();
}

/**
 * Delete a specific release and its source maps
 */
export function deleteRelease(version) {
  const release = db.prepare('SELECT id FROM releases WHERE version = ?').get(version);
  if (!release) return false;

  // Delete files
  const releaseDir = path.join(SOURCEMAP_DIR, version);
  if (fs.existsSync(releaseDir)) {
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }

  // Delete from DB
  db.prepare('DELETE FROM releases WHERE id = ?').run(release.id);

  // Invalidate cache entries for this release
  for (const [key] of consumerCache) {
    if (key.includes(version)) {
      const entry = consumerCache.get(key);
      if (entry?.consumer?.destroy) entry.consumer.destroy();
      consumerCache.delete(key);
    }
  }

  return true;
}

export default {
  symbolicate,
  storeSourceMaps,
  cleanupOldSourceMaps,
  listReleases,
  deleteRelease,
  parseStackFrames,
};
