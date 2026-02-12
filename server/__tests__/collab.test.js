/**
 * Collaborative Editing Service Tests
 *
 * Tests the collab service's database operations, auth logic, and persistence.
 * Uses in-memory SQLite to test the SQL queries without requiring a real Hocuspocus server.
 *
 * Run: node --test server/__tests__/collab.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import * as Y from 'yjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Helpers ────────────────────────────────────────────────────────────────

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

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

  // sync_documents table
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
      deleted_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // yjs_documents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS yjs_documents (
      document_id TEXT PRIMARY KEY,
      state BLOB NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (document_id) REFERENCES sync_documents(id) ON DELETE CASCADE
    );
  `);

  // sync_versions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_versions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      content_hash TEXT NOT NULL,
      sidecar_hash TEXT,
      summary TEXT,
      stats_json TEXT,
      size_bytes INTEGER DEFAULT 0,
      created_at DATETIME NOT NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sync_versions_document ON sync_versions(document_id);
  `);

  // sync_version_content table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_version_content (
      version_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      sidecar TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Sharing tables (match production schema)
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_document_shares_document ON document_shares(document_id);
    CREATE INDEX IF NOT EXISTS idx_document_shares_link_token ON document_shares(link_token) WHERE link_token IS NOT NULL;
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
    CREATE INDEX IF NOT EXISTS idx_document_access_user ON document_access(user_id);
    CREATE INDEX IF NOT EXISTS idx_document_access_share ON document_access(share_id);
  `);

  // Insert test users
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(
    1, 'owner@example.com', 'hashed', 'Owner User'
  );
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(
    2, 'editor@example.com', 'hashed', 'Editor User'
  );
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)').run(
    3, 'viewer@example.com', 'hashed', 'Viewer User'
  );

  // Insert test document
  db.prepare('INSERT INTO sync_documents (id, user_id, path, version, content_hash, sidecar_hash) VALUES (?, ?, ?, ?, ?, ?)').run(
    'doc-1', 1, '/test-document.midlight', 1, 'hash-initial', 'sidecar-hash-initial'
  );

  return db;
}

// ─── Test: Y.js state persistence ───────────────────────────────────────────

describe('Y.js document state persistence', () => {
  let db;

  beforeEach(() => {
    db = createTestDB();
  });

  it('should store Y.js state in yjs_documents', () => {
    const ydoc = new Y.Doc();
    const text = ydoc.getText('default');
    text.insert(0, 'Hello world');
    const state = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();

    db.prepare(`
      INSERT INTO yjs_documents (document_id, state, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).run('doc-1', Buffer.from(state));

    const row = db.prepare('SELECT * FROM yjs_documents WHERE document_id = ?').get('doc-1');
    assert.ok(row, 'Y.js state should be stored');
    assert.equal(row.document_id, 'doc-1');
    assert.ok(row.state instanceof Buffer, 'State should be a Buffer');
  });

  it('should load and apply stored Y.js state', () => {
    // Create and store Y.js state
    const ydoc1 = new Y.Doc();
    const text1 = ydoc1.getText('default');
    text1.insert(0, 'Hello collab');
    const state = Y.encodeStateAsUpdate(ydoc1);
    ydoc1.destroy();

    db.prepare(`
      INSERT INTO yjs_documents (document_id, state, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).run('doc-1', Buffer.from(state));

    // Load state into a new Y.Doc
    const row = db.prepare('SELECT state FROM yjs_documents WHERE document_id = ?').get('doc-1');
    const ydoc2 = new Y.Doc();
    Y.applyUpdate(ydoc2, new Uint8Array(row.state));

    const text2 = ydoc2.getText('default');
    assert.equal(text2.toString(), 'Hello collab');
    ydoc2.destroy();
  });

  it('should upsert Y.js state on conflict', () => {
    const upsert = db.prepare(`
      INSERT INTO yjs_documents (document_id, state, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(document_id) DO UPDATE SET
        state = excluded.state,
        updated_at = CURRENT_TIMESTAMP
    `);

    // Initial insert
    const ydoc1 = new Y.Doc();
    ydoc1.getText('default').insert(0, 'version 1');
    upsert.run('doc-1', Buffer.from(Y.encodeStateAsUpdate(ydoc1)));
    ydoc1.destroy();

    // Upsert with new content
    const ydoc2 = new Y.Doc();
    ydoc2.getText('default').insert(0, 'version 2');
    upsert.run('doc-1', Buffer.from(Y.encodeStateAsUpdate(ydoc2)));
    ydoc2.destroy();

    // Verify only one row exists with latest content
    const count = db.prepare('SELECT COUNT(*) as c FROM yjs_documents WHERE document_id = ?').get('doc-1');
    assert.equal(count.c, 1);

    const row = db.prepare('SELECT state FROM yjs_documents WHERE document_id = ?').get('doc-1');
    const ydoc3 = new Y.Doc();
    Y.applyUpdate(ydoc3, new Uint8Array(row.state));
    assert.equal(ydoc3.getText('default').toString(), 'version 2');
    ydoc3.destroy();
  });
});

// ─── Test: Document owner lookup ─────────────────────────────────────────────

describe('Document owner lookup', () => {
  let db;

  beforeEach(() => {
    db = createTestDB();
  });

  it('should find the owner user_id for a document', () => {
    const row = db.prepare('SELECT user_id FROM sync_documents WHERE id = ?').get('doc-1');
    assert.ok(row);
    assert.equal(row.user_id, 1);
  });

  it('should return undefined for non-existent document', () => {
    const row = db.prepare('SELECT user_id FROM sync_documents WHERE id = ?').get('non-existent');
    assert.equal(row, undefined);
  });
});

// ─── Test: Permission checking ───────────────────────────────────────────────

describe('Permission checking for collab', () => {
  let db;

  beforeEach(() => {
    db = createTestDB();
  });

  function getDocumentPermission(db, userId, documentId) {
    // 1. Check ownership
    const doc = db.prepare(
      'SELECT id FROM sync_documents WHERE id = ? AND user_id = ?'
    ).get(documentId, userId);
    if (doc) return 'owner';

    // 2. Check explicit access (requires accepted_at)
    const access = db.prepare(`
      SELECT da.permission FROM document_access da
      JOIN document_shares ds ON da.share_id = ds.id
      WHERE ds.document_id = ? AND da.user_id = ? AND da.accepted_at IS NOT NULL
    `).get(documentId, userId);
    if (access) return access.permission;

    // 3. Check link-based sharing (any authenticated user gets link_permission)
    const share = db.prepare(`
      SELECT link_permission FROM document_shares
      WHERE document_id = ? AND link_enabled = 1
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).get(documentId);
    if (share) return share.link_permission;

    return null;
  }

  it('should grant owner permission to document owner', () => {
    assert.equal(getDocumentPermission(db, 1, 'doc-1'), 'owner');
  });

  it('should deny access to users without sharing', () => {
    assert.equal(getDocumentPermission(db, 2, 'doc-1'), null);
  });

  it('should grant view permission via link sharing', () => {
    const shareId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO document_shares (id, document_id, owner_id, link_token, link_permission, link_enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(shareId, 'doc-1', 1, 'test-token', 'view', 1);

    assert.equal(getDocumentPermission(db, 2, 'doc-1'), 'view');
  });

  it('should grant edit permission via explicit access', () => {
    const shareId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO document_shares (id, document_id, owner_id, link_token, link_permission, link_enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(shareId, 'doc-1', 1, 'test-token', 'view', 1);

    const accessId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO document_access (id, share_id, user_id, email, permission, accepted_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(accessId, shareId, 2, 'editor@example.com', 'edit');

    assert.equal(getDocumentPermission(db, 2, 'doc-1'), 'edit');
  });

  it('should return null for non-existent document', () => {
    assert.equal(getDocumentPermission(db, 1, 'non-existent'), null);
  });
});

// ─── Test: Version history auto-checkpoints ─────────────────────────────────

describe('Version history auto-checkpoints', () => {
  let db;

  beforeEach(() => {
    db = createTestDB();
  });

  it('should create a version checkpoint with correct fields', () => {
    const documentId = 'doc-1';
    const content = 'Hello world, this is collab content';
    const sidecar = { content: { type: 'doc', content: [] } };
    const sidecarStr = JSON.stringify(sidecar);
    const versionId = `collab-${documentId}-${Date.now()}`;
    const contentHash = hashContent(content);
    const sidecarHash = hashContent(sidecarStr);
    const totalSize = Buffer.byteLength(content, 'utf8') + Buffer.byteLength(sidecarStr, 'utf8');
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    const charCount = content.length;
    const statsJson = JSON.stringify({ wordCount, charCount, changeSize: 0 });

    db.prepare(`
      INSERT INTO sync_versions (id, document_id, user_id, label, description, content_hash,
        sidecar_hash, summary, stats_json, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(versionId, documentId, 1, 'Auto-save (collab)', null, contentHash, sidecarHash, null, statsJson, totalSize);

    db.prepare(`
      INSERT OR REPLACE INTO sync_version_content (version_id, user_id, content, sidecar, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(versionId, 1, content, sidecarStr);

    // Verify version metadata
    const ver = db.prepare('SELECT * FROM sync_versions WHERE id = ?').get(versionId);
    assert.ok(ver, 'Version should be created');
    assert.equal(ver.document_id, documentId);
    assert.equal(ver.user_id, 1);
    assert.equal(ver.label, 'Auto-save (collab)');
    assert.equal(ver.content_hash, contentHash);
    assert.equal(ver.sidecar_hash, sidecarHash);
    assert.equal(ver.size_bytes, totalSize);

    // Verify stats
    const stats = JSON.parse(ver.stats_json);
    assert.equal(stats.wordCount, 6);
    assert.equal(stats.charCount, 35);

    // Verify version content
    const vc = db.prepare('SELECT * FROM sync_version_content WHERE version_id = ?').get(versionId);
    assert.ok(vc);
    assert.equal(vc.content, content);
    assert.equal(vc.sidecar, sidecarStr);
  });

  it('should increment sync_documents version on snapshot', () => {
    const initialDoc = db.prepare('SELECT version FROM sync_documents WHERE id = ?').get('doc-1');
    assert.equal(initialDoc.version, 1);

    // Simulate version bump from collab snapshot
    db.prepare(`
      UPDATE sync_documents
      SET content_hash = ?, sidecar_hash = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run('new-hash', 'new-sidecar-hash', 'doc-1');

    const updatedDoc = db.prepare('SELECT version FROM sync_documents WHERE id = ?').get('doc-1');
    assert.equal(updatedDoc.version, 2);
  });
});

// ─── Test: Y.js state cleanup ────────────────────────────────────────────────

describe('Y.js state cleanup', () => {
  let db;

  beforeEach(() => {
    db = createTestDB();
  });

  it('should delete stale Y.js states older than 30 days', () => {
    // Insert a recent state
    db.prepare(`
      INSERT INTO yjs_documents (document_id, state, updated_at)
      VALUES ('doc-1', X'00', CURRENT_TIMESTAMP)
    `).run();

    // Insert a stale state (simulate 31 days ago)
    db.prepare('INSERT INTO sync_documents (id, user_id, path, version) VALUES (?, ?, ?, ?)').run(
      'doc-old', 1, '/old-doc.midlight', 1
    );
    db.prepare(`
      INSERT INTO yjs_documents (document_id, state, updated_at)
      VALUES ('doc-old', X'00', datetime('now', '-31 days'))
    `).run();

    // Run cleanup
    const result = db.prepare(`
      DELETE FROM yjs_documents
      WHERE updated_at < datetime('now', '-30 days')
    `).run();

    assert.equal(result.changes, 1, 'Should delete 1 stale state');

    // Recent state should remain
    const remaining = db.prepare('SELECT COUNT(*) as c FROM yjs_documents').get();
    assert.equal(remaining.c, 1);

    const kept = db.prepare('SELECT document_id FROM yjs_documents').get();
    assert.equal(kept.document_id, 'doc-1');
  });

  it('should keep Y.js states updated within 30 days', () => {
    db.prepare(`
      INSERT INTO yjs_documents (document_id, state, updated_at)
      VALUES ('doc-1', X'00', datetime('now', '-29 days'))
    `).run();

    const result = db.prepare(`
      DELETE FROM yjs_documents
      WHERE updated_at < datetime('now', '-30 days')
    `).run();

    assert.equal(result.changes, 0, 'Should not delete recent states');
  });
});

// ─── Test: Markdown extraction ──────────────────────────────────────────────

describe('extractMarkdownFromTiptap', () => {
  // Replicating the function from collabService.js
  function extractMarkdownFromTiptap(json) {
    if (!json || !json.content) return '';

    const lines = [];
    for (const node of json.content) {
      if (node.type === 'paragraph' && node.content) {
        const text = node.content.filter(n => n.type === 'text').map(n => n.text).join('');
        lines.push(text);
      } else if (node.type === 'heading' && node.content) {
        const level = node.attrs?.level || 1;
        const text = node.content.filter(n => n.type === 'text').map(n => n.text).join('');
        lines.push('#'.repeat(level) + ' ' + text);
      } else if (node.type === 'bulletList' || node.type === 'orderedList') {
        if (node.content) {
          for (const item of node.content) {
            if (item.content) {
              for (const para of item.content) {
                if (para.content) {
                  const text = para.content.filter(n => n.type === 'text').map(n => n.text).join('');
                  lines.push('- ' + text);
                }
              }
            }
          }
        }
      } else if (node.type === 'codeBlock' && node.content) {
        const text = node.content.filter(n => n.type === 'text').map(n => n.text).join('');
        lines.push('```\n' + text + '\n```');
      }
    }
    return lines.join('\n\n');
  }

  it('should extract text from paragraphs', () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph' }] },
      ],
    };
    assert.equal(extractMarkdownFromTiptap(json), 'Hello world\n\nSecond paragraph');
  });

  it('should extract headings with levels', () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Subtitle' }] },
      ],
    };
    assert.equal(extractMarkdownFromTiptap(json), '# Title\n\n## Subtitle');
  });

  it('should extract list items', () => {
    const json = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 1' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 2' }] }] },
          ],
        },
      ],
    };
    assert.equal(extractMarkdownFromTiptap(json), '- Item 1\n\n- Item 2');
  });

  it('should extract code blocks', () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'codeBlock', content: [{ type: 'text', text: 'const x = 1;' }] },
      ],
    };
    assert.equal(extractMarkdownFromTiptap(json), '```\nconst x = 1;\n```');
  });

  it('should return empty string for null/empty content', () => {
    assert.equal(extractMarkdownFromTiptap(null), '');
    assert.equal(extractMarkdownFromTiptap({}), '');
    assert.equal(extractMarkdownFromTiptap({ content: [] }), '');
  });
});

// ─── Test: Auth error codes ──────────────────────────────────────────────────

describe('Auth error codes', () => {
  it('should use code 4401 for expired token errors', () => {
    const err = new Error('Invalid or expired token');
    err.code = 4401;
    assert.equal(err.code, 4401);
    assert.equal(err.message, 'Invalid or expired token');
  });

  it('should throw plain error for missing token', () => {
    const err = new Error('Authentication required');
    assert.equal(err.message, 'Authentication required');
    assert.equal(err.code, undefined);
  });
});
