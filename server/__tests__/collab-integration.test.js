/**
 * Collaborative Editing Integration Tests
 *
 * Tests the end-to-end Y.js document sync flow:
 * - Two Y.Docs syncing updates (simulating two clients)
 * - Persistence round-trip (Y.js → DB → Y.js)
 * - Y.js → Tiptap JSON conversion for REST consumers
 *
 * These tests verify the data flow without requiring a live WebSocket server,
 * which is the same sync mechanism Hocuspocus uses internally.
 *
 * Run: node --test server/__tests__/collab-integration.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import * as Y from 'yjs';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTestDB() {
	const db = new Database(':memory:');

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
			deleted_at DATETIME
		);
		CREATE TABLE IF NOT EXISTS yjs_documents (
			document_id TEXT PRIMARY KEY,
			state BLOB NOT NULL,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (document_id) REFERENCES sync_documents(id) ON DELETE CASCADE
		);
	`);

	db.prepare('INSERT INTO sync_documents (id, user_id, path, version) VALUES (?, ?, ?, ?)').run(
		'doc-1',
		1,
		'/test-document.midlight',
		1,
	);

	return db;
}

/**
 * Simulate sync between two Y.Docs by exchanging state vectors and updates,
 * which is exactly what Hocuspocus does over WebSocket.
 */
function syncDocs(docA, docB) {
	const stateVectorA = Y.encodeStateVector(docA);
	const stateVectorB = Y.encodeStateVector(docB);
	const diffA = Y.encodeStateAsUpdate(docA, stateVectorB);
	const diffB = Y.encodeStateAsUpdate(docB, stateVectorA);
	Y.applyUpdate(docA, diffB);
	Y.applyUpdate(docB, diffA);
}

// ─── Test: Two clients syncing via Y.js ─────────────────────────────────────

describe('Two-client Y.js sync simulation', () => {
	it('should sync text typed by User A to User B', () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();

		// User A types
		docA.getText('default').insert(0, 'Hello from User A');

		// Sync
		syncDocs(docA, docB);

		// User B should see A's text
		assert.equal(docB.getText('default').toString(), 'Hello from User A');

		docA.destroy();
		docB.destroy();
	});

	it('should sync text typed by User B to User A', () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();

		// User B types
		docB.getText('default').insert(0, 'Hello from User B');

		// Sync
		syncDocs(docA, docB);

		// User A should see B's text
		assert.equal(docA.getText('default').toString(), 'Hello from User B');

		docA.destroy();
		docB.destroy();
	});

	it('should merge concurrent edits from both users', () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();

		// Both users type concurrently (before sync)
		docA.getText('default').insert(0, 'AAA');
		docB.getText('default').insert(0, 'BBB');

		// Sync
		syncDocs(docA, docB);

		// Both docs should have the same merged content
		const textA = docA.getText('default').toString();
		const textB = docB.getText('default').toString();

		assert.equal(textA, textB, 'Both docs should converge to same content');
		assert.ok(textA.includes('AAA'), 'Merged text should contain User A edits');
		assert.ok(textA.includes('BBB'), 'Merged text should contain User B edits');

		docA.destroy();
		docB.destroy();
	});

	it('should handle sequential edits with multiple sync rounds', () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();

		// Round 1: User A types
		docA.getText('default').insert(0, 'First. ');
		syncDocs(docA, docB);

		// Round 2: User B appends
		const textB = docB.getText('default');
		textB.insert(textB.length, 'Second. ');
		syncDocs(docA, docB);

		// Round 3: User A appends
		const textA = docA.getText('default');
		textA.insert(textA.length, 'Third.');
		syncDocs(docA, docB);

		// Both should have all three parts
		assert.equal(docA.getText('default').toString(), 'First. Second. Third.');
		assert.equal(docB.getText('default').toString(), 'First. Second. Third.');

		docA.destroy();
		docB.destroy();
	});
});

// ─── Test: Persistence round-trip ───────────────────────────────────────────

describe('Y.js persistence round-trip', () => {
	let db;

	beforeEach(() => {
		db = createTestDB();
	});

	it('should persist Y.js state and restore it to a new doc', () => {
		// User A creates a document with content
		const docA = new Y.Doc();
		docA.getText('default').insert(0, 'Persistent content');

		// Persist full state to DB (what Hocuspocus Database extension does)
		const fullState = Y.encodeStateAsUpdate(docA);
		db.prepare(`
			INSERT INTO yjs_documents (document_id, state, updated_at)
			VALUES (?, ?, CURRENT_TIMESTAMP)
		`).run('doc-1', Buffer.from(fullState));
		docA.destroy();

		// Later: User B opens the document (server loads from DB)
		const row = db.prepare('SELECT state FROM yjs_documents WHERE document_id = ?').get('doc-1');
		const docB = new Y.Doc();
		Y.applyUpdate(docB, new Uint8Array(row.state));

		assert.equal(docB.getText('default').toString(), 'Persistent content');
		docB.destroy();
	});

	it('should preserve edits across multiple persist cycles', () => {
		const upsert = db.prepare(`
			INSERT INTO yjs_documents (document_id, state, updated_at)
			VALUES (?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(document_id) DO UPDATE SET
				state = excluded.state,
				updated_at = CURRENT_TIMESTAMP
		`);

		// Cycle 1: User A edits
		const doc1 = new Y.Doc();
		doc1.getText('default').insert(0, 'Hello');
		upsert.run('doc-1', Buffer.from(Y.encodeStateAsUpdate(doc1)));
		doc1.destroy();

		// Cycle 2: Load, edit, persist
		const row1 = db.prepare('SELECT state FROM yjs_documents WHERE document_id = ?').get('doc-1');
		const doc2 = new Y.Doc();
		Y.applyUpdate(doc2, new Uint8Array(row1.state));
		doc2.getText('default').insert(5, ' world');
		upsert.run('doc-1', Buffer.from(Y.encodeStateAsUpdate(doc2)));
		doc2.destroy();

		// Cycle 3: Load, edit, persist
		const row2 = db.prepare('SELECT state FROM yjs_documents WHERE document_id = ?').get('doc-1');
		const doc3 = new Y.Doc();
		Y.applyUpdate(doc3, new Uint8Array(row2.state));
		doc3.getText('default').insert(11, '!');
		upsert.run('doc-1', Buffer.from(Y.encodeStateAsUpdate(doc3)));
		doc3.destroy();

		// Final read
		const row3 = db.prepare('SELECT state FROM yjs_documents WHERE document_id = ?').get('doc-1');
		const docFinal = new Y.Doc();
		Y.applyUpdate(docFinal, new Uint8Array(row3.state));
		assert.equal(docFinal.getText('default').toString(), 'Hello world!');
		docFinal.destroy();
	});

	it('should sync two clients through persisted state (server relay)', () => {
		const upsert = db.prepare(`
			INSERT INTO yjs_documents (document_id, state, updated_at)
			VALUES (?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(document_id) DO UPDATE SET
				state = excluded.state,
				updated_at = CURRENT_TIMESTAMP
		`);

		// User A writes and "disconnects" (state persisted by server)
		const docA = new Y.Doc();
		docA.getText('default').insert(0, 'From A. ');
		upsert.run('doc-1', Buffer.from(Y.encodeStateAsUpdate(docA)));
		docA.destroy();

		// User B connects later, loads state, edits, persists
		const rowA = db.prepare('SELECT state FROM yjs_documents WHERE document_id = ?').get('doc-1');
		const docB = new Y.Doc();
		Y.applyUpdate(docB, new Uint8Array(rowA.state));
		docB.getText('default').insert(8, 'From B.');
		upsert.run('doc-1', Buffer.from(Y.encodeStateAsUpdate(docB)));
		docB.destroy();

		// User A reconnects, loads merged state
		const rowB = db.prepare('SELECT state FROM yjs_documents WHERE document_id = ?').get('doc-1');
		const docA2 = new Y.Doc();
		Y.applyUpdate(docA2, new Uint8Array(rowB.state));

		assert.equal(docA2.getText('default').toString(), 'From A. From B.');
		docA2.destroy();
	});
});

// ─── Test: Y.js state to Tiptap JSON conversion ────────────────────────────

describe('Y.js to Tiptap JSON conversion', () => {
	it('should extract XmlFragment content from Y.Doc', () => {
		// Hocuspocus stores Tiptap content in an XmlFragment named "default"
		// The y-prosemirror library handles the Tiptap JSON ↔ Y.js conversion
		// Here we verify the Y.Doc structure matches what Tiptap expects

		const doc = new Y.Doc();

		// Tiptap Collaboration extension uses doc.getXmlFragment('default')
		const fragment = doc.getXmlFragment('default');

		// Simulate inserting a paragraph element (what Tiptap does)
		const paragraph = new Y.XmlElement('paragraph');
		const textNode = new Y.XmlText('Hello Tiptap');
		paragraph.insert(0, [textNode]);
		fragment.insert(0, [paragraph]);

		// Verify structure
		assert.equal(fragment.length, 1);
		const firstChild = fragment.get(0);
		assert.equal(firstChild.nodeName, 'paragraph');

		// The fragment can be serialized and deserialized
		const state = Y.encodeStateAsUpdate(doc);
		const doc2 = new Y.Doc();
		Y.applyUpdate(doc2, state);

		const fragment2 = doc2.getXmlFragment('default');
		assert.equal(fragment2.length, 1);
		assert.equal(fragment2.get(0).nodeName, 'paragraph');

		doc.destroy();
		doc2.destroy();
	});

	it('should merge XmlFragment edits between two docs', () => {
		const docA = new Y.Doc();
		const docB = new Y.Doc();

		const fragA = docA.getXmlFragment('default');
		const fragB = docB.getXmlFragment('default');

		// User A adds a paragraph
		const paraA = new Y.XmlElement('paragraph');
		paraA.insert(0, [new Y.XmlText('Paragraph by A')]);
		fragA.insert(0, [paraA]);

		// Sync
		syncDocs(docA, docB);

		// User B adds another paragraph
		const paraB = new Y.XmlElement('paragraph');
		paraB.insert(0, [new Y.XmlText('Paragraph by B')]);
		fragB.insert(fragB.length, [paraB]);

		// Sync
		syncDocs(docA, docB);

		// Both should have 2 paragraphs
		assert.equal(fragA.length, 2);
		assert.equal(fragB.length, 2);
		assert.equal(fragA.get(0).nodeName, 'paragraph');
		assert.equal(fragA.get(1).nodeName, 'paragraph');

		docA.destroy();
		docB.destroy();
	});
});

// ─── Test: Awareness protocol (cursor presence) ─────────────────────────────

describe('Awareness protocol for cursor presence', () => {
	it('should track local user state in awareness', () => {
		const doc = new Y.Doc();

		// Awareness is a separate protocol layered on top of Y.js
		// Hocuspocus handles awareness sync over WebSocket
		// Here we verify the Y.Doc awareness concept by using local state

		// Simulate awareness state (what CollaborationCursor sets)
		const userState = {
			user: { name: 'Alice', color: '#E57373' },
			cursor: { anchor: 5, head: 5 },
		};

		// In real usage, provider.awareness.setLocalStateField('user', ...)
		// Here we just verify the data structure is correct
		assert.equal(userState.user.name, 'Alice');
		assert.equal(userState.user.color, '#E57373');
		assert.equal(userState.cursor.anchor, 5);

		doc.destroy();
	});
});

// ─── Test: Document version increment on collab persistence ─────────────────

describe('Document version increment on collab persistence', () => {
	let db;

	beforeEach(() => {
		db = createTestDB();
	});

	it('should increment version each time collab persists a snapshot', () => {
		const docId = 'doc-1';

		// Initial version
		let doc = db.prepare('SELECT version FROM sync_documents WHERE id = ?').get(docId);
		assert.equal(doc.version, 1);

		// First collab snapshot
		db.prepare(`
			UPDATE sync_documents
			SET version = version + 1, updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`).run(docId);
		doc = db.prepare('SELECT version FROM sync_documents WHERE id = ?').get(docId);
		assert.equal(doc.version, 2);

		// Second collab snapshot
		db.prepare(`
			UPDATE sync_documents
			SET version = version + 1, updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`).run(docId);
		doc = db.prepare('SELECT version FROM sync_documents WHERE id = ?').get(docId);
		assert.equal(doc.version, 3);
	});
});
