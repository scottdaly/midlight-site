import { ATTACHMENT_LIMITS } from '../../config/attachmentLimits.js';

const BASE64_CHARS_REGEX = /^[A-Za-z0-9+/_=-]+$/;
const DATA_URL_REGEX = /^data:([^;,]+);base64,(.*)$/si;
const MAX_DOCUMENT_NAME_LENGTH = 255;
const ATTACHMENT_VALIDATION_MODES = Object.freeze({
  strict: 'strict',
  warn: 'warn',
  off: 'off',
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeMediaType(mediaType) {
  return typeof mediaType === 'string' ? mediaType.trim().toLowerCase() : '';
}

export function normalizeAttachmentValidationMode(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === ATTACHMENT_VALIDATION_MODES.strict) return ATTACHMENT_VALIDATION_MODES.strict;
  if (normalized === ATTACHMENT_VALIDATION_MODES.warn) return ATTACHMENT_VALIDATION_MODES.warn;
  if (normalized === ATTACHMENT_VALIDATION_MODES.off) return ATTACHMENT_VALIDATION_MODES.off;
  return null;
}

export function resolveAttachmentValidationMode(guardrails) {
  // Legacy kill switch remains authoritative for backwards compatibility.
  if (guardrails?.attachmentValidation === false) {
    return ATTACHMENT_VALIDATION_MODES.off;
  }

  const configuredMode = normalizeAttachmentValidationMode(guardrails?.attachmentValidationMode);
  if (configuredMode) return configuredMode;

  if (guardrails?.attachmentValidation === true) {
    return ATTACHMENT_VALIDATION_MODES.strict;
  }

  return ATTACHMENT_VALIDATION_MODES.strict;
}

/**
 * Estimate decoded byte length from a base64 string without decoding the full payload.
 */
export function estimateBase64DecodedBytes(base64Value) {
  if (typeof base64Value !== 'string') {
    throw new Error('attachment data must be a base64 string');
  }

  const trimmed = base64Value.trim();
  if (!trimmed) {
    throw new Error('attachment data must not be empty');
  }

  let mediaTypeFromDataUrl = null;
  let base64 = trimmed;

  if (trimmed.toLowerCase().startsWith('data:')) {
    const match = trimmed.match(DATA_URL_REGEX);
    if (!match) {
      throw new Error('attachment data URL must use base64 encoding');
    }
    mediaTypeFromDataUrl = normalizeMediaType(match[1]);
    base64 = match[2];
  }

  const compact = base64.replace(/\s+/g, '');
  if (!compact) {
    throw new Error('attachment data must not be empty');
  }

  // Normalize base64url alphabet to standard base64 for provider compatibility.
  const standardBase64 = compact.replace(/-/g, '+').replace(/_/g, '/');

  if (!BASE64_CHARS_REGEX.test(standardBase64)) {
    throw new Error('attachment data contains invalid base64 characters');
  }

  const firstPaddingIndex = standardBase64.indexOf('=');
  if (firstPaddingIndex !== -1) {
    const trailing = standardBase64.slice(firstPaddingIndex);
    if (/[^=]/.test(trailing)) {
      throw new Error('attachment data has invalid base64 padding');
    }
    if (trailing.length > 2) {
      throw new Error('attachment data has invalid base64 padding');
    }
  }

  const withoutPadding = standardBase64.replace(/=+$/, '');
  if (!withoutPadding) {
    throw new Error('attachment data must not be empty');
  }

  if (withoutPadding.length % 4 === 1) {
    throw new Error('attachment data has invalid base64 length');
  }

  const estimatedBytes = Math.floor((withoutPadding.length * 3) / 4);
  const missingPadding = (4 - (withoutPadding.length % 4)) % 4;
  const normalizedBase64 = `${withoutPadding}${'='.repeat(missingPadding)}`;

  return {
    estimatedBytes,
    mediaTypeFromDataUrl,
    normalizedBase64,
  };
}

function validateImagePart(part, messageIndex, partIndex) {
  const mediaType = normalizeMediaType(part.mediaType);
  if (!ATTACHMENT_LIMITS.imageMediaTypes.includes(mediaType)) {
    throw new Error(
      `messages[${messageIndex}].content[${partIndex}] uses unsupported image media type "${part.mediaType}"`
    );
  }

  const { estimatedBytes, mediaTypeFromDataUrl, normalizedBase64 } = estimateBase64DecodedBytes(part.data);
  if (mediaTypeFromDataUrl && mediaTypeFromDataUrl !== mediaType) {
    throw new Error(
      `messages[${messageIndex}].content[${partIndex}] mediaType does not match attachment data URL`
    );
  }

  if (estimatedBytes > ATTACHMENT_LIMITS.maxImageBytes) {
    throw new Error(
      `messages[${messageIndex}].content[${partIndex}] exceeds max image size (${ATTACHMENT_LIMITS.maxImageBytes} bytes)`
    );
  }

  // Canonicalize payload for downstream provider converters.
  part.data = normalizedBase64;
  part.mediaType = mediaType;
}

function validateDocumentPart(part, messageIndex, partIndex) {
  const mediaType = normalizeMediaType(part.mediaType);
  if (!ATTACHMENT_LIMITS.documentMediaTypes.includes(mediaType)) {
    throw new Error(
      `messages[${messageIndex}].content[${partIndex}] uses unsupported document media type "${part.mediaType}"`
    );
  }

  const { estimatedBytes, mediaTypeFromDataUrl, normalizedBase64 } = estimateBase64DecodedBytes(part.data);
  if (mediaTypeFromDataUrl && mediaTypeFromDataUrl !== mediaType) {
    throw new Error(
      `messages[${messageIndex}].content[${partIndex}] mediaType does not match attachment data URL`
    );
  }

  if (estimatedBytes > ATTACHMENT_LIMITS.maxDocumentBytes) {
    throw new Error(
      `messages[${messageIndex}].content[${partIndex}] exceeds max document size (${ATTACHMENT_LIMITS.maxDocumentBytes} bytes)`
    );
  }

  if (part.name !== undefined) {
    if (typeof part.name !== 'string' || part.name.trim().length === 0) {
      throw new Error(
        `messages[${messageIndex}].content[${partIndex}].name must be a non-empty string`
      );
    }
    if (part.name.length > MAX_DOCUMENT_NAME_LENGTH) {
      throw new Error(
        `messages[${messageIndex}].content[${partIndex}].name exceeds ${MAX_DOCUMENT_NAME_LENGTH} characters`
      );
    }
  }

  // Canonicalize payload for downstream provider converters.
  part.data = normalizedBase64;
  part.mediaType = mediaType;
}

function validateTextPart(part, messageIndex, partIndex) {
  if (typeof part.text !== 'string') {
    throw new Error(
      `messages[${messageIndex}].content[${partIndex}].text must be a string`
    );
  }
}

function validateTextFilePart(part, messageIndex, partIndex) {
  const mediaType = normalizeMediaType(part.mediaType);
  if (!ATTACHMENT_LIMITS.textMediaTypes.includes(mediaType)) {
    throw new Error(
      `messages[${messageIndex}].content[${partIndex}] uses unsupported text file media type "${part.mediaType}"`
    );
  }

  if (typeof part.text !== 'string' || part.text.length === 0) {
    throw new Error(
      `messages[${messageIndex}].content[${partIndex}].text must be a non-empty string`
    );
  }

  const textBytes = Buffer.byteLength(part.text, 'utf8');
  if (textBytes > ATTACHMENT_LIMITS.maxTextFileBytes) {
    throw new Error(
      `messages[${messageIndex}].content[${partIndex}] exceeds max text file size (${ATTACHMENT_LIMITS.maxTextFileBytes} bytes)`
    );
  }

  if (typeof part.name !== 'string' || part.name.trim().length === 0) {
    throw new Error(
      `messages[${messageIndex}].content[${partIndex}].name must be a non-empty string`
    );
  }
  if (part.name.length > MAX_DOCUMENT_NAME_LENGTH) {
    throw new Error(
      `messages[${messageIndex}].content[${partIndex}].name exceeds ${MAX_DOCUMENT_NAME_LENGTH} characters`
    );
  }

  part.mediaType = mediaType;
}

function validateContentPart(part, messageIndex, partIndex) {
  if (!isPlainObject(part)) {
    throw new Error(`messages[${messageIndex}].content[${partIndex}] must be an object`);
  }

  if (part.type === 'text') {
    validateTextPart(part, messageIndex, partIndex);
    return part.type;
  }

  if (part.type === 'image') {
    if (typeof part.mediaType !== 'string') {
      throw new Error(`messages[${messageIndex}].content[${partIndex}].mediaType is required`);
    }
    if (typeof part.data !== 'string') {
      throw new Error(`messages[${messageIndex}].content[${partIndex}].data is required`);
    }
    validateImagePart(part, messageIndex, partIndex);
    return part.type;
  }

  if (part.type === 'document') {
    if (typeof part.mediaType !== 'string') {
      throw new Error(`messages[${messageIndex}].content[${partIndex}].mediaType is required`);
    }
    if (typeof part.data !== 'string') {
      throw new Error(`messages[${messageIndex}].content[${partIndex}].data is required`);
    }
    validateDocumentPart(part, messageIndex, partIndex);
    return part.type;
  }

  if (part.type === 'text_file') {
    if (typeof part.mediaType !== 'string') {
      throw new Error(`messages[${messageIndex}].content[${partIndex}].mediaType is required`);
    }
    if (typeof part.text !== 'string') {
      throw new Error(`messages[${messageIndex}].content[${partIndex}].text is required`);
    }
    if (typeof part.name !== 'string') {
      throw new Error(`messages[${messageIndex}].content[${partIndex}].name is required`);
    }
    validateTextFilePart(part, messageIndex, partIndex);
    return part.type;
  }

  throw new Error(`messages[${messageIndex}].content[${partIndex}] has unknown part type "${part.type}"`);
}

/**
 * Validate multimodal message payload shape and attachment limits.
 * Throws Error on validation failures.
 */
export function validateChatMessagesForAttachments(messages) {
  if (!Array.isArray(messages)) {
    throw new Error('messages must be an array');
  }

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    const { content } = message || {};

    if (typeof content === 'string' || content === null) {
      continue;
    }

    if (!Array.isArray(content)) {
      throw new Error(`messages[${messageIndex}].content must be string, array, or null`);
    }
    if (content.length === 0) {
      throw new Error(`messages[${messageIndex}].content array must not be empty`);
    }
    if (content.length > ATTACHMENT_LIMITS.maxMultimodalPartsPerMessage) {
      throw new Error(
        `messages[${messageIndex}] exceeds multimodal content part limit (${ATTACHMENT_LIMITS.maxMultimodalPartsPerMessage})`
      );
    }

    if (message?.role !== 'user') {
      throw new Error(`messages[${messageIndex}].content array is only supported for user role`);
    }

    let imageCount = 0;
    let documentCount = 0;
    let textFileCount = 0;

    for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
      const partType = validateContentPart(content[partIndex], messageIndex, partIndex);
      if (partType === 'image') imageCount += 1;
      if (partType === 'document') documentCount += 1;
      if (partType === 'text_file') textFileCount += 1;
    }

    if (imageCount > ATTACHMENT_LIMITS.maxImages) {
      throw new Error(
        `messages[${messageIndex}] exceeds image attachment limit (${ATTACHMENT_LIMITS.maxImages})`
      );
    }

    if (documentCount > ATTACHMENT_LIMITS.maxDocuments) {
      throw new Error(
        `messages[${messageIndex}] exceeds document attachment limit (${ATTACHMENT_LIMITS.maxDocuments})`
      );
    }

    if (textFileCount > ATTACHMENT_LIMITS.maxTextFiles) {
      throw new Error(
        `messages[${messageIndex}] exceeds text file attachment limit (${ATTACHMENT_LIMITS.maxTextFiles})`
      );
    }
  }
}

/**
 * Apply attachment validation according to rollout policy.
 * - strict: throw on invalid payloads
 * - warn: return warning and continue
 * - off: skip validation
 */
export function validateChatMessagesWithPolicy(messages, { mode = ATTACHMENT_VALIDATION_MODES.strict } = {}) {
  const resolvedMode = normalizeAttachmentValidationMode(mode) || ATTACHMENT_VALIDATION_MODES.strict;

  if (resolvedMode === ATTACHMENT_VALIDATION_MODES.off) {
    return { mode: resolvedMode, warning: null };
  }

  try {
    validateChatMessagesForAttachments(messages);
    return { mode: resolvedMode, warning: null };
  } catch (error) {
    const warning = error instanceof Error ? error : new Error(String(error));
    if (resolvedMode === ATTACHMENT_VALIDATION_MODES.warn) {
      return { mode: resolvedMode, warning };
    }
    throw warning;
  }
}
