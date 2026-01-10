/**
 * Sync Security Utilities
 * Path validation, content sanitization, and size limits for sync operations
 */

import path from 'path';

// Maximum sizes for sync content
export const SYNC_LIMITS = {
  MAX_CONTENT_SIZE: 10 * 1024 * 1024, // 10MB max document size
  MAX_SIDECAR_SIZE: 1 * 1024 * 1024, // 1MB max sidecar size
  MAX_PATH_LENGTH: 1000, // Maximum path length
  MAX_FILENAME_LENGTH: 255, // Maximum filename length
};

// Dangerous path patterns
const DANGEROUS_PATTERNS = [
  /\.\./g, // Parent directory traversal
  /^\//, // Absolute paths
  /^[a-zA-Z]:/, // Windows drive letters
  /\0/, // Null bytes
  /[\x00-\x1f]/, // Control characters (except tab, newline)
];

// Windows reserved names (case-insensitive)
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Validate a document path for sync operations
 * Prevents path traversal and other security issues
 *
 * @param {string} inputPath - The path to validate
 * @returns {{ valid: boolean, sanitized?: string, error?: string }}
 */
export function validateSyncPath(inputPath) {
  // Must be a string
  if (typeof inputPath !== 'string') {
    return { valid: false, error: 'Path must be a string' };
  }

  // Check for null bytes
  if (inputPath.includes('\0')) {
    return { valid: false, error: 'Path contains invalid characters' };
  }

  // Check path length
  if (inputPath.length > SYNC_LIMITS.MAX_PATH_LENGTH) {
    return { valid: false, error: `Path too long (max ${SYNC_LIMITS.MAX_PATH_LENGTH} characters)` };
  }

  // Trim whitespace
  let sanitized = inputPath.trim();

  // Must not be empty
  if (sanitized.length === 0) {
    return { valid: false, error: 'Path cannot be empty' };
  }

  // Decode URL encoding to catch encoded traversal attempts (%2e%2e)
  try {
    sanitized = decodeURIComponent(sanitized);
  } catch {
    // If decoding fails, the path might have invalid encoding
    return { valid: false, error: 'Path contains invalid encoding' };
  }

  // Normalize to NFC (Unicode normalization)
  sanitized = sanitized.normalize('NFC');

  // Reject absolute paths
  if (path.isAbsolute(sanitized)) {
    return { valid: false, error: 'Absolute paths are not allowed' };
  }

  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(sanitized)) {
      return { valid: false, error: 'Path contains invalid characters or patterns' };
    }
  }

  // Normalize the path and check for traversal attempts
  const normalized = path.normalize(sanitized);

  // Check if normalization introduced traversal
  if (normalized.startsWith('..') || normalized.includes('..')) {
    return { valid: false, error: 'Path traversal is not allowed' };
  }

  // Check each path segment
  const segments = normalized.split(/[/\\]/);
  for (const segment of segments) {
    // Skip empty segments
    if (!segment) continue;

    // Check segment length
    if (segment.length > SYNC_LIMITS.MAX_FILENAME_LENGTH) {
      return { valid: false, error: `Filename too long (max ${SYNC_LIMITS.MAX_FILENAME_LENGTH} characters)` };
    }

    // Check for . and .. segments
    if (segment === '.' || segment === '..') {
      return { valid: false, error: 'Invalid path segment' };
    }

    // Check for Windows reserved names
    const baseName = segment.replace(/\.[^.]*$/, '').toLowerCase();
    if (WINDOWS_RESERVED.has(baseName)) {
      return { valid: false, error: 'Path contains reserved filename' };
    }

    // Check for trailing dots/spaces (Windows issue)
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return { valid: false, error: 'Filename cannot end with dot or space' };
    }
  }

  return { valid: true, sanitized: normalized };
}

/**
 * Sanitize sidecar content before storing
 * Removes potentially dangerous fields and enforces size limits
 *
 * @param {unknown} sidecar - The sidecar object to sanitize
 * @returns {{ valid: boolean, sanitized?: object, error?: string }}
 */
export function sanitizeSidecar(sidecar) {
  // Must be an object
  if (typeof sidecar !== 'object' || sidecar === null || Array.isArray(sidecar)) {
    return { valid: false, error: 'Sidecar must be an object' };
  }

  // Deep clone to avoid modifying original
  let sanitized;
  try {
    sanitized = JSON.parse(JSON.stringify(sidecar));
  } catch {
    return { valid: false, error: 'Sidecar contains invalid JSON data' };
  }

  // Remove potentially dangerous prototype-related fields
  const dangerousFields = ['__proto__', 'constructor', 'prototype'];
  removeDangerousFields(sanitized, dangerousFields);

  // Check size after sanitization
  const sizeBytes = Buffer.byteLength(JSON.stringify(sanitized), 'utf-8');
  if (sizeBytes > SYNC_LIMITS.MAX_SIDECAR_SIZE) {
    return {
      valid: false,
      error: `Sidecar too large (${formatBytes(sizeBytes)}, max ${formatBytes(SYNC_LIMITS.MAX_SIDECAR_SIZE)})`,
    };
  }

  return { valid: true, sanitized };
}

/**
 * Recursively remove dangerous fields from an object
 */
function removeDangerousFields(obj, fields) {
  if (typeof obj !== 'object' || obj === null) return;

  for (const field of fields) {
    delete obj[field];
  }

  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      removeDangerousFields(obj[key], fields);
    }
  }
}

/**
 * Validate content size
 *
 * @param {string} content - The document content
 * @returns {{ valid: boolean, sizeBytes?: number, error?: string }}
 */
export function validateContentSize(content) {
  if (typeof content !== 'string') {
    return { valid: false, error: 'Content must be a string' };
  }

  const sizeBytes = Buffer.byteLength(content, 'utf-8');

  if (sizeBytes > SYNC_LIMITS.MAX_CONTENT_SIZE) {
    return {
      valid: false,
      error: `Document too large (${formatBytes(sizeBytes)}, max ${formatBytes(SYNC_LIMITS.MAX_CONTENT_SIZE)})`,
      sizeBytes,
    };
  }

  return { valid: true, sizeBytes };
}

/**
 * Format bytes as human-readable string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Create express-validator custom validators
 */
export const syncValidators = {
  /**
   * Custom validator for path field
   */
  isValidSyncPath: (value) => {
    const result = validateSyncPath(value);
    if (!result.valid) {
      throw new Error(result.error);
    }
    return true;
  },

  /**
   * Custom validator for content size
   */
  isValidContentSize: (value) => {
    const result = validateContentSize(value);
    if (!result.valid) {
      throw new Error(result.error);
    }
    return true;
  },

  /**
   * Custom validator for sidecar
   */
  isValidSidecar: (value) => {
    const result = sanitizeSidecar(value);
    if (!result.valid) {
      throw new Error(result.error);
    }
    return true;
  },
};

export default {
  SYNC_LIMITS,
  validateSyncPath,
  sanitizeSidecar,
  validateContentSize,
  syncValidators,
};
