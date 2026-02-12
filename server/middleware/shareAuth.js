/**
 * Share Authorization Middleware
 *
 * Permission resolution for document sharing.
 * Determines user access level (owner, edit, view) for shared documents.
 */

import db from '../db/index.js';

/**
 * Get a user's permission level for a document.
 * @param {number} userId - User ID
 * @param {string} documentId - Document ID
 * @returns {'owner' | 'edit' | 'view' | null}
 */
export function getDocumentPermission(userId, documentId) {
  // Check ownership
  const doc = db.prepare(
    'SELECT id FROM sync_documents WHERE id = ? AND user_id = ?'
  ).get(documentId, userId);
  if (doc) return 'owner';

  // Check explicit access via document_access
  const access = db.prepare(`
    SELECT da.permission FROM document_access da
    JOIN document_shares ds ON da.share_id = ds.id
    WHERE ds.document_id = ? AND da.user_id = ? AND da.accepted_at IS NOT NULL
  `).get(documentId, userId);
  if (access) return access.permission;

  return null;
}

/**
 * Middleware: resolve document access from params, auth, or link token.
 * Sets req.docPermission and req.shareDoc on success.
 * Checks: ownership → explicit access → link token → 403
 */
export function resolveDocumentAccess(req, res, next) {
  const docId = req.params.docId;
  const userId = req.user?.id;
  const token = req.query.token || req.headers['x-share-token'];

  if (!docId) {
    return res.status(400).json({ error: 'Document ID required' });
  }

  // Check ownership first
  if (userId) {
    const doc = db.prepare(
      'SELECT id, user_id FROM sync_documents WHERE id = ?'
    ).get(docId);

    if (doc && doc.user_id === userId) {
      req.docPermission = 'owner';
      req.shareDoc = doc;
      return next();
    }

    // Check explicit access
    const access = db.prepare(`
      SELECT da.permission FROM document_access da
      JOIN document_shares ds ON da.share_id = ds.id
      WHERE ds.document_id = ? AND da.user_id = ? AND da.accepted_at IS NOT NULL
    `).get(docId, userId);

    if (access) {
      req.docPermission = access.permission;
      req.shareDoc = doc;
      return next();
    }
  }

  // Check link token
  if (token) {
    const share = db.prepare(`
      SELECT ds.*, sd.user_id AS doc_owner_id FROM document_shares ds
      JOIN sync_documents sd ON ds.document_id = sd.id
      WHERE ds.link_token = ? AND ds.link_enabled = 1
    `).get(token);

    if (share) {
      // Check expiration
      if (share.expires_at && new Date(share.expires_at) < new Date()) {
        return res.status(410).json({ error: 'This share link has expired' });
      }
      req.docPermission = share.link_permission;
      req.shareDoc = share;
      return next();
    }
  }

  return res.status(403).json({ error: 'Access denied' });
}

/**
 * Middleware: require document ownership.
 * Sets req.shareDoc on success.
 */
export function requireOwner(req, res, next) {
  const docId = req.params.docId;
  const userId = req.user?.id;

  if (!docId || !userId) {
    return res.status(400).json({ error: 'Document ID and authentication required' });
  }

  const doc = db.prepare(
    'SELECT id, user_id FROM sync_documents WHERE id = ? AND user_id = ?'
  ).get(docId, userId);

  if (!doc) {
    return res.status(403).json({ error: 'You do not own this document' });
  }

  req.shareDoc = doc;
  next();
}
