/**
 * Shared attachment and payload limits for LLM endpoints.
 *
 * Keep these values aligned with:
 * - midlight-next/packages/core/src/llm/limits.ts
 * - client-side preflight checks
 */

const MB = 1024 * 1024;

export const ATTACHMENT_LIMITS = Object.freeze({
  maxImages: 5,
  maxImageBytes: 5 * MB,
  maxDocuments: 3,
  maxDocumentBytes: 32 * MB,
  maxTextFiles: 5,
  maxTextFileBytes: 1 * MB,
  maxMultimodalPartsPerMessage: 32,
  imageMediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']),
  documentMediaTypes: Object.freeze(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  textMediaTypes: Object.freeze(['text/plain', 'text/markdown']),
});

export const REQUEST_LIMITS = Object.freeze({
  llmPayloadBytes: 50 * MB,
});

export const PDF_EXTRACTION_LIMITS = Object.freeze({
  maxPdfBytes: 32 * MB,
  maxPages: 150,
  maxTextChars: 120_000,
});
