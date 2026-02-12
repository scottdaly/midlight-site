/**
 * Collaborative Editing Service
 *
 * Hocuspocus v2 WebSocket server for real-time collaborative editing.
 * Uses Y.js CRDTs with Tiptap's Collaboration extension.
 *
 * - Authenticates via JWT (same tokens as REST API)
 * - Persists Y.js state to SQLite (yjs_documents table)
 * - Converts Tiptap JSON ↔ Y.js on first load
 * - Snapshots back to Tiptap JSON for REST consumers
 */

import { Server as HocuspocusServer } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { Throttle } from '@hocuspocus/extension-throttle';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON, prosemirrorJSONToYDoc } from 'y-prosemirror';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Image from '@tiptap/extension-image';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import TiptapTextStyle from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import db from '../db/index.js';
import { verifyAccessToken } from './tokenService.js';
import { findUserById } from './authService.js';
import { getDocumentPermission } from '../middleware/shareAuth.js';
import storage, { downloadDocument, uploadDocument } from './storageService.js';
import { logger } from '../utils/logger.js';

// Tiptap schema for server-side JSON ↔ Y.js conversion
// Must include all custom node types used by the client to avoid dropping content
const schema = getSchema([
  StarterKit.configure({ code: false, horizontalRule: false }),
  Table,
  TableRow,
  TableHeader,
  TableCell,
  Image.extend({
    name: 'resizableImage',
    addAttributes() {
      return {
        ...this.parent?.(),
        width: { default: '100%' },
        height: { default: 'auto' },
        align: { default: 'center-break' },
      };
    },
  }),
  Underline,
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  TiptapTextStyle,
  Highlight,
]);

// Track last Tiptap JSON snapshot time per document (throttle to 1 per 30s)
const lastSnapshotTime = new Map();
const SNAPSHOT_INTERVAL_MS = 30_000;

// Track last version checkpoint time per document (throttle to 1 per 5 minutes)
const lastCheckpointTime = new Map();
const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;

// Permission re-check cache for long-running connections (H3)
const connectionPermissionCache = new Map();
const PERMISSION_RECHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Prepared statements for Y.js document persistence
const getYjsState = db.prepare('SELECT state FROM yjs_documents WHERE document_id = ?');
const upsertYjsState = db.prepare(`
  INSERT INTO yjs_documents (document_id, state, updated_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(document_id) DO UPDATE SET
    state = excluded.state,
    updated_at = CURRENT_TIMESTAMP
`);

// Get document owner for storage operations
const getDocOwner = db.prepare('SELECT user_id FROM sync_documents WHERE id = ?');

// Prepared statements for Tiptap JSON snapshot persistence
const bumpDocVersion = db.prepare(`
  UPDATE sync_documents
  SET content_hash = ?, sidecar_hash = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

// Prepared statements for version history auto-checkpoints
const insertVersion = db.prepare(`
  INSERT INTO sync_versions (id, document_id, user_id, label, description, content_hash,
    sidecar_hash, summary, stats_json, size_bytes, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);
const insertVersionContent = db.prepare(`
  INSERT OR REPLACE INTO sync_version_content (version_id, user_id, content, sidecar, updated_at)
  VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
`);

/**
 * Load Y.js state for a document.
 * On first collab session, converts existing Tiptap JSON to Y.js state.
 */
async function fetchDocument(documentId) {
  // Try to load existing Y.js state
  const row = getYjsState.get(documentId);
  if (row) {
    return row.state;
  }

  // First collab session — convert from Tiptap JSON
  const docInfo = getDocOwner.get(documentId);
  if (!docInfo) {
    logger.warn({ documentId }, 'Document not found for collab fetch');
    return null;
  }

  try {
    const result = await downloadDocument(docInfo.user_id, documentId);
    if (!result || !result.sidecar) {
      logger.warn({ documentId }, 'No document content found for initial Y.js conversion');
      return null;
    }

    // The sidecar contains the Tiptap JSON document structure
    const tiptapJson = result.sidecar.content || result.sidecar;

    // Convert Tiptap JSON → Y.Doc using y-prosemirror
    const ydoc = prosemirrorJSONToYDoc(schema, tiptapJson, 'default');
    const state = Y.encodeStateAsUpdate(ydoc);
    ydoc.destroy();

    // Persist the initial Y.js state
    upsertYjsState.run(documentId, Buffer.from(state));

    logger.info({ documentId }, 'Initial Y.js state created from Tiptap JSON');
    return Buffer.from(state);
  } catch (err) {
    logger.error({ error: err.message, documentId }, 'Failed to create initial Y.js state');
    return null;
  }
}

/**
 * Persist Y.js state and periodically snapshot back to Tiptap JSON.
 */
async function storeDocument(documentId, state) {
  // Always persist Y.js binary state
  upsertYjsState.run(documentId, Buffer.from(state));

  // Throttled: snapshot back to Tiptap JSON for REST consumers
  const now = Date.now();
  const lastSnapshot = lastSnapshotTime.get(documentId) || 0;
  if (now - lastSnapshot < SNAPSHOT_INTERVAL_MS) {
    return;
  }
  lastSnapshotTime.set(documentId, now);

  try {
    const docInfo = getDocOwner.get(documentId);
    if (!docInfo) return;

    // Decode Y.js state → Tiptap JSON
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(state));
    const tiptapJson = yDocToProsemirrorJSON(ydoc, 'default');
    ydoc.destroy();

    // Download existing document to get the markdown content and sidecar structure
    const existing = await downloadDocument(docInfo.user_id, documentId);
    if (!existing) return;

    // Build updated sidecar with new Tiptap JSON content
    const sidecar = existing.sidecar || {};
    sidecar.content = tiptapJson;

    // Simple markdown extraction (paragraph text) for the content field
    const content = extractMarkdownFromTiptap(tiptapJson);

    // Upload back to storage
    await uploadDocument(docInfo.user_id, documentId, content, sidecar);

    // Bump version in sync_documents
    bumpDocVersion.run(
      storage.hashContent(content),
      storage.hashContent(JSON.stringify(sidecar)),
      documentId
    );

    logger.debug({ documentId }, 'Tiptap JSON snapshot saved');

    // Create version history checkpoint (throttled to 1 per 5 minutes)
    await maybeCreateCheckpoint(documentId, content, sidecar);
  } catch (err) {
    logger.error({ error: err.message, documentId }, 'Failed to snapshot Tiptap JSON');
  }
}

/**
 * Extract simple markdown text from Tiptap JSON (basic extraction for search/preview).
 */
function extractMarkdownFromTiptap(json) {
  if (!json || !json.content) return '';

  const lines = [];
  for (const node of json.content) {
    if (node.type === 'paragraph' && node.content) {
      const text = node.content
        .filter(n => n.type === 'text')
        .map(n => n.text)
        .join('');
      lines.push(text);
    } else if (node.type === 'heading' && node.content) {
      const level = node.attrs?.level || 1;
      const text = node.content
        .filter(n => n.type === 'text')
        .map(n => n.text)
        .join('');
      lines.push('#'.repeat(level) + ' ' + text);
    } else if (node.type === 'bulletList' || node.type === 'orderedList') {
      if (node.content) {
        for (const item of node.content) {
          if (item.content) {
            for (const para of item.content) {
              if (para.content) {
                const text = para.content
                  .filter(n => n.type === 'text')
                  .map(n => n.text)
                  .join('');
                lines.push('- ' + text);
              }
            }
          }
        }
      }
    } else if (node.type === 'codeBlock' && node.content) {
      const text = node.content
        .filter(n => n.type === 'text')
        .map(n => n.text)
        .join('');
      lines.push('```\n' + text + '\n```');
    }
  }
  return lines.join('\n\n');
}

/**
 * Create an auto-checkpoint in sync_versions for version history.
 * Throttled to 1 per 5 minutes per document.
 */
async function maybeCreateCheckpoint(documentId, content, sidecar) {
  const now = Date.now();
  const lastCheckpoint = lastCheckpointTime.get(documentId) || 0;
  if (now - lastCheckpoint < CHECKPOINT_INTERVAL_MS) {
    return;
  }
  lastCheckpointTime.set(documentId, now);

  try {
    const docInfo = getDocOwner.get(documentId);
    if (!docInfo) return;

    const versionId = `collab-${documentId}-${Date.now()}`;
    const contentHash = storage.hashContent(content);
    const sidecarStr = JSON.stringify(sidecar);
    const sidecarHash = storage.hashContent(sidecarStr);
    const totalSize = Buffer.byteLength(content, 'utf8') + Buffer.byteLength(sidecarStr, 'utf8');

    // Count words for stats
    const wordCount = content.split(/\s+/).filter(Boolean).length;
    const charCount = content.length;
    const statsJson = JSON.stringify({ wordCount, charCount, changeSize: 0 });

    insertVersion.run(
      versionId,
      documentId,
      docInfo.user_id,
      'Auto-save (collab)',
      null,
      contentHash,
      sidecarHash,
      null,
      statsJson,
      totalSize
    );

    // Store version content
    insertVersionContent.run(versionId, docInfo.user_id, content, sidecarStr);

    logger.debug({ documentId, versionId }, 'Collab auto-checkpoint created');
  } catch (err) {
    logger.error({ error: err.message, documentId }, 'Failed to create collab auto-checkpoint');
  }
}

/**
 * Hocuspocus server instance
 */
export const hocuspocus = HocuspocusServer.configure({
  // No HTTP server — we handle upgrade manually
  port: null,

  // Extensions
  extensions: [
    new Throttle({
      throttle: 500, // Throttle persistence to max 1 write per 500ms
    }),
    new Database({
      fetch: async ({ documentName }) => {
        const state = await fetchDocument(documentName);
        return state ? new Uint8Array(state) : null;
      },
      store: async ({ documentName, state }) => {
        await storeDocument(documentName, state);
      },
    }),
  ],

  // Authentication: validate JWT token and check document permission
  async onAuthenticate({ token, documentName, connection }) {
    if (!token) {
      throw new Error('Authentication required');
    }

    // Verify JWT
    const payload = verifyAccessToken(token);
    if (!payload) {
      // Use code 4401 so client knows to refresh token
      const err = new Error('Invalid or expired token');
      err.code = 4401;
      throw err;
    }

    // Load user
    const user = findUserById(payload.userId);
    if (!user) {
      throw new Error('User not found');
    }

    // Check document permission
    const permission = getDocumentPermission(user.id, documentName);
    if (!permission) {
      throw new Error('Access denied');
    }

    // Return user context (available in other hooks via connection.context)
    return {
      user: {
        id: user.id,
        name: user.display_name || user.email,
        email: user.email,
      },
      permission,
    };
  },

  // Reject updates from view-only users
  // Must use beforeHandleMessage (not onChange) because onChange fires AFTER Y.applyUpdate
  async beforeHandleMessage({ context, documentName }) {
    if (context?.permission === 'view') {
      throw new Error('View-only access');
    }

    // Periodically re-check permission for long-running connections
    const userId = context?.user?.id;
    if (userId && documentName) {
      const cacheKey = `${userId}:${documentName}`;
      const lastCheck = connectionPermissionCache.get(cacheKey) || 0;
      const now = Date.now();

      if (now - lastCheck > PERMISSION_RECHECK_INTERVAL_MS) {
        connectionPermissionCache.set(cacheKey, now);
        const currentPermission = getDocumentPermission(userId, documentName);
        if (!currentPermission || currentPermission === 'view') {
          connectionPermissionCache.delete(cacheKey);
          throw new Error('Permission revoked');
        }
      }
    }
  },

  // Log connections
  async onConnect({ documentName, connection }) {
    const user = connection?.context?.user;
    logger.info(
      { documentId: documentName, userId: user?.id, userName: user?.name },
      'Collab user connected'
    );
  },

  async onDisconnect({ documentName, connection }) {
    const user = connection?.context?.user;
    if (user?.id && documentName) {
      connectionPermissionCache.delete(`${user.id}:${documentName}`);
    }
    logger.info(
      { documentId: documentName, userId: user?.id },
      'Collab user disconnected'
    );
  },

  // Clean up throttle maps when a document is unloaded from memory
  async afterUnloadDocument({ documentName }) {
    lastSnapshotTime.delete(documentName);
    lastCheckpointTime.delete(documentName);
  },
});
