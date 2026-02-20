import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config/index.js';
import {
  ATTACHMENT_LIMITS,
  REQUEST_LIMITS,
  PDF_EXTRACTION_LIMITS,
} from '../config/attachmentLimits.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const contractPath = resolve(__dirname, '../../../contracts/pdf_attachment_contract.json');
const attachmentContract = JSON.parse(readFileSync(contractPath, 'utf8'));

describe('attachment and payload limits', () => {
  it('uses a shared LLM request payload limit in backend config', () => {
    assert.equal(CONFIG.requestLimits.llm, REQUEST_LIMITS.llmPayloadBytes);
  });

  it('defines sane attachment bounds', () => {
    assert.equal(ATTACHMENT_LIMITS.maxImages, attachmentContract.limits.maxImages);
    assert.equal(ATTACHMENT_LIMITS.maxDocuments, attachmentContract.limits.maxDocuments);
    assert.equal(ATTACHMENT_LIMITS.maxImageBytes, attachmentContract.limits.maxImageBytes);
    assert.equal(ATTACHMENT_LIMITS.maxDocumentBytes, attachmentContract.limits.maxDocumentBytes);
    assert.equal(
      ATTACHMENT_LIMITS.maxMultimodalPartsPerMessage,
      attachmentContract.limits.maxMultimodalPartsPerMessage
    );
    assert.deepEqual(ATTACHMENT_LIMITS.imageMediaTypes, attachmentContract.limits.imageMediaTypes);
    assert.deepEqual(ATTACHMENT_LIMITS.documentMediaTypes, attachmentContract.limits.documentMediaTypes);
    assert.equal(REQUEST_LIMITS.llmPayloadBytes, attachmentContract.limits.maxPayloadBytes);
  });

  it('defines extraction safety bounds', () => {
    assert.equal(PDF_EXTRACTION_LIMITS.maxPdfBytes, attachmentContract.limits.maxExtractionPdfBytes);
    assert.equal(PDF_EXTRACTION_LIMITS.maxPages, attachmentContract.limits.maxExtractionPages);
    assert.equal(PDF_EXTRACTION_LIMITS.maxTextChars, attachmentContract.limits.maxExtractionTextChars);
  });
});
