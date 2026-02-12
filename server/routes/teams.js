/**
 * Teams Routes
 *
 * Team workspace CRUD, member management, and team document association.
 */

import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth, requireSubscription } from '../middleware/auth.js';
import { getDocumentPermission } from '../middleware/shareAuth.js';
import db from '../db/index.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * GET / — List teams for the current user
 */
router.get('/', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT t.*, tm.role AS my_role,
        (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS member_count,
        (SELECT COUNT(*) FROM team_documents WHERE team_id = t.id) AS document_count
      FROM teams t
      JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
      ORDER BY t.created_at DESC
    `).all(req.user.id);

    res.json({ teams: rows.map(formatTeam) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list teams');
    res.status(500).json({ error: 'Failed to load teams' });
  }
});

/**
 * POST / — Create a team (requires Premium)
 */
router.post('/', requireAuth, requireSubscription('premium'), (req, res) => {
  const { name, description } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Team name is required' });
  }

  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) {
    return res.status(400).json({ error: 'Invalid team name' });
  }

  try {
    const id = crypto.randomUUID();
    const memberId = crypto.randomUUID();

    db.prepare(`
      INSERT INTO teams (id, name, slug, description, owner_id) VALUES (?, ?, ?, ?, ?)
    `).run(id, name.trim(), slug, description || null, req.user.id);

    // Add owner as team member
    db.prepare(`
      INSERT INTO team_members (id, team_id, user_id, role) VALUES (?, ?, ?, 'owner')
    `).run(memberId, id, req.user.id);

    res.status(201).json({
      team: { id, name: name.trim(), slug, description: description || null, ownerId: req.user.id, myRole: 'owner', memberCount: 1, documentCount: 0 },
    });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'A team with this name already exists' });
    }
    logger.error({ error: err.message }, 'Failed to create team');
    res.status(500).json({ error: 'Failed to create team' });
  }
});

/**
 * GET /:teamId — Get team details
 */
router.get('/:teamId', requireAuth, (req, res) => {
  try {
    const team = db.prepare(`
      SELECT t.*, tm.role AS my_role FROM teams t
      JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
      WHERE t.id = ?
    `).get(req.user.id, req.params.teamId);

    if (!team) return res.status(404).json({ error: 'Team not found' });

    const members = db.prepare(`
      SELECT tm.*, u.display_name, u.email, u.avatar_url
      FROM team_members tm JOIN users u ON tm.user_id = u.id
      WHERE tm.team_id = ?
    `).all(req.params.teamId);

    const documents = db.prepare(`
      SELECT td.*, sd.path, u.display_name AS added_by_name
      FROM team_documents td
      JOIN sync_documents sd ON td.document_id = sd.id
      JOIN users u ON td.added_by = u.id
      WHERE td.team_id = ?
    `).all(req.params.teamId);

    res.json({
      team: formatTeam(team),
      members: members.map(formatMember),
      documents: documents.map(formatTeamDoc),
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get team');
    res.status(500).json({ error: 'Failed to load team' });
  }
});

/**
 * PATCH /:teamId — Update team (admin/owner)
 */
router.patch('/:teamId', requireAuth, (req, res) => {
  const member = db.prepare(
    "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?"
  ).get(req.params.teamId, req.user.id);

  if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { name, description } = req.body;
  const updates = [];
  const values = [];

  if (name) { updates.push('name = ?'); values.push(name.trim()); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description || null); }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  try {
    values.push(req.params.teamId);
    db.prepare(`UPDATE teams SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update team' });
  }
});

/**
 * DELETE /:teamId — Delete team (owner only)
 */
router.delete('/:teamId', requireAuth, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ? AND owner_id = ?').get(req.params.teamId, req.user.id);
  if (!team) return res.status(403).json({ error: 'Only the team owner can delete it' });

  try {
    db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.teamId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete team' });
  }
});

/**
 * POST /:teamId/members — Add team member
 */
router.post('/:teamId/members', requireAuth, (req, res) => {
  const member = db.prepare(
    "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?"
  ).get(req.params.teamId, req.user.id);

  if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { email, role = 'member' } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!['member', 'viewer', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

  try {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Check member limit (50 per team)
    const count = db.prepare('SELECT COUNT(*) AS count FROM team_members WHERE team_id = ?').get(req.params.teamId);
    if (count.count >= 50) return res.status(400).json({ error: 'Team member limit reached (50)' });

    const id = crypto.randomUUID();
    db.prepare('INSERT INTO team_members (id, team_id, user_id, role) VALUES (?, ?, ?, ?)').run(id, req.params.teamId, user.id, role);
    res.status(201).json({ success: true });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'User is already a team member' });
    }
    res.status(500).json({ error: 'Failed to add member' });
  }
});

/**
 * DELETE /:teamId/members/:memberId — Remove team member
 */
router.delete('/:teamId/members/:memberId', requireAuth, (req, res) => {
  const myMember = db.prepare(
    "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?"
  ).get(req.params.teamId, req.user.id);

  if (!myMember || (myMember.role !== 'owner' && myMember.role !== 'admin')) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const target = db.prepare('SELECT * FROM team_members WHERE id = ? AND team_id = ?').get(req.params.memberId, req.params.teamId);
  if (!target) return res.status(404).json({ error: 'Member not found' });
  if (target.role === 'owner') return res.status(400).json({ error: 'Cannot remove the team owner' });

  try {
    db.prepare('DELETE FROM team_members WHERE id = ?').run(req.params.memberId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

/**
 * POST /:teamId/documents — Add document to team
 */
router.post('/:teamId/documents', requireAuth, (req, res) => {
  const member = db.prepare(
    "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?"
  ).get(req.params.teamId, req.user.id);

  if (!member || member.role === 'viewer') {
    return res.status(403).json({ error: 'Member access required' });
  }

  const { documentId } = req.body;
  if (!documentId) return res.status(400).json({ error: 'Document ID required' });

  // Verify user owns or has edit access to the document
  const docAccess = getDocumentPermission(req.user.id, documentId);
  if (!docAccess || docAccess === 'view') {
    return res.status(403).json({ error: 'You must own or have edit access to this document' });
  }

  try {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO team_documents (id, team_id, document_id, added_by) VALUES (?, ?, ?, ?)').run(id, req.params.teamId, documentId, req.user.id);
    res.status(201).json({ success: true });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Document already in team' });
    }
    res.status(500).json({ error: 'Failed to add document' });
  }
});

/**
 * DELETE /:teamId/documents/:docId — Remove document from team
 */
router.delete('/:teamId/documents/:docId', requireAuth, (req, res) => {
  const member = db.prepare(
    "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?"
  ).get(req.params.teamId, req.user.id);

  if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    db.prepare('DELETE FROM team_documents WHERE team_id = ? AND document_id = ?').run(req.params.teamId, req.params.docId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove document' });
  }
});

function formatTeam(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description || null,
    ownerId: row.owner_id,
    myRole: row.my_role || null,
    memberCount: row.member_count || 0,
    documentCount: row.document_count || 0,
    createdAt: row.created_at,
  };
}

function formatMember(row) {
  return {
    id: row.id,
    userId: row.user_id,
    role: row.role,
    displayName: row.display_name || null,
    email: row.email,
    avatarUrl: row.avatar_url || null,
    joinedAt: row.joined_at,
  };
}

function formatTeamDoc(row) {
  return {
    id: row.id,
    documentId: row.document_id,
    path: row.path,
    addedByName: row.added_by_name || null,
    createdAt: row.created_at,
  };
}

export default router;
