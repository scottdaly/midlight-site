/**
 * Backend Sync Route Tests
 *
 * Uses Node built-in test runner with in-memory SQLite and mocked R2 storage.
 * Run: node --test server/__tests__/sync.test.js
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

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function createTestDB() {
  const db = new Database(':memory:');
  // Load only the sync-related tables from schema
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const fullSchema = fs.readFileSync(schemaPath, 'utf-8');

  // We need users table for foreign keys + sync tables
  // Extract relevant CREATE TABLE statements
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      display_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      stripe_customer_id TEXT
    );
  `);

  // Extract and run sync-related schema
  const syncSchema = fullSchema
    .split('\n')
    .reduce((acc, line) => {
      // Track when we're inside a sync table definition
      if (line.match(/CREATE TABLE IF NOT EXISTS sync_|CREATE INDEX IF NOT EXISTS idx_sync_/)) {
        acc.inSync = true;
      }
      if (acc.inSync) {
        acc.lines.push(line);
        if (line.trim() === ');' || (line.includes('CREATE INDEX') && line.includes(';'))) {
          acc.inSync = false;
        }
      }
      return acc;
    }, { inSync: false, lines: [] })
    .lines.join('\n');

  db.exec(syncSchema);

  // Insert test user
  db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(
    1,
    'test@example.com',
    'hashed_password'
  );

  return db;
}

function createMockStorage() {
  const store = new Map();

  return {
    uploadDocument: mock.fn(async (userId, docId, content, sidecar) => {
      const contentKey = `users/${userId}/documents/${docId}/content.md`;
      const sidecarKey = `users/${userId}/documents/${docId}/sidecar.json`;
      store.set(contentKey, content);
      store.set(sidecarKey, JSON.stringify(sidecar));
      return {
        contentKey,
        sidecarKey,
        contentHash: hashContent(content),
        sidecarHash: hashContent(JSON.stringify(sidecar)),
        sizeBytes: Buffer.byteLength(content) + Buffer.byteLength(JSON.stringify(sidecar)),
      };
    }),

    downloadDocument: mock.fn(async (userId, docId) => {
      const contentKey = `users/${userId}/documents/${docId}/content.md`;
      const sidecarKey = `users/${userId}/documents/${docId}/sidecar.json`;
      const content = store.get(contentKey);
      const sidecarJson = store.get(sidecarKey);
      if (!content) return null;
      return {
        content,
        sidecar: JSON.parse(sidecarJson),
        contentHash: hashContent(content),
        sidecarHash: hashContent(sidecarJson),
      };
    }),

    deleteDocument: mock.fn(async (userId, docId) => {
      store.delete(`users/${userId}/documents/${docId}/content.md`);
      store.delete(`users/${userId}/documents/${docId}/sidecar.json`);
    }),

    deleteDocumentObjects: mock.fn(async (userId, docId) => {
      store.delete(`users/${userId}/documents/${docId}/content.md`);
      store.delete(`users/${userId}/documents/${docId}/sidecar.json`);
    }),

    preserveVersion: mock.fn(async (userId, docId, version, content, sidecar) => {
      const contentKey = `users/${userId}/conflicts/${docId}/${version}/content.md`;
      const sidecarKey = `users/${userId}/conflicts/${docId}/${version}/sidecar.json`;
      store.set(contentKey, content);
      store.set(sidecarKey, JSON.stringify(sidecar));
      return { contentKey, sidecarKey };
    }),

    getConflictVersion: mock.fn(async (userId, docId, version) => {
      const contentKey = `users/${userId}/conflicts/${docId}/${version}/content.md`;
      const sidecarKey = `users/${userId}/conflicts/${docId}/${version}/sidecar.json`;
      const content = store.get(contentKey);
      if (!content) return null;
      return { content, sidecar: JSON.parse(store.get(sidecarKey)) };
    }),

    deleteConflictVersions: mock.fn(async () => {}),

    isStorageAvailable: mock.fn(() => true),

    hashContent: mock.fn((content) => hashContent(content)),

    _store: store,
  };
}

// ─── Sync logic extracted for testing ───────────────────────────────────────
// These mirror the route handlers but accept db & storage as parameters

function checkStorageLimit(db, userId, tier, additionalBytes = 0, isNewDocument = false) {
  const STORAGE_LIMITS = { free: 100 * 1024 * 1024, premium: 1024 * 1024 * 1024, pro: 10 * 1024 * 1024 * 1024 };
  const DOCUMENT_LIMITS = { free: 100, premium: 1000, pro: 10000 };

  const usage = db.prepare('SELECT total_size_bytes, document_count FROM sync_usage WHERE user_id = ?').get(userId);
  const currentUsage = usage?.total_size_bytes || 0;
  const currentCount = usage?.document_count || 0;
  const byteLimit = STORAGE_LIMITS[tier] || STORAGE_LIMITS.free;
  const docLimit = DOCUMENT_LIMITS[tier] || DOCUMENT_LIMITS.free;
  const bytesExceeded = currentUsage + additionalBytes > byteLimit;
  const docsExceeded = isNewDocument && currentCount >= docLimit;

  return { allowed: !bytesExceeded && !docsExceeded, currentUsage, limit: byteLimit, remaining: byteLimit - currentUsage, currentCount, docLimit, bytesExceeded, docsExceeded };
}

function updateSyncUsage(db, userId, sizeDelta) {
  db.prepare(`
    INSERT INTO sync_usage (user_id, document_count, total_size_bytes, last_sync_at, updated_at)
    VALUES (?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      document_count = (SELECT COUNT(*) FROM sync_documents WHERE user_id = ? AND deleted_at IS NULL),
      total_size_bytes = total_size_bytes + ?,
      last_sync_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, Math.max(0, sizeDelta), userId, sizeDelta);
}

function logSyncOperation(db, userId, documentId, operation, path, sizeBytes, success, errorMessage = null) {
  db.prepare(`
    INSERT INTO sync_operations (user_id, document_id, operation, path, size_bytes, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, documentId, operation, path, sizeBytes, success ? 1 : 0, errorMessage);
}

async function uploadDocument(db, storage, userId, tier, docPath, content, sidecar, baseVersion) {
  const totalSize = Buffer.byteLength(content) + Buffer.byteLength(JSON.stringify(sidecar));

  const existingForLimitCheck = db
    .prepare('SELECT id FROM sync_documents WHERE user_id = ? AND path = ? AND deleted_at IS NULL')
    .get(userId, docPath);

  const storageCheck = checkStorageLimit(db, userId, tier, totalSize, !existingForLimitCheck);
  if (!storageCheck.allowed) {
    return { status: 413, body: { error: storageCheck.docsExceeded ? 'Document limit exceeded' : 'Storage limit exceeded' } };
  }

  const existing = db.prepare('SELECT * FROM sync_documents WHERE user_id = ? AND path = ?').get(userId, docPath);
  const documentId = existing?.id || crypto.randomUUID();

  const uploadResult = await storage.uploadDocument(userId, documentId, content, sidecar);

  const transact = db.transaction(() => {
    const current = db.prepare('SELECT * FROM sync_documents WHERE user_id = ? AND path = ?').get(userId, docPath);

    if (current && baseVersion !== undefined && current.version !== baseVersion) {
      return { conflict: true, current };
    }

    const sizeDelta = totalSize - (current?.size_bytes || 0);

    if (current) {
      db.prepare(`
        UPDATE sync_documents SET content_hash = ?, sidecar_hash = ?, r2_content_key = ?, r2_sidecar_key = ?,
          version = version + 1, size_bytes = ?, updated_at = CURRENT_TIMESTAMP, deleted_at = NULL
        WHERE id = ?
      `).run(uploadResult.contentHash, uploadResult.sidecarHash, uploadResult.contentKey, uploadResult.sidecarKey, totalSize, documentId);
    } else {
      db.prepare(`
        INSERT INTO sync_documents (id, user_id, path, content_hash, sidecar_hash, r2_content_key, r2_sidecar_key, version, size_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(documentId, userId, docPath, uploadResult.contentHash, uploadResult.sidecarHash, uploadResult.contentKey, uploadResult.sidecarKey, totalSize);
    }

    updateSyncUsage(db, userId, sizeDelta);
    logSyncOperation(db, userId, documentId, 'upload', docPath, totalSize, true);
    return { conflict: false };
  });

  const txResult = transact();

  if (txResult.conflict) {
    const current = txResult.current;
    const conflictId = crypto.randomUUID();
    const existingDoc = await storage.downloadDocument(userId, current.id);
    const localKeys = await storage.preserveVersion(userId, current.id, baseVersion, content, sidecar);

    db.prepare(`
      INSERT INTO sync_conflicts (id, document_id, user_id, local_version, remote_version,
        local_content_hash, remote_content_hash, local_r2_key, remote_r2_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(conflictId, current.id, userId, baseVersion, current.version, storage.hashContent(content), current.content_hash, localKeys.contentKey, current.r2_content_key);

    logSyncOperation(db, userId, current.id, 'conflict', docPath, totalSize, true);
    return {
      status: 409,
      body: {
        error: 'Conflict detected',
        conflict: { id: conflictId, documentId: current.id, localVersion: baseVersion, remoteVersion: current.version, remoteContent: existingDoc?.content, remoteSidecar: existingDoc?.sidecar },
      },
    };
  }

  const updated = db.prepare('SELECT * FROM sync_documents WHERE id = ?').get(documentId);
  return {
    status: 200,
    body: {
      success: true,
      document: { id: updated.id, path: updated.path, contentHash: updated.content_hash, sidecarHash: updated.sidecar_hash, version: updated.version, sizeBytes: updated.size_bytes, updatedAt: updated.updated_at },
    },
  };
}

function atomicRename(db, userId, docId, newPath) {
  const transact = db.transaction(() => {
    const doc = db.prepare('SELECT * FROM sync_documents WHERE id = ? AND user_id = ?').get(docId, userId);
    if (!doc) return { error: 'not_found' };

    const existing = db.prepare('SELECT id FROM sync_documents WHERE user_id = ? AND path = ? AND deleted_at IS NULL AND id != ?').get(userId, newPath, docId);
    if (existing) return { error: 'path_exists' };

    db.prepare('UPDATE sync_documents SET path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(newPath, docId, userId);
    return { success: true };
  });

  return transact();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Sync: Upload new document', () => {
  let db, storage;

  beforeEach(() => {
    db = createTestDB();
    storage = createMockStorage();
  });

  it('should create a new document with version 1', async () => {
    const result = await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Hello', { title: 'Test' });
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.document.version, 1);
    assert.equal(result.body.document.path, '/notes/test.md');
  });

  it('should update existing document (increment version)', async () => {
    await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Hello', { title: 'Test' });
    const result = await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Updated', { title: 'Updated' }, 1);
    assert.equal(result.status, 200);
    assert.equal(result.body.document.version, 2);
  });

  it('should track usage correctly', async () => {
    await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Hello', { title: 'Test' });
    const usage = db.prepare('SELECT * FROM sync_usage WHERE user_id = ?').get(1);
    assert.ok(usage);
    assert.equal(usage.document_count, 1);
    assert.ok(usage.total_size_bytes > 0);
  });
});

describe('Sync: Conflict detection (409)', () => {
  let db, storage;

  beforeEach(() => {
    db = createTestDB();
    storage = createMockStorage();
  });

  it('should return 409 when baseVersion does not match current version', async () => {
    // Create document at version 1
    await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Hello', { title: 'Test' });

    // Update to version 2
    await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Updated', { title: 'Updated' }, 1);

    // Try to upload with stale baseVersion=1 (server is now at version 2)
    const result = await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Conflicting', { title: 'Conflict' }, 1);
    assert.equal(result.status, 409);
    assert.ok(result.body.conflict);
    assert.equal(result.body.conflict.localVersion, 1);
    assert.equal(result.body.conflict.remoteVersion, 2);
  });

  it('should create a conflict record in the database', async () => {
    await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Hello', { title: 'Test' });
    await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Updated', { title: 'Updated' }, 1);
    await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Conflicting', { title: 'Conflict' }, 1);

    const conflicts = db.prepare('SELECT * FROM sync_conflicts WHERE user_id = ?').all(1);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].local_version, 1);
    assert.equal(conflicts[0].remote_version, 2);
  });

  it('should allow upload without baseVersion (no conflict check)', async () => {
    await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Hello', { title: 'Test' });
    // Upload without baseVersion — overwrites without conflict check
    const result = await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Overwrite', { title: 'Overwrite' });
    assert.equal(result.status, 200);
    assert.equal(result.body.document.version, 2);
  });
});

describe('Sync: Soft delete', () => {
  let db, storage;

  beforeEach(() => {
    db = createTestDB();
    storage = createMockStorage();
  });

  it('should soft-delete a document', async () => {
    const uploaded = await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Hello', { title: 'Test' });
    const docId = uploaded.body.document.id;

    db.prepare('UPDATE sync_documents SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(docId);

    const doc = db.prepare('SELECT * FROM sync_documents WHERE id = ?').get(docId);
    assert.ok(doc.deleted_at);
  });
});

describe('Sync: Atomic rename', () => {
  let db, storage;

  beforeEach(() => {
    db = createTestDB();
    storage = createMockStorage();
  });

  it('should rename document path atomically', async () => {
    const uploaded = await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Hello', { title: 'Test' });
    const docId = uploaded.body.document.id;

    const result = atomicRename(db, 1, docId, '/notes/renamed.md');
    assert.ok(result.success);

    const doc = db.prepare('SELECT path FROM sync_documents WHERE id = ?').get(docId);
    assert.equal(doc.path, '/notes/renamed.md');
  });

  it('should return not_found for non-existent document', () => {
    const result = atomicRename(db, 1, crypto.randomUUID(), '/notes/renamed.md');
    assert.equal(result.error, 'not_found');
  });

  it('should return path_exists when target path is taken', async () => {
    await uploadDocument(db, storage, 1, 'premium', '/notes/a.md', '# A', { title: 'A' });
    const uploaded = await uploadDocument(db, storage, 1, 'premium', '/notes/b.md', '# B', { title: 'B' });
    const docId = uploaded.body.document.id;

    const result = atomicRename(db, 1, docId, '/notes/a.md');
    assert.equal(result.error, 'path_exists');
  });
});

describe('Sync: Storage limit enforcement', () => {
  let db, storage;

  beforeEach(() => {
    db = createTestDB();
    storage = createMockStorage();
  });

  it('should enforce byte storage limits', () => {
    // Set usage close to free tier limit (100MB)
    db.prepare(`
      INSERT INTO sync_usage (user_id, document_count, total_size_bytes) VALUES (?, 50, ?)
    `).run(1, 99 * 1024 * 1024);

    const result = checkStorageLimit(db, 1, 'free', 2 * 1024 * 1024);
    assert.equal(result.allowed, false);
    assert.equal(result.bytesExceeded, true);
  });

  it('should enforce document count limits', () => {
    // Set document count at free tier limit (100)
    db.prepare(`
      INSERT INTO sync_usage (user_id, document_count, total_size_bytes) VALUES (?, 100, ?)
    `).run(1, 1024);

    const result = checkStorageLimit(db, 1, 'free', 100, true);
    assert.equal(result.allowed, false);
    assert.equal(result.docsExceeded, true);
  });

  it('should allow within limits', () => {
    db.prepare(`
      INSERT INTO sync_usage (user_id, document_count, total_size_bytes) VALUES (?, 5, ?)
    `).run(1, 1024);

    const result = checkStorageLimit(db, 1, 'premium', 1024, true);
    assert.equal(result.allowed, true);
  });

  it('should not count existing doc update against doc limit', () => {
    db.prepare(`
      INSERT INTO sync_usage (user_id, document_count, total_size_bytes) VALUES (?, 100, ?)
    `).run(1, 1024);

    // isNewDocument=false for updates
    const result = checkStorageLimit(db, 1, 'free', 100, false);
    assert.equal(result.docsExceeded, false);
  });
});

describe('Sync: Pagination', () => {
  let db, storage;

  beforeEach(async () => {
    db = createTestDB();
    storage = createMockStorage();
    // Create multiple documents with different timestamps
    for (let i = 0; i < 5; i++) {
      await uploadDocument(db, storage, 1, 'premium', `/notes/doc${i}.md`, `# Doc ${i}`, { title: `Doc ${i}` });
    }
  });

  it('should return all documents without pagination', () => {
    const docs = db.prepare('SELECT * FROM sync_documents WHERE user_id = ? ORDER BY updated_at DESC').all(1);
    assert.equal(docs.length, 5);
  });

  it('should return limited documents with pagination', () => {
    const docs = db.prepare('SELECT * FROM sync_documents WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?').all(1, 3);
    assert.equal(docs.length, 3);
  });

  it('should support cursor-based pagination', () => {
    const firstPage = db.prepare('SELECT * FROM sync_documents WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?').all(1, 3);
    assert.equal(firstPage.length, 3);

    const cursor = firstPage[firstPage.length - 1].updated_at;
    const secondPage = db.prepare('SELECT * FROM sync_documents WHERE user_id = ? AND updated_at < ? ORDER BY updated_at DESC LIMIT ?').all(1, cursor, 3);
    assert.ok(secondPage.length <= 3);
  });
});

describe('Sync: Conflict resolution', () => {
  let db, storage;

  beforeEach(async () => {
    db = createTestDB();
    storage = createMockStorage();
    // Create a conflict scenario
    await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Hello', { title: 'Test' });
    await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Updated', { title: 'Updated' }, 1);
    await uploadDocument(db, storage, 1, 'premium', '/notes/test.md', '# Conflicting', { title: 'Conflict' }, 1);
  });

  it('should mark conflict as resolved', () => {
    const conflict = db.prepare('SELECT * FROM sync_conflicts WHERE user_id = ? AND resolved_at IS NULL').get(1);
    assert.ok(conflict);

    db.prepare('UPDATE sync_conflicts SET resolved_at = CURRENT_TIMESTAMP, resolution = ? WHERE id = ?').run('remote', conflict.id);

    const resolved = db.prepare('SELECT * FROM sync_conflicts WHERE id = ?').get(conflict.id);
    assert.ok(resolved.resolved_at);
    assert.equal(resolved.resolution, 'remote');
  });

  it('should support local resolution', () => {
    const conflict = db.prepare('SELECT * FROM sync_conflicts WHERE user_id = ? AND resolved_at IS NULL').get(1);
    db.prepare('UPDATE sync_conflicts SET resolved_at = CURRENT_TIMESTAMP, resolution = ? WHERE id = ?').run('local', conflict.id);

    const resolved = db.prepare('SELECT * FROM sync_conflicts WHERE id = ?').get(conflict.id);
    assert.equal(resolved.resolution, 'local');
  });

  it('should support both resolution', () => {
    const conflict = db.prepare('SELECT * FROM sync_conflicts WHERE user_id = ? AND resolved_at IS NULL').get(1);
    db.prepare('UPDATE sync_conflicts SET resolved_at = CURRENT_TIMESTAMP, resolution = ? WHERE id = ?').run('both', conflict.id);

    const resolved = db.prepare('SELECT * FROM sync_conflicts WHERE id = ?').get(conflict.id);
    assert.equal(resolved.resolution, 'both');
  });
});

describe('Sync: Operation logging', () => {
  let db;

  beforeEach(() => {
    db = createTestDB();
  });

  it('should log sync operations', () => {
    logSyncOperation(db, 1, 'doc-123', 'upload', '/notes/test.md', 1024, true);
    logSyncOperation(db, 1, 'doc-123', 'download', '/notes/test.md', 1024, true);
    logSyncOperation(db, 1, 'doc-123', 'delete', '/notes/test.md', 0, true);

    const ops = db.prepare('SELECT * FROM sync_operations WHERE user_id = ?').all(1);
    assert.equal(ops.length, 3);
  });

  it('should log failed operations with error', () => {
    logSyncOperation(db, 1, 'doc-123', 'upload', '/notes/test.md', 1024, false, 'Storage error');

    const op = db.prepare('SELECT * FROM sync_operations WHERE user_id = ? AND success = 0').get(1);
    assert.ok(op);
    assert.equal(op.error_message, 'Storage error');
  });
});
