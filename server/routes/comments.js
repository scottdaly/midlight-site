/**
 * Comments Routes
 *
 * Inline document comments with threading and resolve/reopen.
 * All endpoints require authentication + document access.
 */

import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { resolveDocumentAccess, getDocumentPermission } from '../middleware/shareAuth.js';
import db from '../db/index.js';
import { logger } from '../utils/logger.js';

const router = Router();

// Prepared statements
const listComments = db.prepare(`
  SELECT c.*, u.display_name AS author_name, u.email AS author_email, u.avatar_url AS author_avatar,
         ru.display_name AS resolver_name
  FROM document_comments c
  JOIN users u ON c.author_id = u.id
  LEFT JOIN users ru ON c.resolved_by = ru.id
  WHERE c.document_id = ? AND c.deleted_at IS NULL
  ORDER BY c.created_at ASC
`);

const getComment = db.prepare(`
  SELECT * FROM document_comments WHERE id = ? AND document_id = ?
`);

const insertComment = db.prepare(`
  INSERT INTO document_comments (id, document_id, author_id, parent_id, content, anchor_from, anchor_to, anchor_text, anchor_yjs_from, anchor_yjs_to)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateComment = db.prepare(`
  UPDATE document_comments SET content = ?, edited_at = datetime('now') WHERE id = ?
`);

const softDeleteComment = db.prepare(`
  UPDATE document_comments SET deleted_at = datetime('now') WHERE id = ?
`);

const resolveComment = db.prepare(`
  UPDATE document_comments SET resolved_at = datetime('now'), resolved_by = ? WHERE id = ?
`);

const reopenComment = db.prepare(`
  UPDATE document_comments SET resolved_at = NULL, resolved_by = NULL WHERE id = ?
`);

/**
 * GET /:docId — List all comments (threads + replies) for a document
 */
router.get('/:docId', requireAuth, resolveDocumentAccess, (req, res) => {
  try {
    const rows = listComments.all(req.params.docId);

    // Organize into threads (top-level) with nested replies
    const threadsMap = new Map();
    const replies = [];

    for (const row of rows) {
      const comment = formatComment(row);
      if (!row.parent_id) {
        comment.replies = [];
        threadsMap.set(row.id, comment);
      } else {
        replies.push(comment);
      }
    }

    // Attach replies to their parent threads
    for (const reply of replies) {
      const thread = threadsMap.get(reply.parentId);
      if (thread) {
        thread.replies.push(reply);
      }
    }

    res.json({ comments: Array.from(threadsMap.values()) });
  } catch (err) {
    logger.error({ error: err.message, docId: req.params.docId }, 'Failed to list comments');
    res.status(500).json({ error: 'Failed to load comments' });
  }
});

/**
 * POST /:docId — Create a comment or reply
 */
router.post('/:docId', requireAuth, resolveDocumentAccess, (req, res) => {
  // View-only users cannot create comments
  if (req.docPermission === 'view') {
    return res.status(403).json({ error: 'Edit access required to comment' });
  }

  const { content, parentId, anchorFrom, anchorTo, anchorText, anchorYjsFrom, anchorYjsTo } = req.body;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: 'Comment content is required' });
  }

  if (content.length > 10000) {
    return res.status(400).json({ error: 'Comment too long (max 10000 characters)' });
  }

  // If it's a reply, verify parent exists and belongs to same document
  if (parentId) {
    const parent = getComment.get(parentId, req.params.docId);
    if (!parent) {
      return res.status(404).json({ error: 'Parent comment not found' });
    }
    // Replies must be to top-level comments (no nested replies)
    if (parent.parent_id) {
      return res.status(400).json({ error: 'Cannot reply to a reply' });
    }
  }

  try {
    const id = crypto.randomUUID();
    insertComment.run(
      id,
      req.params.docId,
      req.user.id,
      parentId || null,
      content.trim(),
      anchorFrom ?? null,
      anchorTo ?? null,
      anchorText ?? null,
      anchorYjsFrom ?? null,
      anchorYjsTo ?? null
    );

    const comment = formatComment({
      id,
      document_id: req.params.docId,
      author_id: req.user.id,
      author_name: req.user.display_name,
      author_email: req.user.email,
      author_avatar: req.user.avatar_url,
      parent_id: parentId || null,
      content: content.trim(),
      anchor_from: anchorFrom ?? null,
      anchor_to: anchorTo ?? null,
      anchor_text: anchorText ?? null,
      anchor_yjs_from: anchorYjsFrom ?? null,
      anchor_yjs_to: anchorYjsTo ?? null,
      resolved_at: null,
      resolved_by: null,
      resolver_name: null,
      edited_at: null,
      created_at: new Date().toISOString(),
      deleted_at: null,
    });

    res.status(201).json({ comment });
  } catch (err) {
    logger.error({ error: err.message, docId: req.params.docId }, 'Failed to create comment');
    res.status(500).json({ error: 'Failed to create comment' });
  }
});

/**
 * PATCH /:docId/:commentId — Edit a comment (author only)
 */
router.patch('/:docId/:commentId', requireAuth, resolveDocumentAccess, (req, res) => {
  const { content } = req.body;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return res.status(400).json({ error: 'Comment content is required' });
  }

  if (content.length > 10000) {
    return res.status(400).json({ error: 'Comment too long (max 10000 characters)' });
  }

  const comment = getComment.get(req.params.commentId, req.params.docId);
  if (!comment || comment.deleted_at) {
    return res.status(404).json({ error: 'Comment not found' });
  }

  // Only the author can edit their comment
  if (comment.author_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the author can edit this comment' });
  }

  try {
    updateComment.run(content.trim(), req.params.commentId);
    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err.message, commentId: req.params.commentId }, 'Failed to edit comment');
    res.status(500).json({ error: 'Failed to edit comment' });
  }
});

/**
 * DELETE /:docId/:commentId — Soft-delete a comment (author or owner)
 */
router.delete('/:docId/:commentId', requireAuth, resolveDocumentAccess, (req, res) => {
  const comment = getComment.get(req.params.commentId, req.params.docId);
  if (!comment || comment.deleted_at) {
    return res.status(404).json({ error: 'Comment not found' });
  }

  // Author or document owner can delete
  if (comment.author_id !== req.user.id && req.docPermission !== 'owner') {
    return res.status(403).json({ error: 'Only the author or document owner can delete this comment' });
  }

  try {
    softDeleteComment.run(req.params.commentId);
    // Also soft-delete all replies if this is a thread
    if (!comment.parent_id) {
      db.prepare(
        "UPDATE document_comments SET deleted_at = datetime('now') WHERE parent_id = ? AND deleted_at IS NULL"
      ).run(req.params.commentId);
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err.message, commentId: req.params.commentId }, 'Failed to delete comment');
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

/**
 * POST /:docId/:commentId/resolve — Resolve a comment thread
 */
router.post('/:docId/:commentId/resolve', requireAuth, resolveDocumentAccess, (req, res) => {
  if (req.docPermission === 'view') {
    return res.status(403).json({ error: 'Edit access required to resolve comments' });
  }

  const comment = getComment.get(req.params.commentId, req.params.docId);
  if (!comment || comment.deleted_at) {
    return res.status(404).json({ error: 'Comment not found' });
  }

  // Can only resolve top-level comments (threads)
  if (comment.parent_id) {
    return res.status(400).json({ error: 'Can only resolve top-level comment threads' });
  }

  try {
    resolveComment.run(req.user.id, req.params.commentId);
    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err.message, commentId: req.params.commentId }, 'Failed to resolve comment');
    res.status(500).json({ error: 'Failed to resolve comment' });
  }
});

/**
 * POST /:docId/:commentId/reopen — Reopen a resolved comment thread
 */
router.post('/:docId/:commentId/reopen', requireAuth, resolveDocumentAccess, (req, res) => {
  if (req.docPermission === 'view') {
    return res.status(403).json({ error: 'Edit access required to reopen comments' });
  }

  const comment = getComment.get(req.params.commentId, req.params.docId);
  if (!comment || comment.deleted_at) {
    return res.status(404).json({ error: 'Comment not found' });
  }

  if (!comment.resolved_at) {
    return res.status(400).json({ error: 'Comment is not resolved' });
  }

  try {
    reopenComment.run(req.params.commentId);
    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err.message, commentId: req.params.commentId }, 'Failed to reopen comment');
    res.status(500).json({ error: 'Failed to reopen comment' });
  }
});

/**
 * Format a database row into an API response.
 */
function formatComment(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    authorId: row.author_id,
    authorName: row.author_name || null,
    authorEmail: row.author_email || null,
    authorAvatar: row.author_avatar || null,
    parentId: row.parent_id || null,
    content: row.content,
    anchorFrom: row.anchor_from,
    anchorTo: row.anchor_to,
    anchorText: row.anchor_text || null,
    anchorYjsFrom: row.anchor_yjs_from || null,
    anchorYjsTo: row.anchor_yjs_to || null,
    resolvedAt: row.resolved_at || null,
    resolvedBy: row.resolved_by || null,
    resolverName: row.resolver_name || null,
    editedAt: row.edited_at || null,
    createdAt: row.created_at,
  };
}

export default router;
