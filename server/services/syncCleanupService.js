/**
 * Sync Cleanup Service
 * Handles scheduled cleanup of expired soft-deleted documents, resolved conflicts,
 * and old sync operation logs.
 */

import db from '../db/index.js';
import storage from './storageService.js';
import { logger } from '../utils/logger.js';

const SOFT_DELETE_RETENTION_DAYS = 30;
const CONFLICT_RETENTION_DAYS = 7;
const OPERATION_LOG_RETENTION_DAYS = 90;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let cleanupInterval = null;

/**
 * Hard-delete documents that were soft-deleted more than SOFT_DELETE_RETENTION_DAYS ago.
 * Removes R2 objects and DB rows.
 */
async function cleanupExpiredDocuments() {
  const expired = db
    .prepare(`
      SELECT id, user_id, r2_content_key, r2_sidecar_key, size_bytes
      FROM sync_documents
      WHERE deleted_at IS NOT NULL
        AND deleted_at < datetime('now', '-${SOFT_DELETE_RETENTION_DAYS} days')
    `)
    .all();

  if (expired.length === 0) return 0;

  let cleaned = 0;
  for (const doc of expired) {
    try {
      // Delete storage objects (R2 or SQLite content)
      await storage.deleteDocumentObjects(doc.user_id, doc.id);

      // Clean up associated versions and their content
      const versions = db.prepare('SELECT id, size_bytes FROM sync_versions WHERE document_id = ? AND user_id = ?').all(doc.id, doc.user_id);
      let versionSizeTotal = 0;
      for (const ver of versions) {
        versionSizeTotal += ver.size_bytes || 0;
        try {
          await storage.deleteVersionContent(doc.user_id, ver.id);
        } catch (verErr) {
          logger.error({ error: verErr?.message || verErr, versionId: ver.id }, 'Failed to cleanup version content');
        }
      }
      db.prepare('DELETE FROM sync_version_content WHERE version_id IN (SELECT id FROM sync_versions WHERE document_id = ? AND user_id = ?)').run(doc.id, doc.user_id);
      db.prepare('DELETE FROM sync_versions WHERE document_id = ? AND user_id = ?').run(doc.id, doc.user_id);

      // Decrement sync usage for deleted version bytes
      if (versionSizeTotal > 0) {
        db.prepare(`
          UPDATE sync_usage SET total_size_bytes = MAX(0, total_size_bytes - ?), updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
        `).run(versionSizeTotal, doc.user_id);
      }

      // Hard-delete DB rows (content table cleaned by CASCADE or explicit delete)
      db.prepare('DELETE FROM sync_document_content WHERE document_id = ? AND user_id = ?').run(doc.id, doc.user_id);
      db.prepare('DELETE FROM sync_documents WHERE id = ?').run(doc.id);
      cleaned++;
    } catch (error) {
      logger.error(
        { error: error?.message || error, documentId: doc.id },
        'Failed to cleanup expired document'
      );
    }
  }

  return cleaned;
}

/**
 * Clean up resolved conflicts older than CONFLICT_RETENTION_DAYS.
 * Removes R2 conflict versions and DB rows.
 */
async function cleanupResolvedConflicts() {
  const resolved = db
    .prepare(`
      SELECT id, document_id, user_id, local_version, local_r2_key, remote_r2_key
      FROM sync_conflicts
      WHERE resolved_at IS NOT NULL
        AND resolved_at < datetime('now', '-${CONFLICT_RETENTION_DAYS} days')
    `)
    .all();

  if (resolved.length === 0) return 0;

  let cleaned = 0;
  for (const conflict of resolved) {
    try {
      // Delete R2 conflict versions
      await storage.deleteConflictVersions(
        conflict.user_id,
        conflict.document_id,
        [conflict.local_version]
      );

      // Hard-delete conflict DB row
      db.prepare('DELETE FROM sync_conflicts WHERE id = ?').run(conflict.id);
      cleaned++;
    } catch (error) {
      logger.error(
        { error: error?.message || error, conflictId: conflict.id },
        'Failed to cleanup resolved conflict'
      );
    }
  }

  return cleaned;
}

/**
 * Clean up old sync operation logs older than OPERATION_LOG_RETENTION_DAYS.
 */
function cleanupOperationLogs() {
  const result = db
    .prepare(`
      DELETE FROM sync_operations
      WHERE created_at < datetime('now', '-${OPERATION_LOG_RETENTION_DAYS} days')
    `)
    .run();

  return result.changes;
}

/**
 * Run all cleanup tasks
 */
async function runCleanup() {
  try {
    const [documents, conflicts, operations] = await Promise.all([
      cleanupExpiredDocuments(),
      cleanupResolvedConflicts(),
      Promise.resolve(cleanupOperationLogs()),
    ]);

    if (documents > 0 || conflicts > 0 || operations > 0) {
      logger.info(
        { documents, conflicts, operations },
        'Sync cleanup completed'
      );
    }
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Sync cleanup error');
  }
}

/**
 * Start the cleanup service (runs on startup + daily interval)
 */
export function startSyncCleanup() {
  // Run immediately on startup
  runCleanup();

  // Then run daily
  cleanupInterval = setInterval(runCleanup, CLEANUP_INTERVAL_MS);

  logger.info('Sync cleanup service started');
}

/**
 * Stop the cleanup service
 */
export function stopSyncCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
