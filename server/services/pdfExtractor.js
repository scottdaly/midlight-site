import { PDFParse } from 'pdf-parse';
import { ATTACHMENT_LIMITS, PDF_EXTRACTION_LIMITS } from '../config/attachmentLimits.js';
import { estimateBase64DecodedBytes } from './llm/attachmentValidation.js';
import { incrementGuardrailMetric } from './llm/guardrailMetrics.js';

function normalizePositiveInteger(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored > 0 ? floored : fallback;
}

export function resolvePdfExtractionOptions(options = {}) {
  const maxPdfBytes = normalizePositiveInteger(
    options.maxPdfBytes,
    PDF_EXTRACTION_LIMITS.maxPdfBytes ?? ATTACHMENT_LIMITS.maxDocumentBytes
  );
  const maxPages = normalizePositiveInteger(options.maxPages, PDF_EXTRACTION_LIMITS.maxPages);
  const maxTextChars = normalizePositiveInteger(options.maxTextChars, PDF_EXTRACTION_LIMITS.maxTextChars);

  return {
    maxPdfBytes,
    maxPages,
    maxTextChars,
  };
}

/**
 * Extract text from a base64-encoded PDF.
 * Used as a fallback for providers that don't support native PDF (OpenAI, Kimi).
 *
 * @param {string} base64Data - Base64-encoded PDF data (no data: prefix)
 * @param {string} [filename] - Original filename for context
 * @param {Object} [options] - Extraction safety overrides
 * @param {number} [options.maxPdfBytes] - Maximum decoded PDF bytes accepted for extraction
 * @param {number} [options.maxPages] - Maximum PDF pages parsed
 * @param {number} [options.maxTextChars] - Maximum extracted characters retained
 * @returns {Promise<string>} Extracted text wrapped in a document block
 */
export async function extractTextFromPdf(base64Data, filename, options = {}) {
  const header = filename ? `[Document: ${filename}]` : '[Document: PDF]';
  const extractionOptions = resolvePdfExtractionOptions(options);
  let parser = null;

  try {
    const { estimatedBytes, mediaTypeFromDataUrl, normalizedBase64 } = estimateBase64DecodedBytes(base64Data);
    if (mediaTypeFromDataUrl && mediaTypeFromDataUrl !== 'application/pdf') {
      throw new Error(
        `PDF data URL must use application/pdf media type (received "${mediaTypeFromDataUrl}")`
      );
    }
    if (estimatedBytes > extractionOptions.maxPdfBytes) {
      throw new Error(
        `PDF payload exceeds max document size (${extractionOptions.maxPdfBytes} bytes)`
      );
    }

    const buffer = Buffer.from(normalizedBase64, 'base64');
    parser = new PDFParse({ data: buffer });
    const data = await parser.getText({ first: 1, last: extractionOptions.maxPages });

    const pageInfo = data.total ? `(${data.total} pages)` : '';
    let text = data.text?.trim();

    if (text && text.length > extractionOptions.maxTextChars) {
      incrementGuardrailMetric('pdfExtractionTruncated');
      text = `${text.slice(0, extractionOptions.maxTextChars)}\n\n[Text truncated at ${extractionOptions.maxTextChars.toLocaleString()} characters for size safety.]`;
    }

    if (!text) {
      return `${header} ${pageInfo}\n\n[This PDF contains no extractable text. It may be a scanned document or contain only images.]`;
    }

    return `${header} ${pageInfo}\n\n${text}`;
  } catch (error) {
    incrementGuardrailMetric('pdfExtractionFailed');
    const message = error instanceof Error ? error.message : String(error);
    return `${header}\n\n[Failed to extract text from this PDF: ${message}]`;
  } finally {
    if (parser) {
      try {
        await parser.destroy();
      } catch {
        // Ignore parser cleanup failures
      }
    }
  }
}
