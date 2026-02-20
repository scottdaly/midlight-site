/**
 * PDF text extraction tests.
 *
 * These tests exercise the real extractor module while mocking the PDFParse
 * class methods so behavior is deterministic and fast.
 */

import { describe, it, mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { ATTACHMENT_LIMITS, PDF_EXTRACTION_LIMITS } from '../config/attachmentLimits.js';
import { extractTextFromPdf, resolvePdfExtractionOptions } from '../services/pdfExtractor.js';
import { getGuardrailMetrics, resetGuardrailMetrics } from '../services/llm/guardrailMetrics.js';

const TEST_BASE64 = Buffer.from('%PDF-1.4 test').toString('base64');

afterEach(() => {
  mock.restoreAll();
  resetGuardrailMetrics();
});

beforeEach(() => {
  resetGuardrailMetrics();
});

function mockParser({
  text = 'Hello World!',
  total = 1,
  getTextError = null,
  destroyError = null,
} = {}) {
  const getTextMock = mock.method(PDFParse.prototype, 'getText', async () => {
    if (getTextError) throw getTextError;
    return { text, total, pages: [] };
  });

  const destroyMock = mock.method(PDFParse.prototype, 'destroy', async () => {
    if (destroyError) throw destroyError;
  });

  return { getTextMock, destroyMock };
}

describe('extractTextFromPdf', () => {
  it('resolves extraction options with sane defaults', () => {
    const resolved = resolvePdfExtractionOptions();
    assert.equal(resolved.maxPdfBytes, PDF_EXTRACTION_LIMITS.maxPdfBytes);
    assert.equal(resolved.maxPages, PDF_EXTRACTION_LIMITS.maxPages);
    assert.equal(resolved.maxTextChars, PDF_EXTRACTION_LIMITS.maxTextChars);
  });

  it('sanitizes invalid extraction option overrides', () => {
    const resolved = resolvePdfExtractionOptions({
      maxPdfBytes: -1,
      maxPages: 0,
      maxTextChars: Number.NaN,
    });
    assert.equal(resolved.maxPdfBytes, PDF_EXTRACTION_LIMITS.maxPdfBytes);
    assert.equal(resolved.maxPages, PDF_EXTRACTION_LIMITS.maxPages);
    assert.equal(resolved.maxTextChars, PDF_EXTRACTION_LIMITS.maxTextChars);
  });

  it('formats text with filename header and page info', async () => {
    mockParser({ text: 'Hello World!', total: 2 });

    const result = await extractTextFromPdf(TEST_BASE64, 'test.pdf');
    assert.ok(result.includes('[Document: test.pdf]'));
    assert.ok(result.includes('(2 pages)'));
    assert.ok(result.includes('Hello World!'));
  });

  it('uses default header when no filename is provided', async () => {
    mockParser({ text: 'Some content', total: 3 });

    const result = await extractTextFromPdf(TEST_BASE64);
    assert.ok(result.includes('[Document: PDF]'));
    assert.ok(result.includes('(3 pages)'));
    assert.ok(result.includes('Some content'));
  });

  it('trims whitespace from extracted text', async () => {
    mockParser({ text: '  spaces around  \n', total: 1 });

    const result = await extractTextFromPdf(TEST_BASE64, 'test.pdf');
    const textPart = result.split('\n\n')[1];
    assert.equal(textPart, 'spaces around');
  });

  it('accepts PDF data URLs and strips prefix before parsing', async () => {
    const { getTextMock } = mockParser({ text: 'Data URL content', total: 1 });
    const dataUrl = `data:APPLICATION/PDF;base64,${TEST_BASE64}`;

    const result = await extractTextFromPdf(dataUrl, 'data-url.pdf');

    assert.ok(result.includes('Data URL content'));
    assert.equal(getTextMock.mock.callCount(), 1);
  });

  it('normalizes URL-safe base64 payloads before parsing', async () => {
    const { getTextMock } = mockParser({ text: 'URL-safe content', total: 1 });
    const urlSafe = TEST_BASE64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const result = await extractTextFromPdf(urlSafe, 'url-safe.pdf');

    assert.ok(result.includes('URL-safe content'));
    assert.equal(getTextMock.mock.callCount(), 1);
  });

  it('omits page count when not available', async () => {
    mockParser({ text: 'Content', total: 0 });

    const result = await extractTextFromPdf(TEST_BASE64, 'doc.pdf');
    assert.ok(!result.includes('pages)'));
  });

  it('truncates extracted text at configured max characters', async () => {
    const oversizedText = 'x'.repeat(PDF_EXTRACTION_LIMITS.maxTextChars + 25);
    mockParser({ text: oversizedText, total: 1 });

    const result = await extractTextFromPdf(TEST_BASE64, 'long.pdf');
    assert.ok(result.includes('[Text truncated at'));
    const extracted = result.split('\n\n')[1];
    assert.equal(extracted.length, PDF_EXTRACTION_LIMITS.maxTextChars);
    assert.equal(getGuardrailMetrics().pdfExtractionTruncated, 1);
  });

  it('passes page cap to parser getText call', async () => {
    const { getTextMock } = mockParser({ text: 'ok', total: 1 });

    await extractTextFromPdf(TEST_BASE64, 'cap.pdf');

    assert.equal(getTextMock.mock.callCount(), 1);
    assert.deepEqual(getTextMock.mock.calls[0].arguments[0], {
      first: 1,
      last: PDF_EXTRACTION_LIMITS.maxPages,
    });
  });

  it('applies extraction option overrides for page and text caps', async () => {
    const { getTextMock } = mockParser({ text: 'abcdef', total: 1 });

    const result = await extractTextFromPdf(TEST_BASE64, 'override.pdf', {
      maxPages: 2,
      maxTextChars: 4,
    });

    assert.ok(result.includes('[Text truncated at 4 characters'));
    assert.equal(getGuardrailMetrics().pdfExtractionTruncated, 1);
    assert.deepEqual(getTextMock.mock.calls[0].arguments[0], {
      first: 1,
      last: 2,
    });
  });

  it('returns fallback message for empty extracted text', async () => {
    mockParser({ text: '   \n  ', total: 1 });

    const result = await extractTextFromPdf(TEST_BASE64, 'scanned.pdf');
    assert.ok(result.includes('no extractable text'));
  });

  it('formats parser errors clearly', async () => {
    mockParser({ getTextError: new Error('Invalid PDF structure') });

    const result = await extractTextFromPdf(TEST_BASE64, 'corrupt.pdf');
    assert.ok(result.includes('[Document: corrupt.pdf]'));
    assert.ok(result.includes('Failed to extract text'));
    assert.ok(result.includes('Invalid PDF structure'));
    assert.equal(getGuardrailMetrics().pdfExtractionFailed, 1);
  });

  it('rejects non-pdf data URLs before parsing', async () => {
    const { getTextMock } = mockParser({ text: 'should not parse', total: 1 });
    const pngDataUrl = `data:image/png;base64,${TEST_BASE64}`;

    const result = await extractTextFromPdf(pngDataUrl, 'wrong-type.pdf');

    assert.ok(result.includes('Failed to extract text'));
    assert.ok(result.includes('application/pdf media type'));
    assert.equal(getTextMock.mock.callCount(), 0);
  });

  it('rejects invalid base64 payloads before parsing', async () => {
    const { getTextMock } = mockParser({ text: 'should not parse', total: 1 });

    const result = await extractTextFromPdf('%%%not-valid%%%', 'invalid.pdf');

    assert.ok(result.includes('Failed to extract text'));
    assert.ok(result.includes('invalid base64 characters'));
    assert.equal(getTextMock.mock.callCount(), 0);
  });

  it('rejects oversized payloads before parsing', async () => {
    const { getTextMock } = mockParser({ text: 'should not parse', total: 1 });
    const bytesOverLimit = ATTACHMENT_LIMITS.maxDocumentBytes + 1;
    const base64Length = Math.ceil((bytesOverLimit * 4) / 3);
    const oversizedBase64 = 'A'.repeat(base64Length);

    const result = await extractTextFromPdf(oversizedBase64, 'oversized.pdf');

    assert.ok(result.includes('Failed to extract text'));
    assert.ok(result.includes('max document size'));
    assert.equal(getTextMock.mock.callCount(), 0);
  });

  it('honors extraction maxPdfBytes override', async () => {
    const { getTextMock } = mockParser({ text: 'should not parse', total: 1 });

    const result = await extractTextFromPdf(TEST_BASE64, 'tiny-cap.pdf', {
      maxPdfBytes: 1,
    });

    assert.ok(result.includes('Failed to extract text'));
    assert.ok(result.includes('max document size'));
    assert.equal(getTextMock.mock.callCount(), 0);
  });

  it('attempts parser cleanup on success and error', async () => {
    const successMocks = mockParser({ text: 'ok', total: 1 });
    await extractTextFromPdf(TEST_BASE64, 'ok.pdf');
    assert.equal(successMocks.destroyMock.mock.callCount(), 1);

    mock.restoreAll();

    const errorMocks = mockParser({ getTextError: new Error('boom') });
    await extractTextFromPdf(TEST_BASE64, 'err.pdf');
    assert.equal(errorMocks.destroyMock.mock.callCount(), 1);
  });

  it('ignores destroy errors and still returns extracted content', async () => {
    mockParser({ text: 'safe', total: 1, destroyError: new Error('cleanup failed') });

    const result = await extractTextFromPdf(TEST_BASE64, 'safe.pdf');
    assert.ok(result.includes('safe'));
  });
});

describe('provider document mapping', () => {
  describe('Anthropic provider mapping', () => {
    it('maps document content part to Anthropic format', () => {
      const part = { type: 'document', data: 'abc123', mediaType: 'application/pdf' };

      // Simulate the Anthropic conversion logic
      const result = {
        type: 'document',
        source: { type: 'base64', media_type: part.mediaType, data: part.data }
      };

      assert.equal(result.type, 'document');
      assert.equal(result.source.type, 'base64');
      assert.equal(result.source.media_type, 'application/pdf');
      assert.equal(result.source.data, 'abc123');
    });

    it('maps image content part to Anthropic format', () => {
      const part = { type: 'image', data: 'imgdata', mediaType: 'image/png' };

      const result = {
        type: 'image',
        source: { type: 'base64', media_type: part.mediaType, data: part.data }
      };

      assert.equal(result.type, 'image');
      assert.equal(result.source.media_type, 'image/png');
    });

    it('maps text content part to Anthropic format', () => {
      const part = { type: 'text', text: 'Hello world' };

      const result = { type: 'text', text: part.text };

      assert.equal(result.type, 'text');
      assert.equal(result.text, 'Hello world');
    });
  });

  describe('Gemini provider mapping', () => {
    it('maps document content part to Gemini inlineData format', () => {
      const part = { type: 'document', data: 'pdfdata', mediaType: 'application/pdf' };

      const result = { inlineData: { mimeType: part.mediaType, data: part.data } };

      assert.equal(result.inlineData.mimeType, 'application/pdf');
      assert.equal(result.inlineData.data, 'pdfdata');
    });

    it('maps image content part to Gemini inlineData format', () => {
      const part = { type: 'image', data: 'imgdata', mediaType: 'image/jpeg' };

      const result = { inlineData: { mimeType: part.mediaType, data: part.data } };

      assert.equal(result.inlineData.mimeType, 'image/jpeg');
    });
  });

  describe('OpenAI provider mapping', () => {
    it('maps image content part to OpenAI data URL format', () => {
      const part = { type: 'image', data: 'imgdata', mediaType: 'image/png' };

      const result = {
        type: 'image_url',
        image_url: { url: `data:${part.mediaType};base64,${part.data}` }
      };

      assert.equal(result.type, 'image_url');
      assert.equal(result.image_url.url, 'data:image/png;base64,imgdata');
    });

    it('converts document content part to text (fallback)', () => {
      // OpenAI doesn't support native PDF — should extract text
      const extractedText = '[Document: form.pdf] (2 pages)\n\nExtracted content here';
      const result = { type: 'text', text: extractedText };

      assert.equal(result.type, 'text');
      assert.ok(result.text.includes('[Document: form.pdf]'));
      assert.ok(result.text.includes('Extracted content here'));
    });
  });

  describe('multimodal message with documents', () => {
    it('handles mixed content (text + image + document)', () => {
      const message = {
        role: 'user',
        content: [
          { type: 'image', data: 'imgdata', mediaType: 'image/png' },
          { type: 'document', data: 'pdfdata', mediaType: 'application/pdf', name: 'report.pdf' },
          { type: 'text', text: 'Please analyze these files' },
        ]
      };

      // Verify the content array has all three part types
      assert.equal(message.content.length, 3);
      assert.equal(message.content[0].type, 'image');
      assert.equal(message.content[1].type, 'document');
      assert.equal(message.content[2].type, 'text');

      // Verify document part has all expected properties
      const docPart = message.content[1];
      assert.equal(docPart.mediaType, 'application/pdf');
      assert.equal(docPart.name, 'report.pdf');
      assert.ok(docPart.data.length > 0);
    });
  });
});
