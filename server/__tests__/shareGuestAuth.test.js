/**
 * Share guest auth resolution tests.
 *
 * Run: node --test server/__tests__/shareGuestAuth.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { __private as sharePrivate } from '../routes/share.js';

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'dev-access-secret-change-in-production';

function createTestDB() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT
    );

    CREATE TABLE guest_sessions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      share_id TEXT,
      display_name TEXT,
      permission TEXT NOT NULL DEFAULT 'view',
      expires_at DATETIME NOT NULL,
      last_active_at DATETIME
    );
  `);

  db.prepare('INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)').run(1, 'owner@example.com', 'Owner');
  db.prepare(`
    INSERT INTO guest_sessions (id, document_id, share_id, display_name, permission, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('guest-1', 'doc-123', 'share-123', 'Guest Editor', 'edit', '2099-01-01T00:00:00.000Z');

  return db;
}

describe('share guest auth resolution', () => {
  it('resolves a regular user bearer token', () => {
    const db = createTestDB();
    const token = jwt.sign({ userId: 1 }, ACCESS_TOKEN_SECRET, { expiresIn: '1h' });

    const actor = sharePrivate.resolveShareWriteActor({
      authorizationHeader: `Bearer ${token}`,
      database: db,
    });

    assert.deepEqual(actor, {
      type: 'user',
      userId: 1,
    });
  });

  it('resolves a guest bearer token backed by a live guest session', () => {
    const db = createTestDB();
    const token = jwt.sign({ guestSessionId: 'guest-1', documentId: 'doc-123' }, ACCESS_TOKEN_SECRET, { expiresIn: '1h' });

    const actor = sharePrivate.resolveShareWriteActor({
      authorizationHeader: `Bearer ${token}`,
      database: db,
    });

    assert.equal(actor?.type, 'guest');
    assert.equal(actor?.guestSession?.id, 'guest-1');
    assert.equal(actor?.guestSession?.document_id, 'doc-123');
  });

  it('returns null for invalid guest sessions', () => {
    const db = createTestDB();
    const token = jwt.sign({ guestSessionId: 'missing-session', documentId: 'doc-123' }, ACCESS_TOKEN_SECRET, { expiresIn: '1h' });

    const actor = sharePrivate.resolveShareWriteActor({
      authorizationHeader: `Bearer ${token}`,
      database: db,
    });

    assert.equal(actor, null);
  });
});
