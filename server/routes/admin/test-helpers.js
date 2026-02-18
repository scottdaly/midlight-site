/**
 * Admin Test Helpers
 *
 * Endpoints for seeding test data during E2E tests.
 * Only available when NODE_ENV !== 'production'.
 */

import express from 'express';
import crypto from 'crypto';
import db from '../../db/index.js';
import { createUser } from '../../services/authService.js';
import { generateTokenPair } from '../../services/tokenService.js';

const router = express.Router();

// Block in production
router.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

/**
 * POST /api/admin/test/users
 * Create a user and return tokens (bypasses signup rate limiting).
 * Body: { email, password, displayName? }
 */
router.post('/users', async (req, res) => {
  try {
    const { email, password = 'TestPassword123!', displayName = 'E2E Test User' } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const user = await createUser({ email, password, displayName });
    const tokens = generateTokenPair(user.id, 'e2e-test', 'e2e');

    res.json({
      user: { id: user.id, email: user.email, displayName: user.display_name },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Internal server error' });
  }
});

/**
 * POST /api/admin/test/documents
 * Create a sync_document row directly (bypasses R2 storage).
 * Body: { userId, path, content?, sidecar? }
 */
router.post('/documents', (req, res) => {
  try {
    const { userId, path, content = '', sidecar = '{}' } = req.body;
    if (!userId || !path) {
      return res.status(400).json({ error: 'userId and path are required' });
    }

    const id = crypto.randomUUID();
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const sidecarStr = typeof sidecar === 'string' ? sidecar : JSON.stringify(sidecar);
    const sidecarHash = crypto.createHash('sha256').update(sidecarStr).digest('hex');

    db.prepare(`
      INSERT INTO sync_documents (id, user_id, path, content_hash, sidecar_hash, version, size_bytes)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(id, userId, path, contentHash, sidecarHash, Buffer.byteLength(content, 'utf-8'));

    res.json({ id, path });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Internal server error' });
  }
});

/**
 * POST /api/admin/test/notifications
 * Seed a notification row for a user.
 * Body: { userId, type, title, body, documentId?, commentId?, actorId? }
 */
router.post('/notifications', (req, res) => {
  try {
    const { userId, type = 'comment', title = 'Test notification', body = '', documentId, commentId, actorId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, body, document_id, comment_id, actor_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, type, title, body, documentId || null, commentId || null, actorId || null);

    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Internal server error' });
  }
});

/**
 * POST /api/admin/test/activity
 * Seed an activity row for a document.
 * Body: { documentId, userId, eventType, metadata? }
 */
router.post('/activity', (req, res) => {
  try {
    const { documentId, userId, eventType = 'edit', metadata = {} } = req.body;
    if (!documentId || !userId) {
      return res.status(400).json({ error: 'documentId and userId are required' });
    }

    const result = db.prepare(`
      INSERT INTO document_activity (document_id, user_id, event_type, metadata)
      VALUES (?, ?, ?, ?)
    `).run(documentId, userId, eventType, JSON.stringify(metadata));

    res.json({ id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Internal server error' });
  }
});

/**
 * POST /api/admin/test/branch-content
 * Seed content for a document branch.
 * Body: { branchId, content?, sidecar? }
 */
router.post('/branch-content', (req, res) => {
  try {
    const { branchId, content = '# Branch Content', sidecar = '{}' } = req.body;
    if (!branchId) {
      return res.status(400).json({ error: 'branchId is required' });
    }

    const sidecarStr = typeof sidecar === 'string' ? sidecar : JSON.stringify(sidecar);

    db.prepare(`
      INSERT OR REPLACE INTO document_branch_content (branch_id, content, sidecar, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(branchId, content, sidecarStr);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Internal server error' });
  }
});

export default router;
