import mammoth from 'mammoth';
import { ATTACHMENT_LIMITS } from '../config/attachmentLimits.js';
import { incrementGuardrailMetric } from './llm/guardrailMetrics.js';

const MAX_TEXT_CHARS = 120_000;

/**
 * Extract text from a base64-encoded DOCX file.
 * Used for all providers since none support native DOCX.
 *
 * @param {string} base64Data - Base64-encoded DOCX data (no data: prefix)
 * @param {string} [filename] - Original filename for context
 * @returns {Promise<string>} Extracted text wrapped in a document block
 */
export async function extractTextFromDocx(base64Data, filename) {
  const header = filename ? `[Document: ${filename}]` : '[Document: DOCX]';

  try {
    if (typeof base64Data !== 'string' || base64Data.trim().length === 0) {
      throw new Error('DOCX data must be a non-empty base64 string');
    }

    const buffer = Buffer.from(base64Data, 'base64');

    if (buffer.length > ATTACHMENT_LIMITS.maxDocumentBytes) {
      throw new Error(
        `DOCX payload exceeds max document size (${ATTACHMENT_LIMITS.maxDocumentBytes} bytes)`
      );
    }

    const result = await mammoth.extractRawText({ buffer });
    let text = result.value?.trim();

    if (text && text.length > MAX_TEXT_CHARS) {
      incrementGuardrailMetric('docxExtractionTruncated');
      text = `${text.slice(0, MAX_TEXT_CHARS)}\n\n[Text truncated at ${MAX_TEXT_CHARS.toLocaleString()} characters for size safety.]`;
    }

    if (!text) {
      return `${header}\n\n[This DOCX file contains no extractable text.]`;
    }

    return `${header}\n\n${text}`;
  } catch (error) {
    incrementGuardrailMetric('docxExtractionFailed');
    const message = error instanceof Error ? error.message : String(error);
    return `${header}\n\n[Failed to extract text from this DOCX: ${message}]`;
  }
}
