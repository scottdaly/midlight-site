/**
 * Branches Routes
 *
 * Document version branches (fork & merge).
 */

import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { resolveDocumentAccess } from '../middleware/shareAuth.js';
import db from '../db/index.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * GET /:docId — List branches for a document
 */
router.get('/:docId', requireAuth, resolveDocumentAccess, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT b.*, u.display_name AS creator_name
      FROM document_branches b
      JOIN users u ON b.creator_id = u.id
      WHERE b.document_id = ?
      ORDER BY b.created_at DESC
    `).all(req.params.docId);

    res.json({ branches: rows.map(formatBranch) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list branches');
    res.status(500).json({ error: 'Failed to load branches' });
  }
});

/**
 * POST /:docId — Create a branch
 */
router.post('/:docId', requireAuth, resolveDocumentAccess, (req, res) => {
  if (req.docPermission === 'view') {
    return res.status(403).json({ error: 'Edit access required' });
  }

  const { name, baseVersionId, baseContentHash } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Branch name is required' });
  }
  if (!baseVersionId || !baseContentHash) {
    return res.status(400).json({ error: 'Base version info required' });
  }

  // Check branch limit (feature gating handled by client; server just caps at reasonable limit)
  const count = db.prepare(
    "SELECT COUNT(*) AS count FROM document_branches WHERE document_id = ? AND status = 'active'"
  ).get(req.params.docId);
  if (count.count >= 20) {
    return res.status(400).json({ error: 'Too many active branches (max 20)' });
  }

  try {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO document_branches (id, document_id, name, base_version_id, base_content_hash, creator_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.params.docId, name.trim(), baseVersionId, baseContentHash, req.user.id);

    // Copy current document content to branch content
    const docContent = db.prepare(
      'SELECT content, sidecar FROM sync_document_content WHERE document_id = ? LIMIT 1'
    ).get(req.params.docId);

    if (docContent) {
      db.prepare(
        'INSERT INTO document_branch_content (branch_id, content, sidecar) VALUES (?, ?, ?)'
      ).run(id, docContent.content, docContent.sidecar);
    }

    res.status(201).json({
      branch: {
        id, documentId: req.params.docId, name: name.trim(),
        baseVersionId, baseContentHash,
        creatorId: req.user.id, creatorName: req.user.display_name,
        status: 'active', mergedAt: null, mergedBy: null,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'A branch with this name already exists' });
    }
    logger.error({ error: err.message }, 'Failed to create branch');
    res.status(500).json({ error: 'Failed to create branch' });
  }
});

/**
 * GET /:docId/:branchId — Get branch details with content
 */
router.get('/:docId/:branchId', requireAuth, resolveDocumentAccess, (req, res) => {
  try {
    const branch = db.prepare(`
      SELECT b.*, u.display_name AS creator_name
      FROM document_branches b
      JOIN users u ON b.creator_id = u.id
      WHERE b.id = ? AND b.document_id = ?
    `).get(req.params.branchId, req.params.docId);

    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    const content = db.prepare(
      'SELECT content, sidecar FROM document_branch_content WHERE branch_id = ?'
    ).get(req.params.branchId);

    res.json({
      branch: formatBranch(branch),
      content: content ? { content: content.content, sidecar: content.sidecar } : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load branch' });
  }
});

/**
 * DELETE /:docId/:branchId — Abandon a branch
 */
router.delete('/:docId/:branchId', requireAuth, resolveDocumentAccess, (req, res) => {
  if (req.docPermission === 'view') {
    return res.status(403).json({ error: 'Edit access required' });
  }

  const branch = db.prepare(
    'SELECT * FROM document_branches WHERE id = ? AND document_id = ?'
  ).get(req.params.branchId, req.params.docId);

  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  if (branch.status !== 'active') return res.status(400).json({ error: 'Branch is not active' });

  try {
    db.prepare("UPDATE document_branches SET status = 'abandoned' WHERE id = ?").run(req.params.branchId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to abandon branch' });
  }
});

/**
 * POST /:docId/:branchId/merge — Merge branch back to main
 */
router.post('/:docId/:branchId/merge', requireAuth, resolveDocumentAccess, (req, res) => {
  if (req.docPermission !== 'owner' && req.docPermission !== 'edit') {
    return res.status(403).json({ error: 'Edit access required' });
  }

  const branch = db.prepare(
    'SELECT * FROM document_branches WHERE id = ? AND document_id = ?'
  ).get(req.params.branchId, req.params.docId);

  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  if (branch.status !== 'active') return res.status(400).json({ error: 'Branch is not active' });

  const branchContent = db.prepare(
    'SELECT content, sidecar FROM document_branch_content WHERE branch_id = ?'
  ).get(req.params.branchId);

  if (!branchContent) {
    return res.status(400).json({ error: 'Branch has no content' });
  }

  try {
    // Atomic merge: update content and mark branch merged in a single transaction
    const mergeTx = db.transaction(() => {
      db.prepare(
        "UPDATE sync_document_content SET content = ?, sidecar = ?, updated_at = datetime('now') WHERE document_id = ?"
      ).run(branchContent.content, branchContent.sidecar, req.params.docId);

      db.prepare(
        "UPDATE document_branches SET status = 'merged', merged_at = datetime('now'), merged_by = ? WHERE id = ?"
      ).run(req.user.id, req.params.branchId);
    });
    mergeTx();

    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to merge branch');
    res.status(500).json({ error: 'Failed to merge branch' });
  }
});

/**
 * GET /:docId/:branchId/diff — Get diff between branch and main
 */
router.get('/:docId/:branchId/diff', requireAuth, resolveDocumentAccess, (req, res) => {
  try {
    const branchContent = db.prepare(
      'SELECT content, sidecar FROM document_branch_content WHERE branch_id = ?'
    ).get(req.params.branchId);

    const mainContent = db.prepare(
      'SELECT content, sidecar FROM sync_document_content WHERE document_id = ? LIMIT 1'
    ).get(req.params.docId);

    res.json({
      branch: branchContent ? { content: branchContent.content, sidecar: branchContent.sidecar } : null,
      main: mainContent ? { content: mainContent.content, sidecar: mainContent.sidecar } : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get diff' });
  }
});

function formatBranch(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    name: row.name,
    baseVersionId: row.base_version_id,
    baseContentHash: row.base_content_hash,
    creatorId: row.creator_id,
    creatorName: row.creator_name || null,
    status: row.status,
    mergedAt: row.merged_at || null,
    mergedBy: row.merged_by || null,
    createdAt: row.created_at,
  };
}

export default router;
