/**
 * R2 Storage Service
 * Handles document storage in Cloudflare R2 using S3-compatible API
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

// R2 Configuration
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'midlight-documents';

// Check if R2 is configured
const isR2Configured = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY;

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

/**
 * Upload document content to R2
 */
export async function uploadDocument(userId, documentId, content, sidecar) {
  if (!s3Client) {
    throw new Error('R2 storage not configured');
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
 * Download document from R2
 */
export async function downloadDocument(userId, documentId) {
  if (!s3Client) {
    throw new Error('R2 storage not configured');
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
 * Delete document from R2
 */
export async function deleteDocument(userId, documentId) {
  if (!s3Client) {
    throw new Error('R2 storage not configured');
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
 * Check if a document exists in R2
 */
export async function documentExists(userId, documentId) {
  if (!s3Client) {
    return false;
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
  if (!s3Client) {
    throw new Error('R2 storage not configured');
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
  if (!s3Client) {
    throw new Error('R2 storage not configured');
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
  if (!s3Client) {
    return;
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
  if (!s3Client) {
    return [];
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
  if (!s3Client) {
    return { totalSize: 0, documentCount: 0 };
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
    throw new Error('R2 storage not configured');
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
 * Check if R2 is configured and available
 */
export function isStorageAvailable() {
  return isR2Configured && s3Client !== null;
}

export default {
  uploadDocument,
  downloadDocument,
  deleteDocument,
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
