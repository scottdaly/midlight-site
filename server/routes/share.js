/**
 * Share Routes
 *
 * Document sharing API endpoints.
 * Mounted at /api/share
 */

import { Router } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import crypto from 'crypto';
import db from '../db/index.js';
import { logger } from '../utils/logger.js';
import { requireAuth, optionalAuth, requirePro } from '../middleware/auth.js';
import { requireOwner } from '../middleware/shareAuth.js';
import { shareLimiter } from '../middleware/shareLimiter.js';
import { findUserByEmail } from '../services/authService.js';
import { downloadDocument, uploadDocument } from '../services/storageService.js';
import { sendShareInvitationEmail } from '../services/emailService.js';

const router = Router();

const WEB_REDIRECT_BASE = process.env.WEB_REDIRECT_BASE || 'http://localhost:5173';

// Apply rate limiter to all share routes
router.use(shareLimiter);

// ============================================================================
// Shared-with-me & Link resolution (BEFORE /:docId routes)
// ============================================================================

/**
 * GET /api/share/shared
 * List documents shared with the current user (paginated)
 */
router.get('/shared', requireAuth, (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    const rows = db.prepare(`
      SELECT
        da.id AS access_id,
        da.permission,
        da.accepted_at,
        da.created_at AS shared_at,
        ds.document_id,
        ds.link_token,
        sd.path AS document_path,
        sd.updated_at AS document_updated_at,
        u.display_name AS owner_name,
        u.email AS owner_email
      FROM document_access da
      JOIN document_shares ds ON da.share_id = ds.id
      JOIN sync_documents sd ON ds.document_id = sd.id
      JOIN users u ON ds.owner_id = u.id
      WHERE da.user_id = ?
      ORDER BY da.created_at DESC
      LIMIT ? OFFSET ?
    `).all(userId, limit, offset);

    const total = db.prepare(`
      SELECT COUNT(*) AS count FROM document_access WHERE user_id = ?
    `).get(userId);

    res.json({
      documents: rows.map((r) => ({
        accessId: r.access_id,
        permission: r.permission,
        acceptedAt: r.accepted_at,
        sharedAt: r.shared_at,
        documentId: r.document_id,
        linkToken: r.link_token,
        documentPath: r.document_path,
        documentUpdatedAt: r.document_updated_at,
        ownerName: r.owner_name,
        ownerEmail: r.owner_email,
      })),
      total: total.count,
      limit,
      offset,
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to list shared documents');
    res.status(500).json({ error: 'Failed to list shared documents' });
  }
});

/**
 * GET /api/share/link/:token
 * Resolve a share link to metadata (no content)
 */
router.get('/link/:token', optionalAuth, (req, res) => {
  try {
    const { token } = req.params;

    const share = db.prepare(`
      SELECT ds.*, sd.path AS document_path, sd.updated_at AS document_updated_at,
        u.display_name AS owner_name
      FROM document_shares ds
      JOIN sync_documents sd ON ds.document_id = sd.id
      JOIN users u ON ds.owner_id = u.id
      WHERE ds.link_token = ? AND ds.link_enabled = 1
    `).get(token);

    if (!share) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    // Check expiration
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This share link has expired' });
    }

    res.set('Cache-Control', 'private, max-age=60');
    res.json({
      documentId: share.document_id,
      documentPath: share.document_path,
      documentUpdatedAt: share.document_updated_at,
      ownerName: share.owner_name,
      permission: share.link_permission,
      allowCopy: !!share.allow_copy,
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to resolve share link');
    res.status(500).json({ error: 'Failed to resolve share link' });
  }
});

/**
 * GET /api/share/link/:token/content
 * Fetch document content via share link
 */
router.get('/link/:token/content', optionalAuth, async (req, res) => {
  try {
    const { token } = req.params;

    const share = db.prepare(`
      SELECT ds.*, sd.user_id AS doc_owner_id, sd.version AS doc_version
      FROM document_shares ds
      JOIN sync_documents sd ON ds.document_id = sd.id
      WHERE ds.link_token = ? AND ds.link_enabled = 1
    `).get(token);

    if (!share) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This share link has expired' });
    }

    const result = await downloadDocument(share.doc_owner_id, share.document_id);
    if (!result) {
      return res.status(404).json({ error: 'Document content not found' });
    }

    res.json({
      content: result.content,
      sidecar: result.sidecar,
      version: share.doc_version,
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to fetch shared document content');
    res.status(500).json({ error: 'Failed to fetch document content' });
  }
});

/**
 * PUT /api/share/link/:token/content
 * Save edits to a shared document via link (edit permission required)
 */
router.put('/link/:token/content', requireAuth, [
  body('content').notEmpty().withMessage('Content required'),
  body('sidecar').optional({ nullable: true }),
  body('baseVersion').optional().isInt({ min: 0 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { token } = req.params;

    const share = db.prepare(`
      SELECT ds.*, sd.user_id AS doc_owner_id, sd.version AS doc_version
      FROM document_shares ds
      JOIN sync_documents sd ON ds.document_id = sd.id
      WHERE ds.link_token = ? AND ds.link_enabled = 1
    `).get(token);

    if (!share) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This share link has expired' });
    }

    if (share.link_permission !== 'edit') {
      return res.status(403).json({ error: 'Edit permission required' });
    }

    // Version conflict detection (if client sends baseVersion)
    const { content, sidecar, baseVersion } = req.body;
    if (baseVersion !== undefined && baseVersion !== null) {
      if (share.doc_version !== baseVersion) {
        return res.status(409).json({
          error: 'Document was updated by another user. Reload to see the latest version.',
          currentVersion: share.doc_version,
          baseVersion,
        });
      }
    }

    const result = await uploadDocument(share.doc_owner_id, share.document_id, content, sidecar);

    // Update sync_documents metadata
    db.prepare(`
      UPDATE sync_documents
      SET content_hash = ?, sidecar_hash = ?, size_bytes = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(result.contentHash, result.sidecarHash, result.sizeBytes, share.document_id);

    const newVersion = share.doc_version + 1;
    res.json({ success: true, version: newVersion });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to save shared document');
    res.status(500).json({ error: 'Failed to save document' });
  }
});

// ============================================================================
// Owner management endpoints (require auth + pro subscription + ownership)
// ============================================================================

/**
 * POST /api/share/:docId
 * Create or update share settings for a document
 */
router.post('/:docId', requireAuth, requirePro, requireOwner, [
  param('docId').notEmpty(),
  body('linkPermission').optional().isIn(['view', 'edit']),
  body('linkEnabled').optional().isBoolean(),
  body('allowCopy').optional().isBoolean(),
  body('expiresAt').optional({ nullable: true }).isISO8601(),
], (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { docId } = req.params;
    const userId = req.user.id;
    const { linkPermission, linkEnabled, allowCopy, expiresAt } = req.body;

    // Check if share already exists
    let share = db.prepare(
      'SELECT * FROM document_shares WHERE document_id = ?'
    ).get(docId);

    if (share) {
      // Update existing share
      const updates = [];
      const params = [];

      if (linkPermission !== undefined) {
        updates.push('link_permission = ?');
        params.push(linkPermission);
      }
      if (linkEnabled !== undefined) {
        updates.push('link_enabled = ?');
        params.push(linkEnabled ? 1 : 0);
        // Generate link token on first enable if none exists
        if (linkEnabled && !share.link_token) {
          const token = crypto.randomBytes(16).toString('base64url');
          updates.push('link_token = ?');
          params.push(token);
        }
      }
      if (allowCopy !== undefined) {
        updates.push('allow_copy = ?');
        params.push(allowCopy ? 1 : 0);
      }
      if (expiresAt !== undefined) {
        updates.push('expires_at = ?');
        params.push(expiresAt);
      }

      if (updates.length > 0) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(docId);
        db.prepare(
          `UPDATE document_shares SET ${updates.join(', ')} WHERE document_id = ?`
        ).run(...params);
      }

      share = db.prepare('SELECT * FROM document_shares WHERE document_id = ?').get(docId);
    } else {
      // Create new share
      const id = crypto.randomUUID();
      const linkToken = (linkEnabled !== false) ? crypto.randomBytes(16).toString('base64url') : null;

      db.prepare(`
        INSERT INTO document_shares (id, document_id, owner_id, link_token, link_permission, link_enabled, allow_copy, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        docId,
        userId,
        linkToken,
        linkPermission || 'view',
        (linkEnabled !== false) ? 1 : 0,
        (allowCopy !== false) ? 1 : 0,
        expiresAt || null
      );

      share = db.prepare('SELECT * FROM document_shares WHERE id = ?').get(id);
    }

    // Fetch access list
    const accessList = db.prepare(
      'SELECT * FROM document_access WHERE share_id = ? ORDER BY created_at DESC'
    ).all(share.id);

    res.json({
      id: share.id,
      documentId: share.document_id,
      linkToken: share.link_token,
      linkPermission: share.link_permission,
      linkEnabled: !!share.link_enabled,
      allowCopy: !!share.allow_copy,
      expiresAt: share.expires_at,
      createdAt: share.created_at,
      updatedAt: share.updated_at,
      accessList: accessList.map(a => ({
        id: a.id,
        email: a.email,
        permission: a.permission,
        userId: a.user_id,
        acceptedAt: a.accepted_at,
        createdAt: a.created_at,
      })),
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to create/update share');
    res.status(500).json({ error: 'Failed to update share settings' });
  }
});

/**
 * GET /api/share/:docId
 * Get share settings + access list for a document
 */
router.get('/:docId', requireAuth, requirePro, requireOwner, (req, res) => {
  try {
    const { docId } = req.params;

    const share = db.prepare(
      'SELECT * FROM document_shares WHERE document_id = ?'
    ).get(docId);

    if (!share) {
      return res.json({
        exists: false,
        linkEnabled: false,
        accessList: [],
      });
    }

    const accessList = db.prepare(
      'SELECT * FROM document_access WHERE share_id = ? ORDER BY created_at DESC'
    ).all(share.id);

    res.json({
      exists: true,
      id: share.id,
      documentId: share.document_id,
      linkToken: share.link_token,
      linkPermission: share.link_permission,
      linkEnabled: !!share.link_enabled,
      allowCopy: !!share.allow_copy,
      expiresAt: share.expires_at,
      createdAt: share.created_at,
      updatedAt: share.updated_at,
      accessList: accessList.map(a => ({
        id: a.id,
        email: a.email,
        permission: a.permission,
        userId: a.user_id,
        acceptedAt: a.accepted_at,
        createdAt: a.created_at,
      })),
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get share settings');
    res.status(500).json({ error: 'Failed to get share settings' });
  }
});

/**
 * DELETE /api/share/:docId
 * Delete share settings (cascades to access entries)
 */
router.delete('/:docId', requireAuth, requirePro, requireOwner, (req, res) => {
  try {
    const { docId } = req.params;

    const result = db.prepare(
      'DELETE FROM document_shares WHERE document_id = ?'
    ).run(docId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Share not found' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to delete share');
    res.status(500).json({ error: 'Failed to delete share' });
  }
});

/**
 * POST /api/share/:docId/invite
 * Invite a user by email
 */
router.post('/:docId/invite', requireAuth, requirePro, requireOwner, [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('permission').optional().isIn(['view', 'edit']).withMessage('Permission must be view or edit'),
], (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { docId } = req.params;
    const { email, permission = 'view' } = req.body;
    const userId = req.user.id;

    // Can't invite yourself
    if (email === req.user.email) {
      return res.status(400).json({ error: 'You cannot invite yourself' });
    }

    // Ensure share exists (create if needed)
    let share = db.prepare(
      'SELECT * FROM document_shares WHERE document_id = ?'
    ).get(docId);

    if (!share) {
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO document_shares (id, document_id, owner_id, link_enabled)
        VALUES (?, ?, ?, 0)
      `).run(id, docId, userId);
      share = db.prepare('SELECT * FROM document_shares WHERE id = ?').get(id);
    }

    // Check if already invited
    const existing = db.prepare(
      'SELECT id FROM document_access WHERE share_id = ? AND email = ?'
    ).get(share.id, email);

    if (existing) {
      return res.status(409).json({ error: 'User already invited' });
    }

    // Check if invitee has an account
    const invitee = findUserByEmail(email);

    const accessId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO document_access (id, share_id, user_id, email, permission, accepted_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      accessId,
      share.id,
      invitee?.id || null,
      email,
      permission,
      invitee ? new Date().toISOString() : null // Auto-accept if user exists
    );

    // Ensure share has a link token for the invitation URL
    if (!share.link_token) {
      const linkToken = crypto.randomBytes(16).toString('base64url');
      db.prepare('UPDATE document_shares SET link_token = ? WHERE id = ?').run(linkToken, share.id);
      share.link_token = linkToken;
    }

    // Get document path for email
    const doc = db.prepare('SELECT path FROM sync_documents WHERE id = ?').get(docId);
    const documentTitle = doc?.path?.split('/').pop()?.replace(/\.\w+$/, '') || 'Untitled';
    const shareUrl = `${WEB_REDIRECT_BASE}/s/${share.link_token}`;

    // Send invitation email (fire-and-forget)
    sendShareInvitationEmail(email, req.user.display_name || req.user.email, documentTitle, shareUrl).catch(err => {
      logger.error({ error: err?.message, email }, 'Failed to send share invitation email');
    });

    res.json({
      id: accessId,
      email,
      permission,
      userId: invitee?.id || null,
      acceptedAt: invitee ? new Date().toISOString() : null,
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to invite user');
    res.status(500).json({ error: 'Failed to send invitation' });
  }
});

/**
 * DELETE /api/share/:docId/access/:accessId
 * Remove an access entry
 */
router.delete('/:docId/access/:accessId', requireAuth, requirePro, requireOwner, (req, res) => {
  try {
    const { accessId } = req.params;

    // Verify access entry belongs to this document's share
    const share = db.prepare(
      'SELECT id FROM document_shares WHERE document_id = ?'
    ).get(req.params.docId);

    if (!share) {
      return res.status(404).json({ error: 'Share not found' });
    }

    const result = db.prepare(
      'DELETE FROM document_access WHERE id = ? AND share_id = ?'
    ).run(accessId, share.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Access entry not found' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to remove access');
    res.status(500).json({ error: 'Failed to remove access' });
  }
});

/**
 * PATCH /api/share/:docId/access/:accessId
 * Update permission for an access entry
 */
router.patch('/:docId/access/:accessId', requireAuth, requirePro, requireOwner, [
  body('permission').isIn(['view', 'edit']).withMessage('Permission must be view or edit'),
], (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { accessId } = req.params;
    const { permission } = req.body;

    const share = db.prepare(
      'SELECT id FROM document_shares WHERE document_id = ?'
    ).get(req.params.docId);

    if (!share) {
      return res.status(404).json({ error: 'Share not found' });
    }

    const result = db.prepare(
      'UPDATE document_access SET permission = ? WHERE id = ? AND share_id = ?'
    ).run(permission, accessId, share.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Access entry not found' });
    }

    res.json({ success: true, permission });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to update access');
    res.status(500).json({ error: 'Failed to update access' });
  }
});

export default router;
