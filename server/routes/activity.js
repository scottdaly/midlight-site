/**
 * Activity Routes
 *
 * Document and user activity feed.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { resolveDocumentAccess } from '../middleware/shareAuth.js';
import db from '../db/index.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * GET /me — Activity across all user's documents
 * NOTE: Must be defined BEFORE /:docId to avoid Express matching "me" as a docId
 */
router.get('/me', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;

  try {
    const rows = db.prepare(`
      SELECT a.*, u.display_name AS user_name, u.email AS user_email, u.avatar_url AS user_avatar,
             sd.path AS document_path
      FROM document_activity a
      JOIN users u ON a.user_id = u.id
      JOIN sync_documents sd ON a.document_id = sd.id
      WHERE sd.user_id = ? OR a.document_id IN (
        SELECT ds.document_id FROM document_shares ds
        JOIN document_access da ON da.share_id = ds.id
        WHERE da.user_id = ? AND da.accepted_at IS NOT NULL
      )
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.user.id, req.user.id, limit, offset);

    res.json({
      activity: rows.map(formatActivity),
      limit,
      offset,
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to load user activity');
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

/**
 * GET /:docId — Paginated activity for a document
 */
router.get('/:docId', requireAuth, resolveDocumentAccess, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;

  try {
    const rows = db.prepare(`
      SELECT a.*, u.display_name AS user_name, u.email AS user_email, u.avatar_url AS user_avatar
      FROM document_activity a
      JOIN users u ON a.user_id = u.id
      WHERE a.document_id = ?
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.params.docId, limit, offset);

    const total = db.prepare(
      'SELECT COUNT(*) AS count FROM document_activity WHERE document_id = ?'
    ).get(req.params.docId);

    res.json({
      activity: rows.map(formatActivity),
      total: total.count,
      limit,
      offset,
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to load activity');
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

function formatActivity(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    documentPath: row.document_path || null,
    userId: row.user_id,
    userName: row.user_name || null,
    userEmail: row.user_email || null,
    userAvatar: row.user_avatar || null,
    eventType: row.event_type,
    metadata: (() => {
      if (!row.metadata) return null;
      try { return JSON.parse(row.metadata); }
      catch { return null; }
    })(),
    createdAt: row.created_at,
  };
}

export default router;
