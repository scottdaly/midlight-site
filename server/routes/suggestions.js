/**
 * Suggestions Routes (Tracked Changes)
 *
 * Create, accept, and reject suggestions on shared documents.
 */

import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { resolveDocumentAccess } from '../middleware/shareAuth.js';
import db from '../db/index.js';
import { logger } from '../utils/logger.js';

const router = Router();

const listSuggestions = db.prepare(`
  SELECT s.*, u.display_name AS author_name, u.email AS author_email, u.avatar_url AS author_avatar
  FROM document_suggestions s
  JOIN users u ON s.author_id = u.id
  WHERE s.document_id = ?
  ORDER BY s.created_at ASC
`);

const getSuggestion = db.prepare(`
  SELECT * FROM document_suggestions WHERE id = ? AND document_id = ?
`);

const insertSuggestion = db.prepare(`
  INSERT INTO document_suggestions (id, document_id, author_id, type, anchor_from, anchor_to, original_text, suggested_text, anchor_yjs_from, anchor_yjs_to)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateStatus = db.prepare(`
  UPDATE document_suggestions SET status = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?
`);

/**
 * GET /:docId — List all suggestions for a document
 */
router.get('/:docId', requireAuth, resolveDocumentAccess, (req, res) => {
  try {
    const rows = listSuggestions.all(req.params.docId);
    res.json({
      suggestions: rows.map(formatSuggestion),
    });
  } catch (err) {
    logger.error({ error: err.message, docId: req.params.docId }, 'Failed to list suggestions');
    res.status(500).json({ error: 'Failed to load suggestions' });
  }
});

/**
 * POST /:docId — Create a suggestion
 */
router.post('/:docId', requireAuth, resolveDocumentAccess, (req, res) => {
  if (req.docPermission === 'view') {
    return res.status(403).json({ error: 'Edit access required' });
  }

  const { type, anchorFrom, anchorTo, originalText, suggestedText, anchorYjsFrom, anchorYjsTo } = req.body;

  if (!type || !['insertion', 'deletion', 'replacement'].includes(type)) {
    return res.status(400).json({ error: 'Invalid suggestion type' });
  }
  if (anchorFrom == null || anchorTo == null) {
    return res.status(400).json({ error: 'Anchor positions required' });
  }

  try {
    const id = crypto.randomUUID();
    insertSuggestion.run(
      id, req.params.docId, req.user.id, type,
      anchorFrom, anchorTo, originalText || null, suggestedText || null,
      anchorYjsFrom || null, anchorYjsTo || null
    );

    res.status(201).json({
      suggestion: formatSuggestion({
        id, document_id: req.params.docId, author_id: req.user.id, type,
        anchor_from: anchorFrom, anchor_to: anchorTo,
        original_text: originalText, suggested_text: suggestedText,
        anchor_yjs_from: anchorYjsFrom, anchor_yjs_to: anchorYjsTo,
        status: 'pending', resolved_by: null, resolved_at: null,
        created_at: new Date().toISOString(),
        author_name: req.user.display_name, author_email: req.user.email, author_avatar: req.user.avatar_url,
      }),
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create suggestion');
    res.status(500).json({ error: 'Failed to create suggestion' });
  }
});

/**
 * POST /:docId/accept-all — Accept all pending suggestions (owner only)
 * NOTE: Must be defined BEFORE /:docId/:sugId routes to avoid Express matching "accept-all" as a sugId
 */
router.post('/:docId/accept-all', requireAuth, resolveDocumentAccess, (req, res) => {
  if (req.docPermission !== 'owner') {
    return res.status(403).json({ error: 'Owner access required' });
  }

  try {
    const result = db.prepare(
      "UPDATE document_suggestions SET status = 'accepted', resolved_by = ?, resolved_at = datetime('now') WHERE document_id = ? AND status = 'pending'"
    ).run(req.user.id, req.params.docId);
    res.json({ accepted: result.changes });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to accept all suggestions');
    res.status(500).json({ error: 'Failed to accept all suggestions' });
  }
});

/**
 * POST /:docId/:sugId/accept — Accept a suggestion
 */
router.post('/:docId/:sugId/accept', requireAuth, resolveDocumentAccess, (req, res) => {
  if (req.docPermission !== 'owner' && req.docPermission !== 'edit') {
    return res.status(403).json({ error: 'Edit access required' });
  }

  const suggestion = getSuggestion.get(req.params.sugId, req.params.docId);
  if (!suggestion) return res.status(404).json({ error: 'Suggestion not found' });
  if (suggestion.status !== 'pending') return res.status(400).json({ error: 'Suggestion already resolved' });

  try {
    updateStatus.run('accepted', req.user.id, req.params.sugId);
    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to accept suggestion');
    res.status(500).json({ error: 'Failed to accept suggestion' });
  }
});

/**
 * POST /:docId/:sugId/reject — Reject a suggestion
 */
router.post('/:docId/:sugId/reject', requireAuth, resolveDocumentAccess, (req, res) => {
  if (req.docPermission !== 'owner' && req.docPermission !== 'edit') {
    return res.status(403).json({ error: 'Edit access required' });
  }

  const suggestion = getSuggestion.get(req.params.sugId, req.params.docId);
  if (!suggestion) return res.status(404).json({ error: 'Suggestion not found' });
  if (suggestion.status !== 'pending') return res.status(400).json({ error: 'Suggestion already resolved' });

  try {
    updateStatus.run('rejected', req.user.id, req.params.sugId);
    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to reject suggestion');
    res.status(500).json({ error: 'Failed to reject suggestion' });
  }
});

function formatSuggestion(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    authorId: row.author_id,
    authorName: row.author_name || null,
    authorEmail: row.author_email || null,
    authorAvatar: row.author_avatar || null,
    type: row.type,
    anchorFrom: row.anchor_from,
    anchorTo: row.anchor_to,
    originalText: row.original_text || null,
    suggestedText: row.suggested_text || null,
    anchorYjsFrom: row.anchor_yjs_from || null,
    anchorYjsTo: row.anchor_yjs_to || null,
    status: row.status,
    resolvedBy: row.resolved_by || null,
    resolvedAt: row.resolved_at || null,
    createdAt: row.created_at,
  };
}

export default router;
