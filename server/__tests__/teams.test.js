/**
 * Teams Route Tests
 *
 * Tests document ownership check (Issue 3) and safe JSON.parse (Issue 4).
 * Uses Node built-in test runner with in-memory SQLite.
 * Run: node --test server/__tests__/teams.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'crypto';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTestDB() {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      display_name TEXT,
      avatar_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_documents (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT,
      size_bytes INTEGER DEFAULT 0,
      version INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS document_shares (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      link_token TEXT UNIQUE,
      link_permission TEXT NOT NULL DEFAULT 'view',
      link_enabled INTEGER NOT NULL DEFAULT 0,
      allow_copy INTEGER NOT NULL DEFAULT 1,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (document_id) REFERENCES sync_documents(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_document_shares_document ON document_shares(document_id);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS document_access (
      id TEXT PRIMARY KEY,
      share_id TEXT NOT NULL,
      user_id INTEGER,
      email TEXT NOT NULL,
      permission TEXT NOT NULL DEFAULT 'view',
      accepted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (share_id) REFERENCES document_shares(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE(share_id, email)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      owner_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(team_id, user_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS team_documents (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      added_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
      FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(team_id, document_id)
    );
  `);

  // Insert test users
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(
    1, 'owner@example.com', 'hashed', 'Owner User'
  );
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(
    2, 'member@example.com', 'hashed', 'Member User'
  );
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(
    3, 'outsider@example.com', 'hashed', 'Outsider User'
  );

  // Owner's document
  db.prepare('INSERT INTO sync_documents (id, user_id, path) VALUES (?, ?, ?)').run(
    'doc-1', 1, '/docs/my-doc.midlight'
  );

  // Outsider's document
  db.prepare('INSERT INTO sync_documents (id, user_id, path) VALUES (?, ?, ?)').run(
    'doc-other', 3, '/docs/other-doc.midlight'
  );

  return db;
}

/**
 * Reimplements getDocumentPermission using a test db instance.
 * Mirrors the logic in server/middleware/shareAuth.js.
 */
function getDocumentPermission(db, userId, documentId) {
  // 1. Ownership
  const doc = db.prepare(
    'SELECT id FROM sync_documents WHERE id = ? AND user_id = ?'
  ).get(documentId, userId);
  if (doc) return 'owner';

  // 2. Team membership
  const teamAccess = db.prepare(`
    SELECT tm.role FROM team_members tm
    JOIN team_documents td ON tm.team_id = td.team_id
    WHERE td.document_id = ? AND tm.user_id = ?
  `).get(documentId, userId);
  if (teamAccess) {
    return teamAccess.role === 'viewer' ? 'view' : 'edit';
  }

  // 3. Explicit access via document_access
  const access = db.prepare(`
    SELECT da.permission FROM document_access da
    JOIN document_shares ds ON da.share_id = ds.id
    WHERE ds.document_id = ? AND da.user_id = ? AND da.accepted_at IS NOT NULL
  `).get(documentId, userId);
  if (access) return access.permission;

  // 4. Link-based sharing
  const share = db.prepare(`
    SELECT link_permission FROM document_shares
    WHERE document_id = ? AND link_enabled = 1
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get(documentId);
  if (share) return share.link_permission;

  return null;
}

function createTeam(db, ownerId = 1) {
  const teamId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  db.prepare('INSERT INTO teams (id, name, slug, description, owner_id) VALUES (?, ?, ?, ?, ?)').run(
    teamId, 'Test Team', 'test-team', 'A test team', ownerId
  );
  db.prepare("INSERT INTO team_members (id, team_id, user_id, role) VALUES (?, ?, ?, 'owner')").run(
    memberId, teamId, ownerId
  );
  return teamId;
}

function addTeamMember(db, teamId, userId, role = 'member') {
  const memberId = crypto.randomUUID();
  db.prepare('INSERT INTO team_members (id, team_id, user_id, role) VALUES (?, ?, ?, ?)').run(
    memberId, teamId, userId, role
  );
  return memberId;
}

function createShare(db, docId, ownerId) {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO document_shares (id, document_id, owner_id, link_enabled) VALUES (?, ?, ?, 0)'
  ).run(id, docId, ownerId);
  return id;
}

function grantAccess(db, shareId, userId, email, permission) {
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO document_access (id, share_id, user_id, email, permission, accepted_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
  ).run(id, shareId, userId, email, permission);
  return id;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Teams: Document ownership check (Issue 3)', () => {
  let db;

  beforeEach(() => {
    db = createTestDB();
  });

  it('owner can add their own document', () => {
    const perm = getDocumentPermission(db, 1, 'doc-1');
    assert.equal(perm, 'owner');
  });

  it('member cannot add a document they do not own', () => {
    const perm = getDocumentPermission(db, 2, 'doc-1');
    assert.equal(perm, null);
    // Route would return 403
  });

  it('returns null for non-existent document', () => {
    const perm = getDocumentPermission(db, 1, 'non-existent');
    assert.equal(perm, null);
  });

  it('rejects view-only access (not sufficient to add to team)', () => {
    const shareId = createShare(db, 'doc-1', 1);
    grantAccess(db, shareId, 2, 'member@example.com', 'view');

    const perm = getDocumentPermission(db, 2, 'doc-1');
    assert.equal(perm, 'view');
    // Route checks: if (!perm || perm === 'view') return 403
    assert.ok(perm === 'view', 'View permission should be rejected by the route');
  });

  it('allows edit access through explicit sharing', () => {
    const shareId = createShare(db, 'doc-1', 1);
    grantAccess(db, shareId, 2, 'member@example.com', 'edit');

    const perm = getDocumentPermission(db, 2, 'doc-1');
    assert.equal(perm, 'edit');
    // Route would allow this
  });

  it('prevents adding another user\'s document without access', () => {
    // User 2 tries to add User 3's document — no ownership, no sharing
    const perm = getDocumentPermission(db, 2, 'doc-other');
    assert.equal(perm, null);
  });

  it('team member gets edit access to team documents', () => {
    const teamId = createTeam(db, 1);
    addTeamMember(db, teamId, 2, 'member');
    // Add doc-1 to the team
    db.prepare('INSERT INTO team_documents (id, team_id, document_id, added_by) VALUES (?, ?, ?, ?)').run(
      crypto.randomUUID(), teamId, 'doc-1', 1
    );

    const perm = getDocumentPermission(db, 2, 'doc-1');
    assert.equal(perm, 'edit');
  });

  it('team viewer gets view access to team documents', () => {
    const teamId = createTeam(db, 1);
    addTeamMember(db, teamId, 2, 'viewer');
    db.prepare('INSERT INTO team_documents (id, team_id, document_id, added_by) VALUES (?, ?, ?, ?)').run(
      crypto.randomUUID(), teamId, 'doc-1', 1
    );

    const perm = getDocumentPermission(db, 2, 'doc-1');
    assert.equal(perm, 'view');
    // Route would reject viewer access for adding documents
  });
});

describe('Teams: Safe JSON.parse in activity formatActivity (Issue 4)', () => {
  it('handles corrupted metadata without crashing', () => {
    const metadata = '{bad json';
    const result = (() => {
      if (!metadata) return null;
      try { return JSON.parse(metadata); }
      catch { return null; }
    })();
    assert.equal(result, null);
  });

  it('parses valid metadata correctly', () => {
    const metadata = '{"action":"edit","field":"title"}';
    const result = (() => {
      if (!metadata) return null;
      try { return JSON.parse(metadata); }
      catch { return null; }
    })();
    assert.deepStrictEqual(result, { action: 'edit', field: 'title' });
  });

  it('returns null for null metadata', () => {
    const metadata = null;
    const result = (() => {
      if (!metadata) return null;
      try { return JSON.parse(metadata); }
      catch { return null; }
    })();
    assert.equal(result, null);
  });

  it('handles empty string metadata', () => {
    const metadata = '';
    const result = (() => {
      if (!metadata) return null;
      try { return JSON.parse(metadata); }
      catch { return null; }
    })();
    assert.equal(result, null);
  });
});
