import pdf from 'pdf-parse/lib/pdf-parse.js';

/**
 * Extract text from a base64-encoded PDF.
 * Used as a fallback for providers that don't support native PDF (OpenAI, Kimi).
 *
 * @param {string} base64Data - Base64-encoded PDF data (no data: prefix)
 * @param {string} [filename] - Original filename for context
 * @returns {Promise<string>} Extracted text wrapped in a document block
 */
export async function extractTextFromPdf(base64Data, filename) {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const data = await pdf(buffer);

    const header = filename ? `[Document: ${filename}]` : '[Document: PDF]';
    const pageInfo = data.numpages ? `(${data.numpages} pages)` : '';
    const text = data.text?.trim();

    if (!text) {
      return `${header} ${pageInfo}\n\n[This PDF contains no extractable text. It may be a scanned document or contain only images.]`;
    }

    return `${header} ${pageInfo}\n\n${text}`;
  } catch (error) {
    const header = filename ? `[Document: ${filename}]` : '[Document: PDF]';
    return `${header}\n\n[Failed to extract text from this PDF: ${error.message}]`;
  }
}
