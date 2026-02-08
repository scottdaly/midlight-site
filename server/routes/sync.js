/**
 * Sync Routes
 * Handles document synchronization between clients and cloud storage
 */

import { Router } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger.js';
import { requireAuth, attachSubscription } from '../middleware/auth.js';
import db from '../db/index.js';
import storage from '../services/storageService.js';
import crypto from 'crypto';
import { CONFIG } from '../config/index.js';
import {
  validateSyncPath,
  sanitizeSidecar,
  validateContentSize,
  SYNC_LIMITS,
} from '../utils/syncSecurity.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);
router.use(attachSubscription);

// Block free tier users - sync is a premium feature
router.use((req, res, next) => {
  const tier = req.subscription?.tier || 'free';
  if (tier === 'free') {
    return res.status(403).json({
      error: 'Cloud sync requires a premium subscription',
      code: 'SYNC_REQUIRES_PREMIUM',
      upgrade_url: '/upgrade',
    });
  }
  next();
});

// Storage limits by tier (from config)
const STORAGE_LIMITS = {
  free: CONFIG.syncStorage.free.maxBytes,
  premium: CONFIG.syncStorage.premium.maxBytes,
  pro: CONFIG.syncStorage.pro.maxBytes,
};

// Rate limits by tier (from config)
const RATE_LIMITS = {
  free: CONFIG.rateLimit.sync.free.max,
  premium: CONFIG.rateLimit.sync.premium.max,
  pro: CONFIG.rateLimit.sync.pro.max,
};

// Dynamic rate limiter based on subscription tier
const syncRateLimiter = rateLimit({
  windowMs: CONFIG.rateLimit.sync.free.windowMs, // 1 minute
  max: (req) => RATE_LIMITS[req.subscription?.tier] || RATE_LIMITS.free,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Sync rate limit exceeded. Please slow down.' },
  keyGenerator: (req) => req.user.id.toString(),
});

router.use(syncRateLimiter);

// Document count limits by tier (from config)
const DOCUMENT_LIMITS = {
  free: CONFIG.syncStorage.free.maxDocuments,
  premium: CONFIG.syncStorage.premium.maxDocuments,
  pro: CONFIG.syncStorage.pro.maxDocuments,
};

/**
 * Check if user has exceeded storage limit (bytes + document count)
 */
function checkStorageLimit(userId, tier, additionalBytes = 0, isNewDocument = false) {
  const usage = db
    .prepare('SELECT total_size_bytes, document_count FROM sync_usage WHERE user_id = ?')
    .get(userId);

  const currentUsage = usage?.total_size_bytes || 0;
  const currentCount = usage?.document_count || 0;
  const byteLimit = STORAGE_LIMITS[tier] || STORAGE_LIMITS.free;
  const docLimit = DOCUMENT_LIMITS[tier] || DOCUMENT_LIMITS.free;

  const bytesExceeded = currentUsage + additionalBytes > byteLimit;
  const docsExceeded = isNewDocument && currentCount >= docLimit;

  return {
    allowed: !bytesExceeded && !docsExceeded,
    currentUsage,
    limit: byteLimit,
    remaining: byteLimit - currentUsage,
    currentCount,
    docLimit,
    bytesExceeded,
    docsExceeded,
  };
}

/**
 * Update sync usage statistics
 */
function updateSyncUsage(userId, sizeDelta) {
  db.prepare(`
    INSERT INTO sync_usage (user_id, document_count, total_size_bytes, last_sync_at, updated_at)
    VALUES (?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      document_count = (SELECT COUNT(*) FROM sync_documents WHERE user_id = ? AND deleted_at IS NULL),
      total_size_bytes = total_size_bytes + ?,
      last_sync_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, Math.max(0, sizeDelta), userId, sizeDelta);
}

/**
 * Log sync operation
 */
function logSyncOperation(userId, documentId, operation, path, sizeBytes, success, errorMessage = null) {
  db.prepare(`
    INSERT INTO sync_operations (user_id, document_id, operation, path, size_bytes, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, documentId, operation, path, sizeBytes, success ? 1 : 0, errorMessage);
}

// GET /api/sync/status - Get sync status and all document versions
router.get('/status', async (req, res) => {
  try {
    const userId = req.user.id;
    const tier = req.subscription?.tier || 'free';

    // Optional pagination params
    const pageLimit = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const cursor = req.query.cursor || null;

    // Get documents (with optional pagination)
    let documents;
    if (pageLimit && pageLimit > 0) {
      if (cursor) {
        documents = db
          .prepare(`
            SELECT id, path, content_hash, sidecar_hash, version, size_bytes, updated_at, deleted_at
            FROM sync_documents
            WHERE user_id = ? AND updated_at < ?
            ORDER BY updated_at DESC
            LIMIT ?
          `)
          .all(userId, cursor, pageLimit);
      } else {
        documents = db
          .prepare(`
            SELECT id, path, content_hash, sidecar_hash, version, size_bytes, updated_at, deleted_at
            FROM sync_documents
            WHERE user_id = ?
            ORDER BY updated_at DESC
            LIMIT ?
          `)
          .all(userId, pageLimit);
      }
    } else {
      documents = db
        .prepare(`
          SELECT id, path, content_hash, sidecar_hash, version, size_bytes, updated_at, deleted_at
          FROM sync_documents
          WHERE user_id = ?
          ORDER BY updated_at DESC
        `)
        .all(userId);
    }

    // Get usage stats
    const usage = db
      .prepare('SELECT * FROM sync_usage WHERE user_id = ?')
      .get(userId);

    // Get unresolved conflicts
    const conflicts = db
      .prepare(`
        SELECT c.*, d.path
        FROM sync_conflicts c
        JOIN sync_documents d ON c.document_id = d.id
        WHERE c.user_id = ? AND c.resolved_at IS NULL
      `)
      .all(userId);

    const storageLimit = STORAGE_LIMITS[tier] || STORAGE_LIMITS.free;

    // Compute nextCursor for pagination
    let nextCursor = null;
    if (pageLimit && pageLimit > 0 && documents.length === pageLimit) {
      nextCursor = documents[documents.length - 1].updated_at;
    }

    const response = {
      documents: documents.map((doc) => ({
        id: doc.id,
        path: doc.path,
        contentHash: doc.content_hash,
        sidecarHash: doc.sidecar_hash,
        version: doc.version,
        sizeBytes: doc.size_bytes,
        updatedAt: doc.updated_at,
        deleted: doc.deleted_at !== null,
      })),
      usage: {
        documentCount: usage?.document_count || 0,
        totalSizeBytes: usage?.total_size_bytes || 0,
        limitBytes: storageLimit,
        percentUsed: usage ? (usage.total_size_bytes / storageLimit) * 100 : 0,
        lastSyncAt: usage?.last_sync_at,
      },
      conflicts: conflicts.map((c) => ({
        id: c.id,
        documentId: c.document_id,
        path: c.path,
        localVersion: c.local_version,
        remoteVersion: c.remote_version,
        createdAt: c.created_at,
      })),
      storageAvailable: storage.isStorageAvailable(),
    };

    if (nextCursor) {
      response.nextCursor = nextCursor;
    }

    res.json(response);
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Sync status error');
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

// POST /api/sync/documents - Upload/sync a document
router.post(
  '/documents',
  [
    body('path').isString().trim().notEmpty().withMessage('Path is required'),
    body('content').isString().withMessage('Content is required'),
    body('sidecar').isObject().withMessage('Sidecar must be an object'),
    body('baseVersion').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      if (!storage.isStorageAvailable()) {
        return res.status(503).json({ error: 'Storage service unavailable' });
      }

      const userId = req.user.id;
      const tier = req.subscription?.tier || 'free';
      const { path: rawPath, content, sidecar: rawSidecar, baseVersion } = req.body;

      // Security: Validate and sanitize path
      const pathValidation = validateSyncPath(rawPath);
      if (!pathValidation.valid) {
        logger.warn({ userId, path: rawPath, error: pathValidation.error }, 'Invalid sync path');
        return res.status(400).json({ error: pathValidation.error });
      }
      const path = pathValidation.sanitized;

      // Security: Validate content size
      const contentValidation = validateContentSize(content);
      if (!contentValidation.valid) {
        logger.warn({ userId, error: contentValidation.error }, 'Content too large');
        return res.status(413).json({ error: contentValidation.error });
      }

      // Security: Sanitize sidecar
      const sidecarValidation = sanitizeSidecar(rawSidecar);
      if (!sidecarValidation.valid) {
        logger.warn({ userId, error: sidecarValidation.error }, 'Invalid sidecar');
        return res.status(400).json({ error: sidecarValidation.error });
      }
      const sidecar = sidecarValidation.sanitized;

      // Calculate content size
      const contentSize = contentValidation.sizeBytes;
      const sidecarSize = Buffer.byteLength(JSON.stringify(sidecar), 'utf-8');
      const totalSize = contentSize + sidecarSize;

      // Check for existing document (used for isNewDocument check)
      const existingForLimitCheck = db
        .prepare('SELECT id FROM sync_documents WHERE user_id = ? AND path = ? AND deleted_at IS NULL')
        .get(userId, path);

      // Check storage limit (bytes + document count)
      const storageCheck = checkStorageLimit(userId, tier, totalSize, !existingForLimitCheck);
      if (!storageCheck.allowed) {
        const limitType = storageCheck.docsExceeded ? 'document_count' : 'storage_bytes';
        return res.status(413).json({
          error: storageCheck.docsExceeded
            ? `Document limit exceeded (${storageCheck.currentCount}/${storageCheck.docLimit})`
            : 'Storage limit exceeded',
          limitType,
          usage: {
            current: storageCheck.currentUsage,
            limit: storageCheck.limit,
            required: totalSize,
            currentCount: storageCheck.currentCount,
            docLimit: storageCheck.docLimit,
          },
        });
      }

      // Check for existing document
      const existing = db
        .prepare('SELECT * FROM sync_documents WHERE user_id = ? AND path = ?')
        .get(userId, path);

      // Generate or use existing document ID
      const documentId = existing?.id || crypto.randomUUID();

      // Upload to R2 first (optimistic, outside transaction)
      const uploadResult = await storage.uploadDocument(userId, documentId, content, sidecar);

      // Wrap version check + DB upsert in transaction for atomicity
      const transact = db.transaction(() => {
        // Re-read document inside transaction to get latest version
        const current = db
          .prepare('SELECT * FROM sync_documents WHERE user_id = ? AND path = ?')
          .get(userId, path);

        // Check for conflicts (if baseVersion provided and doesn't match)
        if (current && baseVersion !== undefined && current.version !== baseVersion) {
          return { conflict: true, current };
        }

        // Calculate size difference for usage tracking
        const sizeDelta = totalSize - (current?.size_bytes || 0);

        // Upsert document record
        if (current) {
          db.prepare(`
            UPDATE sync_documents SET
              content_hash = ?, sidecar_hash = ?, r2_content_key = ?, r2_sidecar_key = ?,
              version = version + 1, size_bytes = ?, updated_at = CURRENT_TIMESTAMP, deleted_at = NULL
            WHERE id = ?
          `).run(
            uploadResult.contentHash,
            uploadResult.sidecarHash,
            uploadResult.contentKey,
            uploadResult.sidecarKey,
            totalSize,
            documentId
          );
        } else {
          db.prepare(`
            INSERT INTO sync_documents (id, user_id, path, content_hash, sidecar_hash,
              r2_content_key, r2_sidecar_key, version, size_bytes)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
          `).run(
            documentId,
            userId,
            path,
            uploadResult.contentHash,
            uploadResult.sidecarHash,
            uploadResult.contentKey,
            uploadResult.sidecarKey,
            totalSize
          );
        }

        // Update usage stats
        updateSyncUsage(userId, sizeDelta);

        // Log operation
        logSyncOperation(userId, documentId, 'upload', path, totalSize, true);

        return { conflict: false };
      });

      const txResult = transact();

      // Handle conflict outside transaction (needs async R2 operations)
      if (txResult.conflict) {
        const current = txResult.current;
        const conflictId = crypto.randomUUID();
        const existingDoc = await storage.downloadDocument(userId, current.id);

        // Store local version in conflict storage
        const localKeys = await storage.preserveVersion(
          userId,
          current.id,
          baseVersion,
          content,
          sidecar
        );

        // Create conflict record
        db.prepare(`
          INSERT INTO sync_conflicts (id, document_id, user_id, local_version, remote_version,
            local_content_hash, remote_content_hash, local_r2_key, remote_r2_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          conflictId,
          current.id,
          userId,
          baseVersion,
          current.version,
          storage.hashContent(content),
          current.content_hash,
          localKeys.contentKey,
          current.r2_content_key
        );

        logSyncOperation(userId, current.id, 'conflict', path, totalSize, true);

        return res.status(409).json({
          error: 'Conflict detected',
          conflict: {
            id: conflictId,
            documentId: current.id,
            localVersion: baseVersion,
            remoteVersion: current.version,
            remoteContent: existingDoc?.content,
            remoteSidecar: existingDoc?.sidecar,
          },
        });
      }

      // Get updated document
      const updated = db
        .prepare('SELECT * FROM sync_documents WHERE id = ?')
        .get(documentId);

      res.json({
        success: true,
        document: {
          id: updated.id,
          path: updated.path,
          contentHash: updated.content_hash,
          sidecarHash: updated.sidecar_hash,
          version: updated.version,
          sizeBytes: updated.size_bytes,
          updatedAt: updated.updated_at,
        },
      });
    } catch (error) {
      logger.error({ error: error?.message || error, userId: req.user.id }, 'Sync upload error');
      logSyncOperation(req.user.id, null, 'upload', req.body?.path, 0, false, error?.message);
      res.status(500).json({ error: 'Failed to sync document' });
    }
  }
);

// GET /api/sync/documents/:id - Download a specific document
router.get('/documents/:id', [param('id').isUUID()], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (!storage.isStorageAvailable()) {
      return res.status(503).json({ error: 'Storage service unavailable' });
    }

    const userId = req.user.id;
    const { id } = req.params;

    // Get document metadata
    const doc = db
      .prepare('SELECT * FROM sync_documents WHERE id = ? AND user_id = ?')
      .get(id, userId);

    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Download from R2
    const result = await storage.downloadDocument(userId, id);

    if (!result) {
      return res.status(404).json({ error: 'Document content not found' });
    }

    logSyncOperation(userId, id, 'download', doc.path, doc.size_bytes, true);

    res.json({
      id: doc.id,
      path: doc.path,
      content: result.content,
      sidecar: result.sidecar,
      contentHash: doc.content_hash,
      sidecarHash: doc.sidecar_hash,
      version: doc.version,
      updatedAt: doc.updated_at,
    });
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Sync download error');
    res.status(500).json({ error: 'Failed to download document' });
  }
});

// PATCH /api/sync/documents/:id - Atomic rename (path update only, no R2 operations)
router.patch(
  '/documents/:id',
  [
    param('id').isUUID(),
    body('path').isString().trim().notEmpty().withMessage('New path is required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = req.user.id;
      const { id } = req.params;
      const { path: rawPath } = req.body;

      // Security: Validate and sanitize new path
      const pathValidation = validateSyncPath(rawPath);
      if (!pathValidation.valid) {
        logger.warn({ userId, path: rawPath, error: pathValidation.error }, 'Invalid rename path');
        return res.status(400).json({ error: pathValidation.error });
      }
      const newPath = pathValidation.sanitized;

      // Atomic rename in transaction
      const transact = db.transaction(() => {
        // Get existing document
        const doc = db
          .prepare('SELECT * FROM sync_documents WHERE id = ? AND user_id = ?')
          .get(id, userId);

        if (!doc) {
          return { error: 'not_found' };
        }

        // Check new path uniqueness
        const existing = db
          .prepare('SELECT id FROM sync_documents WHERE user_id = ? AND path = ? AND deleted_at IS NULL AND id != ?')
          .get(userId, newPath, id);

        if (existing) {
          return { error: 'path_exists' };
        }

        const oldPath = doc.path;

        // Update path
        db.prepare(`
          UPDATE sync_documents SET path = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ?
        `).run(newPath, id, userId);

        logSyncOperation(userId, id, 'rename', `${oldPath} -> ${newPath}`, 0, true);

        return { success: true, oldPath, newPath };
      });

      const result = transact();

      if (result.error === 'not_found') {
        return res.status(404).json({ error: 'Document not found' });
      }
      if (result.error === 'path_exists') {
        return res.status(409).json({ error: 'A document already exists at the target path' });
      }

      // Get updated document
      const updated = db
        .prepare('SELECT * FROM sync_documents WHERE id = ?')
        .get(id);

      res.json({
        success: true,
        document: {
          id: updated.id,
          path: updated.path,
          contentHash: updated.content_hash,
          sidecarHash: updated.sidecar_hash,
          version: updated.version,
          sizeBytes: updated.size_bytes,
          updatedAt: updated.updated_at,
        },
      });
    } catch (error) {
      logger.error({ error: error?.message || error, userId: req.user.id }, 'Sync rename error');
      res.status(500).json({ error: 'Failed to rename document' });
    }
  }
);

// DELETE /api/sync/documents/:id - Soft delete a document
router.delete('/documents/:id', [param('id').isUUID()], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.user.id;
    const { id } = req.params;

    // Get document
    const doc = db
      .prepare('SELECT * FROM sync_documents WHERE id = ? AND user_id = ?')
      .get(id, userId);

    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Soft delete (keep in R2 for recovery, mark as deleted in DB)
    db.prepare(`
      UPDATE sync_documents SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);

    // Update usage
    updateSyncUsage(userId, -doc.size_bytes);

    logSyncOperation(userId, id, 'delete', doc.path, 0, true);

    res.json({ success: true, deletedAt: new Date().toISOString() });
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Sync delete error');
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// POST /api/sync/conflicts/:id/resolve - Resolve a conflict
router.post(
  '/conflicts/:id/resolve',
  [
    param('id').isUUID(),
    body('resolution').isIn(['local', 'remote', 'both']).withMessage('Invalid resolution'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = req.user.id;
      const { id } = req.params;
      const { resolution } = req.body;

      // Get conflict
      const conflict = db
        .prepare(`
          SELECT c.*, d.path, d.id as doc_id
          FROM sync_conflicts c
          JOIN sync_documents d ON c.document_id = d.id
          WHERE c.id = ? AND c.user_id = ? AND c.resolved_at IS NULL
        `)
        .get(id, userId);

      if (!conflict) {
        return res.status(404).json({ error: 'Conflict not found or already resolved' });
      }

      // Handle resolution
      if (resolution === 'local') {
        // Get local version and make it the current version
        const localDoc = await storage.getConflictVersion(userId, conflict.doc_id, conflict.local_version);
        if (localDoc) {
          await storage.uploadDocument(userId, conflict.doc_id, localDoc.content, localDoc.sidecar);
          db.prepare(`
            UPDATE sync_documents SET
              content_hash = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(storage.hashContent(localDoc.content), conflict.doc_id);
        }
      } else if (resolution === 'both') {
        // Keep remote as-is, create a new document for local version
        const localDoc = await storage.getConflictVersion(userId, conflict.doc_id, conflict.local_version);
        if (localDoc) {
          const newPath = conflict.path.replace(/(\.[^.]+)?$/, ' (conflict)$1');
          const newId = crypto.randomUUID();

          await storage.uploadDocument(userId, newId, localDoc.content, localDoc.sidecar);

          const contentSize = Buffer.byteLength(localDoc.content, 'utf-8');
          const sidecarSize = Buffer.byteLength(JSON.stringify(localDoc.sidecar), 'utf-8');

          db.prepare(`
            INSERT INTO sync_documents (id, user_id, path, content_hash, sidecar_hash,
              r2_content_key, r2_sidecar_key, version, size_bytes)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
          `).run(
            newId,
            userId,
            newPath,
            storage.hashContent(localDoc.content),
            storage.hashContent(JSON.stringify(localDoc.sidecar)),
            `users/${userId}/documents/${newId}/content.md`,
            `users/${userId}/documents/${newId}/sidecar.json`,
            contentSize + sidecarSize
          );

          updateSyncUsage(userId, contentSize + sidecarSize);
        }
      }
      // 'remote' resolution: keep current version as-is

      // Mark conflict as resolved
      db.prepare(`
        UPDATE sync_conflicts SET resolved_at = CURRENT_TIMESTAMP, resolution = ?
        WHERE id = ?
      `).run(resolution, id);

      // Clean up conflict versions
      await storage.deleteConflictVersions(userId, conflict.doc_id, [conflict.local_version]);

      res.json({
        success: true,
        resolution,
        resolvedAt: new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ error: error?.message || error, userId: req.user.id }, 'Conflict resolution error');
      res.status(500).json({ error: 'Failed to resolve conflict' });
    }
  }
);

// GET /api/sync/conflicts/:id - Get conflict details with both versions
router.get('/conflicts/:id', [param('id').isUUID()], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.user.id;
    const { id } = req.params;

    const conflict = db
      .prepare(`
        SELECT c.*, d.path
        FROM sync_conflicts c
        JOIN sync_documents d ON c.document_id = d.id
        WHERE c.id = ? AND c.user_id = ?
      `)
      .get(id, userId);

    if (!conflict) {
      return res.status(404).json({ error: 'Conflict not found' });
    }

    // Get both versions
    const [localDoc, remoteDoc] = await Promise.all([
      storage.getConflictVersion(userId, conflict.document_id, conflict.local_version),
      storage.downloadDocument(userId, conflict.document_id),
    ]);

    res.json({
      id: conflict.id,
      documentId: conflict.document_id,
      path: conflict.path,
      local: localDoc
        ? {
            version: conflict.local_version,
            content: localDoc.content,
            sidecar: localDoc.sidecar,
          }
        : null,
      remote: remoteDoc
        ? {
            version: conflict.remote_version,
            content: remoteDoc.content,
            sidecar: remoteDoc.sidecar,
          }
        : null,
      createdAt: conflict.created_at,
      resolved: conflict.resolved_at !== null,
    });
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Get conflict error');
    res.status(500).json({ error: 'Failed to get conflict details' });
  }
});

// GET /api/sync/usage - Get storage usage
router.get('/usage', (req, res) => {
  try {
    const userId = req.user.id;
    const tier = req.subscription?.tier || 'free';

    const usage = db
      .prepare('SELECT * FROM sync_usage WHERE user_id = ?')
      .get(userId);

    const limit = STORAGE_LIMITS[tier] || STORAGE_LIMITS.free;
    const currentUsage = usage?.total_size_bytes || 0;

    res.json({
      documentCount: usage?.document_count || 0,
      totalSizeBytes: currentUsage,
      limitBytes: limit,
      remainingBytes: limit - currentUsage,
      percentUsed: (currentUsage / limit) * 100,
      lastSyncAt: usage?.last_sync_at,
      tier,
    });
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Usage error');
    res.status(500).json({ error: 'Failed to get usage' });
  }
});

export default router;
