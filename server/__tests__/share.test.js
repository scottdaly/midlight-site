/**
 * Share Route Tests
 *
 * Uses Node built-in test runner with in-memory SQLite.
 * Run: node --test server/__tests__/share.test.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTestDB() {
  const db = new Database(':memory:');

  // Users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      display_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // sync_documents table (minimal columns needed for share tests)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_documents (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT,
      sidecar_hash TEXT,
      size_bytes INTEGER DEFAULT 0,
      version INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Load sharing tables from schema
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const fullSchema = fs.readFileSync(schemaPath, 'utf-8');

  // Extract sharing table definitions
  const sharingSchema = fullSchema
    .split('\n')
    .reduce((acc, line) => {
      if (line.match(/CREATE TABLE IF NOT EXISTS document_shares|CREATE TABLE IF NOT EXISTS document_access|CREATE .*INDEX IF NOT EXISTS idx_document_shares_|CREATE .*INDEX IF NOT EXISTS idx_document_access_/)) {
        acc.inShare = true;
      }
      if (acc.inShare) {
        acc.lines.push(line);
        if (line.trim() === ');' || (line.includes('CREATE') && line.includes('INDEX') && line.includes(';'))) {
          acc.inShare = false;
        }
      }
      return acc;
    }, { inShare: false, lines: [] })
    .lines.join('\n');

  db.exec(sharingSchema);

  // Insert test users
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(
    1, 'owner@example.com', 'hashed', 'Owner User'
  );
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(
    2, 'viewer@example.com', 'hashed', 'Viewer User'
  );
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(
    3, 'other@example.com', 'hashed', 'Other User'
  );

  // Insert test document owned by user 1
  db.prepare('INSERT INTO sync_documents (id, user_id, path, version) VALUES (?, ?, ?, ?)').run(
    'doc-1', 1, '/test-document.midlight', 1
  );

  return db;
}

// ─── Business logic extracted from routes for testing ───────────────────────

function createShare(db, docId, ownerId, options = {}) {
  const { linkPermission = 'view', linkEnabled = true, allowCopy = true, expiresAt = null } = options;
  const id = crypto.randomUUID();
  const linkToken = linkEnabled ? crypto.randomBytes(16).toString('base64url') : null;

  db.prepare(`
    INSERT INTO document_shares (id, document_id, owner_id, link_token, link_permission, link_enabled, allow_copy, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, docId, ownerId, linkToken, linkPermission, linkEnabled ? 1 : 0, allowCopy ? 1 : 0, expiresAt);

  return db.prepare('SELECT * FROM document_shares WHERE id = ?').get(id);
}

function updateShare(db, docId, updates) {
  const share = db.prepare('SELECT * FROM document_shares WHERE document_id = ?').get(docId);
  if (!share) return null;

  const setClauses = [];
  const params = [];

  if (updates.linkPermission !== undefined) {
    setClauses.push('link_permission = ?');
    params.push(updates.linkPermission);
  }
  if (updates.linkEnabled !== undefined) {
    setClauses.push('link_enabled = ?');
    params.push(updates.linkEnabled ? 1 : 0);
    if (updates.linkEnabled && !share.link_token) {
      const token = crypto.randomBytes(16).toString('base64url');
      setClauses.push('link_token = ?');
      params.push(token);
    }
  }
  if (updates.allowCopy !== undefined) {
    setClauses.push('allow_copy = ?');
    params.push(updates.allowCopy ? 1 : 0);
  }
  if (updates.expiresAt !== undefined) {
    setClauses.push('expires_at = ?');
    params.push(updates.expiresAt);
  }

  if (setClauses.length > 0) {
    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    params.push(docId);
    db.prepare(`UPDATE document_shares SET ${setClauses.join(', ')} WHERE document_id = ?`).run(...params);
  }

  return db.prepare('SELECT * FROM document_shares WHERE document_id = ?').get(docId);
}

function getShareSettings(db, docId) {
  const share = db.prepare('SELECT * FROM document_shares WHERE document_id = ?').get(docId);
  if (!share) return { exists: false, accessList: [] };

  const accessList = db.prepare(
    'SELECT * FROM document_access WHERE share_id = ? ORDER BY created_at DESC'
  ).all(share.id);

  return {
    exists: true,
    id: share.id,
    documentId: share.document_id,
    linkToken: share.link_token,
    linkPermission: share.link_permission,
    linkEnabled: !!share.link_enabled,
    allowCopy: !!share.allow_copy,
    expiresAt: share.expires_at,
    accessList: accessList.map(a => ({
      id: a.id,
      email: a.email,
      permission: a.permission,
      userId: a.user_id,
      acceptedAt: a.accepted_at,
    })),
  };
}

function resolveLink(db, token) {
  const share = db.prepare(`
    SELECT ds.*, sd.path AS document_path, sd.updated_at AS document_updated_at,
      u.display_name AS owner_name
    FROM document_shares ds
    JOIN sync_documents sd ON ds.document_id = sd.id
    JOIN users u ON ds.owner_id = u.id
    WHERE ds.link_token = ? AND ds.link_enabled = 1
  `).get(token);

  if (!share) return { status: 404 };

  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return { status: 410 };
  }

  return {
    status: 200,
    data: {
      documentId: share.document_id,
      documentPath: share.document_path,
      ownerName: share.owner_name,
      permission: share.link_permission,
      allowCopy: !!share.allow_copy,
    },
  };
}

function inviteUser(db, shareId, email, permission, inviteeId = null) {
  const existing = db.prepare(
    'SELECT id FROM document_access WHERE share_id = ? AND email = ?'
  ).get(shareId, email);
  if (existing) return { status: 409 };

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO document_access (id, share_id, user_id, email, permission, accepted_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, shareId, inviteeId, email, permission, inviteeId ? new Date().toISOString() : null);

  return {
    status: 200,
    data: {
      id,
      email,
      permission,
      userId: inviteeId,
    },
  };
}

function removeAccess(db, docId, accessId) {
  const share = db.prepare('SELECT id FROM document_shares WHERE document_id = ?').get(docId);
  if (!share) return { status: 404 };

  const result = db.prepare('DELETE FROM document_access WHERE id = ? AND share_id = ?').run(accessId, share.id);
  return result.changes > 0 ? { status: 200 } : { status: 404 };
}

function updateAccessPermission(db, docId, accessId, permission) {
  const share = db.prepare('SELECT id FROM document_shares WHERE document_id = ?').get(docId);
  if (!share) return { status: 404 };

  const result = db.prepare(
    'UPDATE document_access SET permission = ? WHERE id = ? AND share_id = ?'
  ).run(permission, accessId, share.id);
  return result.changes > 0 ? { status: 200 } : { status: 404 };
}

function deleteShare(db, docId) {
  const result = db.prepare('DELETE FROM document_shares WHERE document_id = ?').run(docId);
  return result.changes > 0 ? { status: 200 } : { status: 404 };
}

function getSharedWithMe(db, userId) {
  return db.prepare(`
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
  `).all(userId);
}

function acceptPendingInvitations(db, userId, email) {
  const pending = db.prepare(
    'SELECT id FROM document_access WHERE email = ? AND user_id IS NULL'
  ).all(email);
  if (pending.length > 0) {
    db.prepare(
      'UPDATE document_access SET user_id = ?, accepted_at = CURRENT_TIMESTAMP WHERE email = ? AND user_id IS NULL'
    ).run(userId, email);
  }
  return pending.length;
}

function getDocumentPermission(db, userId, documentId) {
  const doc = db.prepare(
    'SELECT id FROM sync_documents WHERE id = ? AND user_id = ?'
  ).get(documentId, userId);
  if (doc) return 'owner';

  const access = db.prepare(`
    SELECT da.permission FROM document_access da
    JOIN document_shares ds ON da.share_id = ds.id
    WHERE ds.document_id = ? AND da.user_id = ? AND da.accepted_at IS NOT NULL
  `).get(documentId, userId);
  if (access) return access.permission;

  return null;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Share: Create share', () => {
  let db;
  beforeEach(() => { db = createTestDB(); });

  it('creates share record with link token', () => {
    const share = createShare(db, 'doc-1', 1);
    assert.ok(share);
    assert.equal(share.document_id, 'doc-1');
    assert.equal(share.owner_id, 1);
    assert.ok(share.link_token);
    assert.equal(share.link_token.length, 22); // base64url of 16 bytes
    assert.equal(share.link_enabled, 1);
    assert.equal(share.link_permission, 'view');
    assert.equal(share.allow_copy, 1);
  });

  it('creates share without link when disabled', () => {
    const share = createShare(db, 'doc-1', 1, { linkEnabled: false });
    assert.ok(share);
    assert.equal(share.link_token, null);
    assert.equal(share.link_enabled, 0);
  });

  it('creates share with edit permission', () => {
    const share = createShare(db, 'doc-1', 1, { linkPermission: 'edit' });
    assert.equal(share.link_permission, 'edit');
  });
});

describe('Share: Toggle link on/off', () => {
  let db;
  beforeEach(() => { db = createTestDB(); });

  it('disabling link preserves token', () => {
    const share = createShare(db, 'doc-1', 1);
    const originalToken = share.link_token;

    const updated = updateShare(db, 'doc-1', { linkEnabled: false });
    assert.equal(updated.link_enabled, 0);
    assert.equal(updated.link_token, originalToken); // token preserved
  });

  it('re-enabling link keeps same token', () => {
    const share = createShare(db, 'doc-1', 1);
    const originalToken = share.link_token;

    updateShare(db, 'doc-1', { linkEnabled: false });
    const reEnabled = updateShare(db, 'doc-1', { linkEnabled: true });
    assert.equal(reEnabled.link_enabled, 1);
    assert.equal(reEnabled.link_token, originalToken); // same token
  });

  it('generates token on first enable when none exists', () => {
    createShare(db, 'doc-1', 1, { linkEnabled: false });
    const updated = updateShare(db, 'doc-1', { linkEnabled: true });
    assert.ok(updated.link_token);
    assert.equal(updated.link_enabled, 1);
  });
});

describe('Share: Get share settings', () => {
  let db;
  beforeEach(() => { db = createTestDB(); });

  it('returns exists:false when no share exists', () => {
    const settings = getShareSettings(db, 'doc-1');
    assert.equal(settings.exists, false);
    assert.deepEqual(settings.accessList, []);
  });

  it('returns settings with access list', () => {
    const share = createShare(db, 'doc-1', 1);
    inviteUser(db, share.id, 'viewer@example.com', 'view', 2);

    const settings = getShareSettings(db, 'doc-1');
    assert.equal(settings.exists, true);
    assert.ok(settings.linkToken);
    assert.equal(settings.linkEnabled, true);
    assert.equal(settings.accessList.length, 1);
    assert.equal(settings.accessList[0].email, 'viewer@example.com');
    assert.equal(settings.accessList[0].permission, 'view');
    assert.equal(settings.accessList[0].userId, 2);
  });
});

describe('Share: Invite user', () => {
  let db, share;
  beforeEach(() => {
    db = createTestDB();
    share = createShare(db, 'doc-1', 1);
  });

  it('creates access entry for new user', () => {
    const result = inviteUser(db, share.id, 'newuser@example.com', 'view');
    assert.equal(result.status, 200);
    assert.equal(result.data.email, 'newuser@example.com');
    assert.equal(result.data.permission, 'view');
    assert.equal(result.data.userId, null); // user doesn't exist
  });

  it('auto-accepts for existing user', () => {
    const result = inviteUser(db, share.id, 'viewer@example.com', 'edit', 2);
    assert.equal(result.status, 200);
    assert.equal(result.data.userId, 2);

    // Check accepted_at is set
    const access = db.prepare('SELECT * FROM document_access WHERE id = ?').get(result.data.id);
    assert.ok(access.accepted_at);
  });

  it('rejects duplicate invitation', () => {
    inviteUser(db, share.id, 'viewer@example.com', 'view', 2);
    const result = inviteUser(db, share.id, 'viewer@example.com', 'edit', 2);
    assert.equal(result.status, 409);
  });
});

describe('Share: Remove access', () => {
  let db, share, accessResult;
  beforeEach(() => {
    db = createTestDB();
    share = createShare(db, 'doc-1', 1);
    accessResult = inviteUser(db, share.id, 'viewer@example.com', 'view', 2);
  });

  it('removes access entry', () => {
    const result = removeAccess(db, 'doc-1', accessResult.data.id);
    assert.equal(result.status, 200);

    // Verify removal
    const settings = getShareSettings(db, 'doc-1');
    assert.equal(settings.accessList.length, 0);
  });

  it('returns 404 for non-existent access', () => {
    const result = removeAccess(db, 'doc-1', 'non-existent-id');
    assert.equal(result.status, 404);
  });
});

describe('Share: Update permission', () => {
  let db, share, accessResult;
  beforeEach(() => {
    db = createTestDB();
    share = createShare(db, 'doc-1', 1);
    accessResult = inviteUser(db, share.id, 'viewer@example.com', 'view', 2);
  });

  it('updates access permission', () => {
    const result = updateAccessPermission(db, 'doc-1', accessResult.data.id, 'edit');
    assert.equal(result.status, 200);

    const settings = getShareSettings(db, 'doc-1');
    assert.equal(settings.accessList[0].permission, 'edit');
  });

  it('returns 404 for non-existent access', () => {
    const result = updateAccessPermission(db, 'doc-1', 'non-existent', 'edit');
    assert.equal(result.status, 404);
  });
});

describe('Share: Delete share', () => {
  let db;
  beforeEach(() => { db = createTestDB(); });

  it('deletes share and cascades to access entries', () => {
    const share = createShare(db, 'doc-1', 1);
    inviteUser(db, share.id, 'viewer@example.com', 'view', 2);

    const result = deleteShare(db, 'doc-1');
    assert.equal(result.status, 200);

    // Share gone
    const settings = getShareSettings(db, 'doc-1');
    assert.equal(settings.exists, false);

    // Access entries cascaded
    const accessCount = db.prepare('SELECT COUNT(*) AS c FROM document_access WHERE share_id = ?').get(share.id);
    assert.equal(accessCount.c, 0);
  });

  it('returns 404 when no share exists', () => {
    const result = deleteShare(db, 'doc-1');
    assert.equal(result.status, 404);
  });
});

describe('Share: Resolve link token', () => {
  let db;
  beforeEach(() => { db = createTestDB(); });

  it('resolves valid link to metadata', () => {
    const share = createShare(db, 'doc-1', 1);
    const result = resolveLink(db, share.link_token);

    assert.equal(result.status, 200);
    assert.equal(result.data.documentId, 'doc-1');
    assert.equal(result.data.permission, 'view');
    assert.equal(result.data.ownerName, 'Owner User');
    assert.equal(result.data.allowCopy, true);
  });

  it('returns 404 for invalid token', () => {
    const result = resolveLink(db, 'nonexistent-token');
    assert.equal(result.status, 404);
  });

  it('returns 404 for disabled link', () => {
    const share = createShare(db, 'doc-1', 1);
    updateShare(db, 'doc-1', { linkEnabled: false });

    const result = resolveLink(db, share.link_token);
    assert.equal(result.status, 404);
  });
});

describe('Share: Expired link', () => {
  let db;
  beforeEach(() => { db = createTestDB(); });

  it('returns 410 for expired link', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString(); // yesterday
    const share = createShare(db, 'doc-1', 1, { expiresAt: pastDate });

    const result = resolveLink(db, share.link_token);
    assert.equal(result.status, 410);
  });

  it('resolves non-expired link normally', () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString(); // tomorrow
    const share = createShare(db, 'doc-1', 1, { expiresAt: futureDate });

    const result = resolveLink(db, share.link_token);
    assert.equal(result.status, 200);
  });
});

describe('Share: Accept-on-login', () => {
  let db;
  beforeEach(() => { db = createTestDB(); });

  it('links pending invitations to user on login', () => {
    const share = createShare(db, 'doc-1', 1);

    // Invite by email (user doesn't exist yet, so no userId)
    inviteUser(db, share.id, 'newuser@example.com', 'edit');

    // Verify pending (no user_id, no accepted_at)
    const pending = db.prepare('SELECT * FROM document_access WHERE email = ?').get('newuser@example.com');
    assert.equal(pending.user_id, null);
    assert.equal(pending.accepted_at, null);

    // Simulate user signing up with that email (gets userId 10)
    db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(10, 'newuser@example.com', 'hashed');
    const accepted = acceptPendingInvitations(db, 10, 'newuser@example.com');

    assert.equal(accepted, 1);

    // Verify linked
    const linked = db.prepare('SELECT * FROM document_access WHERE email = ?').get('newuser@example.com');
    assert.equal(linked.user_id, 10);
    assert.ok(linked.accepted_at);
  });

  it('handles no pending invitations gracefully', () => {
    const accepted = acceptPendingInvitations(db, 2, 'viewer@example.com');
    assert.equal(accepted, 0);
  });
});

describe('Share: Shared-with-me list', () => {
  let db;
  beforeEach(() => { db = createTestDB(); });

  it('returns shared documents for a user', () => {
    const share = createShare(db, 'doc-1', 1);
    inviteUser(db, share.id, 'viewer@example.com', 'edit', 2);

    const docs = getSharedWithMe(db, 2);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].document_id, 'doc-1');
    assert.equal(docs[0].permission, 'edit');
    assert.equal(docs[0].owner_name, 'Owner User');
    assert.equal(docs[0].owner_email, 'owner@example.com');
    assert.ok(docs[0].link_token);
  });

  it('returns empty for user with no shared docs', () => {
    const docs = getSharedWithMe(db, 3);
    assert.equal(docs.length, 0);
  });
});

describe('Share: Permission resolution', () => {
  let db;
  beforeEach(() => { db = createTestDB(); });

  it('returns owner for document owner', () => {
    const perm = getDocumentPermission(db, 1, 'doc-1');
    assert.equal(perm, 'owner');
  });

  it('returns view for user with view access', () => {
    const share = createShare(db, 'doc-1', 1);
    inviteUser(db, share.id, 'viewer@example.com', 'view', 2);

    const perm = getDocumentPermission(db, 2, 'doc-1');
    assert.equal(perm, 'view');
  });

  it('returns edit for user with edit access', () => {
    const share = createShare(db, 'doc-1', 1);
    inviteUser(db, share.id, 'viewer@example.com', 'edit', 2);

    const perm = getDocumentPermission(db, 2, 'doc-1');
    assert.equal(perm, 'edit');
  });

  it('returns null for user without access', () => {
    const perm = getDocumentPermission(db, 3, 'doc-1');
    assert.equal(perm, null);
  });

  it('returns null for non-existent document', () => {
    const perm = getDocumentPermission(db, 1, 'non-existent');
    assert.equal(perm, null);
  });
});

describe('Share: Non-owner cannot manage', () => {
  let db;
  beforeEach(() => { db = createTestDB(); });

  it('requireOwner check fails for non-owner', () => {
    // User 2 does not own doc-1
    const doc = db.prepare(
      'SELECT id, user_id FROM sync_documents WHERE id = ? AND user_id = ?'
    ).get('doc-1', 2);
    assert.equal(doc, undefined);
  });

  it('requireOwner check passes for owner', () => {
    const doc = db.prepare(
      'SELECT id, user_id FROM sync_documents WHERE id = ? AND user_id = ?'
    ).get('doc-1', 1);
    assert.ok(doc);
    assert.equal(doc.user_id, 1);
  });
});

describe('Share: Unique constraint enforcement', () => {
  let db;
  beforeEach(() => { db = createTestDB(); });

  it('only one share per document (unique index)', () => {
    createShare(db, 'doc-1', 1);
    assert.throws(() => {
      createShare(db, 'doc-1', 1);
    });
  });

  it('unique email per share (unique constraint)', () => {
    const share = createShare(db, 'doc-1', 1);
    inviteUser(db, share.id, 'test@example.com', 'view');

    // Direct insert should fail on unique constraint
    assert.throws(() => {
      const id2 = crypto.randomUUID();
      db.prepare(
        'INSERT INTO document_access (id, share_id, email, permission) VALUES (?, ?, ?, ?)'
      ).run(id2, share.id, 'test@example.com', 'edit');
    });
  });
});
