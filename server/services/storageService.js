/**
 * Storage Service
 * Handles document storage in Cloudflare R2 (preferred) or SQLite (fallback)
 * When R2 is not configured, stores content directly in SQLite tables.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import db from '../db/index.js';

// R2 Configuration
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'midlight-documents';

// Check if R2 is configured
const isR2Configured = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);

// Initialize S3 client for R2
let s3Client = null;

if (isR2Configured) {
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  console.log('[Storage] Using Cloudflare R2 storage');
} else {
  console.log('[Storage] R2 not configured, using SQLite fallback storage');
}

/**
 * Generate a storage key for a user's document
 * Format: users/{userId}/documents/{documentId}/{type}
 */
function generateKey(userId, documentId, type) {
  return `users/${userId}/documents/${documentId}/${type}`;
}

/**
 * Generate a storage key for conflict preservation
 */
function generateConflictKey(userId, documentId, version, type) {
  return `users/${userId}/conflicts/${documentId}/${version}/${type}`;
}

/**
 * Calculate SHA-256 hash of content
 */
function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ============================================================================
// SQLite Fallback Implementation
// ============================================================================

function sqliteUploadDocument(userId, documentId, content, sidecar) {
  const sidecarJson = JSON.stringify(sidecar);
  const contentHash = hashContent(content);
  const sidecarHash = hashContent(sidecarJson);
  const contentSize = Buffer.byteLength(content, 'utf-8');
  const sidecarSize = Buffer.byteLength(sidecarJson, 'utf-8');

  db.prepare(`
    INSERT INTO sync_document_content (document_id, user_id, content, sidecar, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(document_id, user_id) DO UPDATE SET
      content = excluded.content,
      sidecar = excluded.sidecar,
      updated_at = CURRENT_TIMESTAMP
  `).run(documentId, userId, content, sidecarJson);

  return {
    contentKey: `sqlite:${documentId}:content`,
    sidecarKey: `sqlite:${documentId}:sidecar`,
    contentHash,
    sidecarHash,
    sizeBytes: contentSize + sidecarSize,
  };
}

function sqliteDownloadDocument(userId, documentId) {
  const row = db.prepare(
    'SELECT content, sidecar FROM sync_document_content WHERE document_id = ? AND user_id = ?'
  ).get(documentId, userId);

  if (!row) {
    return null;
  }

  const sidecar = JSON.parse(row.sidecar);
  return {
    content: row.content,
    sidecar,
    contentHash: hashContent(row.content),
    sidecarHash: hashContent(row.sidecar),
  };
}

function sqliteDeleteDocument(userId, documentId) {
  db.prepare(
    'DELETE FROM sync_document_content WHERE document_id = ? AND user_id = ?'
  ).run(documentId, userId);
}

function sqliteDocumentExists(userId, documentId) {
  const row = db.prepare(
    'SELECT 1 FROM sync_document_content WHERE document_id = ? AND user_id = ?'
  ).get(documentId, userId);
  return !!row;
}

function sqlitePreserveVersion(userId, documentId, version, content, sidecar) {
  const sidecarJson = JSON.stringify(sidecar);

  db.prepare(`
    INSERT INTO sync_conflict_content (user_id, document_id, version, content, sidecar)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, document_id, version) DO UPDATE SET
      content = excluded.content,
      sidecar = excluded.sidecar
  `).run(userId, documentId, version, content, sidecarJson);

  return {
    contentKey: `sqlite:conflict:${documentId}:${version}:content`,
    sidecarKey: `sqlite:conflict:${documentId}:${version}:sidecar`,
  };
}

function sqliteGetConflictVersion(userId, documentId, version) {
  const row = db.prepare(
    'SELECT content, sidecar FROM sync_conflict_content WHERE user_id = ? AND document_id = ? AND version = ?'
  ).get(userId, documentId, version);

  if (!row) {
    return null;
  }

  return {
    content: row.content,
    sidecar: JSON.parse(row.sidecar),
  };
}

function sqliteDeleteConflictVersions(userId, documentId, versions) {
  const stmt = db.prepare(
    'DELETE FROM sync_conflict_content WHERE user_id = ? AND document_id = ? AND version = ?'
  );
  for (const version of versions) {
    stmt.run(userId, documentId, version);
  }
}

function sqliteListUserDocuments(userId) {
  const rows = db.prepare(`
    SELECT c.document_id, LENGTH(c.content) + LENGTH(c.sidecar) as size, c.updated_at
    FROM sync_document_content c
    WHERE c.user_id = ?
  `).all(userId);

  return rows.map(row => ({
    documentId: row.document_id,
    lastModified: row.updated_at,
    size: row.size,
  }));
}

function sqliteGetUserStorageUsage(userId) {
  const row = db.prepare(`
    SELECT COUNT(*) as doc_count, COALESCE(SUM(LENGTH(content) + LENGTH(sidecar)), 0) as total_size
    FROM sync_document_content
    WHERE user_id = ?
  `).get(userId);

  return {
    totalSize: row?.total_size || 0,
    documentCount: row?.doc_count || 0,
  };
}

// ============================================================================
// Public API (dispatches to R2 or SQLite)
// ============================================================================

/**
 * Upload document content
 */
export async function uploadDocument(userId, documentId, content, sidecar) {
  if (!isR2Configured) {
    return sqliteUploadDocument(userId, documentId, content, sidecar);
  }

  const contentKey = generateKey(userId, documentId, 'content.md');
  const sidecarKey = generateKey(userId, documentId, 'sidecar.json');

  const contentBuffer = Buffer.from(content, 'utf-8');
  const sidecarBuffer = Buffer.from(JSON.stringify(sidecar), 'utf-8');

  // Upload content
  await s3Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: contentKey,
      Body: contentBuffer,
      ContentType: 'text/markdown',
      Metadata: {
        'user-id': String(userId),
        'document-id': documentId,
        'content-hash': hashContent(content),
      },
    })
  );

  // Upload sidecar
  await s3Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: sidecarKey,
      Body: sidecarBuffer,
      ContentType: 'application/json',
      Metadata: {
        'user-id': String(userId),
        'document-id': documentId,
        'sidecar-hash': hashContent(JSON.stringify(sidecar)),
      },
    })
  );

  return {
    contentKey,
    sidecarKey,
    contentHash: hashContent(content),
    sidecarHash: hashContent(JSON.stringify(sidecar)),
    sizeBytes: contentBuffer.length + sidecarBuffer.length,
  };
}

/**
 * Download document
 */
export async function downloadDocument(userId, documentId) {
  if (!isR2Configured) {
    return sqliteDownloadDocument(userId, documentId);
  }

  const contentKey = generateKey(userId, documentId, 'content.md');
  const sidecarKey = generateKey(userId, documentId, 'sidecar.json');

  try {
    // Download content
    const contentResponse = await s3Client.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: contentKey,
      })
    );
    const content = await contentResponse.Body.transformToString();

    // Download sidecar
    const sidecarResponse = await s3Client.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: sidecarKey,
      })
    );
    const sidecarJson = await sidecarResponse.Body.transformToString();
    const sidecar = JSON.parse(sidecarJson);

    return {
      content,
      sidecar,
      contentHash: hashContent(content),
      sidecarHash: hashContent(sidecarJson),
    };
  } catch (error) {
    if (error.name === 'NoSuchKey') {
      return null;
    }
    throw error;
  }
}

/**
 * Delete document
 */
export async function deleteDocument(userId, documentId) {
  if (!isR2Configured) {
    return sqliteDeleteDocument(userId, documentId);
  }

  const contentKey = generateKey(userId, documentId, 'content.md');
  const sidecarKey = generateKey(userId, documentId, 'sidecar.json');

  await Promise.all([
    s3Client.send(
      new DeleteObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: contentKey,
      })
    ),
    s3Client.send(
      new DeleteObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: sidecarKey,
      })
    ),
  ]);
}

/**
 * Check if a document exists
 */
export async function documentExists(userId, documentId) {
  if (!isR2Configured) {
    return sqliteDocumentExists(userId, documentId);
  }

  const contentKey = generateKey(userId, documentId, 'content.md');

  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: contentKey,
      })
    );
    return true;
  } catch (error) {
    if (error.name === 'NotFound') {
      return false;
    }
    throw error;
  }
}

/**
 * Preserve a version for conflict resolution
 */
export async function preserveVersion(userId, documentId, version, content, sidecar) {
  if (!isR2Configured) {
    return sqlitePreserveVersion(userId, documentId, version, content, sidecar);
  }

  const contentKey = generateConflictKey(userId, documentId, version, 'content.md');
  const sidecarKey = generateConflictKey(userId, documentId, version, 'sidecar.json');

  await Promise.all([
    s3Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: contentKey,
        Body: Buffer.from(content, 'utf-8'),
        ContentType: 'text/markdown',
      })
    ),
    s3Client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: sidecarKey,
        Body: Buffer.from(JSON.stringify(sidecar), 'utf-8'),
        ContentType: 'application/json',
      })
    ),
  ]);

  return { contentKey, sidecarKey };
}

/**
 * Get a preserved conflict version
 */
export async function getConflictVersion(userId, documentId, version) {
  if (!isR2Configured) {
    return sqliteGetConflictVersion(userId, documentId, version);
  }

  const contentKey = generateConflictKey(userId, documentId, version, 'content.md');
  const sidecarKey = generateConflictKey(userId, documentId, version, 'sidecar.json');

  try {
    const [contentResponse, sidecarResponse] = await Promise.all([
      s3Client.send(
        new GetObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: contentKey,
        })
      ),
      s3Client.send(
        new GetObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: sidecarKey,
        })
      ),
    ]);

    const content = await contentResponse.Body.transformToString();
    const sidecar = JSON.parse(await sidecarResponse.Body.transformToString());

    return { content, sidecar };
  } catch (error) {
    if (error.name === 'NoSuchKey') {
      return null;
    }
    throw error;
  }
}

/**
 * Delete conflict versions after resolution
 */
export async function deleteConflictVersions(userId, documentId, versions) {
  if (!isR2Configured) {
    return sqliteDeleteConflictVersions(userId, documentId, versions);
  }

  const deletePromises = [];
  for (const version of versions) {
    const contentKey = generateConflictKey(userId, documentId, version, 'content.md');
    const sidecarKey = generateConflictKey(userId, documentId, version, 'sidecar.json');

    deletePromises.push(
      s3Client.send(
        new DeleteObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: contentKey,
        })
      ),
      s3Client.send(
        new DeleteObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: sidecarKey,
        })
      )
    );
  }

  await Promise.allSettled(deletePromises);
}

/**
 * List all documents for a user (for initial sync)
 */
export async function listUserDocuments(userId) {
  if (!isR2Configured) {
    return sqliteListUserDocuments(userId);
  }

  const prefix = `users/${userId}/documents/`;
  const documents = [];
  let continuationToken;

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    if (response.Contents) {
      // Group by document ID
      const docGroups = new Map();
      for (const object of response.Contents) {
        const parts = object.Key.split('/');
        const documentId = parts[3]; // users/{userId}/documents/{documentId}/...
        if (!docGroups.has(documentId)) {
          docGroups.set(documentId, {
            documentId,
            lastModified: object.LastModified,
            size: 0,
          });
        }
        docGroups.get(documentId).size += object.Size;
      }

      documents.push(...docGroups.values());
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return documents;
}

/**
 * Get total storage usage for a user
 */
export async function getUserStorageUsage(userId) {
  if (!isR2Configured) {
    return sqliteGetUserStorageUsage(userId);
  }

  const prefix = `users/${userId}/`;
  let totalSize = 0;
  let documentCount = 0;
  let continuationToken;

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    if (response.Contents) {
      const documentIds = new Set();
      for (const object of response.Contents) {
        totalSize += object.Size;
        // Count unique document IDs
        const parts = object.Key.split('/');
        if (parts[2] === 'documents' && parts[3]) {
          documentIds.add(parts[3]);
        }
      }
      documentCount += documentIds.size;
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return { totalSize, documentCount };
}

/**
 * Generate a pre-signed URL for direct download (optional, for large files)
 */
export async function getDownloadUrl(userId, documentId, expiresIn = 3600) {
  if (!s3Client) {
    throw new Error('Pre-signed URLs require R2 storage');
  }

  const contentKey = generateKey(userId, documentId, 'content.md');

  const url = await getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: contentKey,
    }),
    { expiresIn }
  );

  return url;
}

/**
 * Check if storage is available (R2 or SQLite fallback)
 */
export function isStorageAvailable() {
  // Always available: either R2 is configured, or we fall back to SQLite
  return true;
}

export default {
  uploadDocument,
  downloadDocument,
  deleteDocument,
  deleteDocumentObjects: deleteDocument, // Alias for cleanup service
  documentExists,
  preserveVersion,
  getConflictVersion,
  deleteConflictVersions,
  listUserDocuments,
  getUserStorageUsage,
  getDownloadUrl,
  isStorageAvailable,
  hashContent,
};
