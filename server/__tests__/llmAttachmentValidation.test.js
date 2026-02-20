import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTACHMENT_LIMITS } from '../config/attachmentLimits.js';
import {
  estimateBase64DecodedBytes,
  resolveAttachmentValidationMode,
  validateChatMessagesForAttachments,
  validateChatMessagesWithPolicy,
} from '../services/llm/attachmentValidation.js';

function base64ForBytes(byteCount) {
  const base64Length = Math.ceil(byteCount / 3) * 4;
  return 'A'.repeat(base64Length);
}

const SMALL_BASE64 = Buffer.from('hello').toString('base64');
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const contractPath = resolve(__dirname, '../../../contracts/pdf_attachment_contract.json');
const attachmentContract = JSON.parse(readFileSync(contractPath, 'utf8'));

describe('estimateBase64DecodedBytes', () => {
  it('estimates decoded bytes from plain base64', () => {
    const { estimatedBytes, mediaTypeFromDataUrl } = estimateBase64DecodedBytes(SMALL_BASE64);
    assert.equal(estimatedBytes, 5);
    assert.equal(mediaTypeFromDataUrl, null);
  });

  it('parses data URLs and returns media type', () => {
    const dataUrl = `data:image/png;base64,${SMALL_BASE64}`;
    const { estimatedBytes, mediaTypeFromDataUrl } = estimateBase64DecodedBytes(dataUrl);
    assert.equal(estimatedBytes, 5);
    assert.equal(mediaTypeFromDataUrl, 'image/png');
  });

  it('normalizes URL-safe base64 alphabet for downstream payloads', () => {
    const { estimatedBytes, normalizedBase64 } = estimateBase64DecodedBytes('SGVsbG8_');
    assert.equal(estimatedBytes, 6);
    assert.equal(normalizedBase64, 'SGVsbG8/');
  });

  it('rejects invalid base64 payloads', () => {
    assert.throws(
      () => estimateBase64DecodedBytes('%%%not-valid%%%'),
      /invalid base64 characters/i
    );
  });

  it('rejects invalid base64 padding', () => {
    assert.throws(
      () => estimateBase64DecodedBytes('aGVsbG8==='),
      /invalid base64 padding/i
    );
  });
});

describe('validateChatMessagesForAttachments', () => {
  it('accepts plain text messages', () => {
    assert.doesNotThrow(() => validateChatMessagesForAttachments([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]));
  });

  it('accepts valid multimodal content', () => {
    assert.doesNotThrow(() => validateChatMessagesForAttachments([
      {
        role: 'user',
        content: [
          { type: 'image', mediaType: 'image/png', data: SMALL_BASE64 },
          { type: 'document', mediaType: 'application/pdf', data: SMALL_BASE64, name: 'report.pdf' },
          { type: 'text', text: 'Analyze this' },
        ],
      },
    ]));
  });

  it('normalizes valid data URL payloads for downstream provider mapping', () => {
    const imageBase64 = Buffer.from('image-bytes').toString('base64');
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image', mediaType: 'IMAGE/PNG', data: `data:image/png;base64,${imageBase64}` },
        ],
      },
    ];

    assert.doesNotThrow(() => validateChatMessagesForAttachments(messages));

    const imagePart = messages[0].content[0];
    assert.equal(imagePart.mediaType, 'image/png');
    assert.equal(imagePart.data, imageBase64);
  });

  it('normalizes URL-safe base64 payloads for downstream provider mapping', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'document', mediaType: 'application/pdf', data: 'SGVsbG8_', name: 'urlsafe.pdf' },
        ],
      },
    ];

    assert.doesNotThrow(() => validateChatMessagesForAttachments(messages));
    const docPart = messages[0].content[0];
    assert.equal(docPart.data, 'SGVsbG8/');
  });

  it('rejects unknown content part types', () => {
    assert.throws(
      () => validateChatMessagesForAttachments([
        { role: 'user', content: [{ type: 'audio', data: SMALL_BASE64 }] },
      ]),
      /unknown part type/i
    );
  });

  it('rejects empty multimodal content arrays', () => {
    assert.throws(
      () => validateChatMessagesForAttachments([
        { role: 'user', content: [] },
      ]),
      /must not be empty/i
    );
  });

  it('rejects multimodal content arrays on non-user roles', () => {
    assert.throws(
      () => validateChatMessagesForAttachments([
        { role: 'assistant', content: [{ type: 'text', text: 'not allowed' }] },
      ]),
      /only supported for user role/i
    );
  });

  it('rejects unsupported image media types', () => {
    assert.throws(
      () => validateChatMessagesForAttachments([
        {
          role: 'user',
          content: [{ type: 'image', mediaType: 'image/tiff', data: SMALL_BASE64 }],
        },
      ]),
      /unsupported image media type/i
    );
  });

  it('rejects unsupported document media types', () => {
    assert.throws(
      () => validateChatMessagesForAttachments([
        {
          role: 'user',
          content: [{ type: 'document', mediaType: 'application/msword', data: SMALL_BASE64 }],
        },
      ]),
      /unsupported document media type/i
    );
  });

  it('rejects media type mismatches against data URL payloads', () => {
    const dataUrl = `data:application/pdf;base64,${SMALL_BASE64}`;
    assert.throws(
      () => validateChatMessagesForAttachments([
        {
          role: 'user',
          content: [{ type: 'image', mediaType: 'image/png', data: dataUrl }],
        },
      ]),
      /does not match attachment data URL/i
    );
  });

  it('rejects oversized images', () => {
    const oversized = base64ForBytes(ATTACHMENT_LIMITS.maxImageBytes + 1);
    assert.throws(
      () => validateChatMessagesForAttachments([
        {
          role: 'user',
          content: [{ type: 'image', mediaType: 'image/png', data: oversized }],
        },
      ]),
      /exceeds max image size/i
    );
  });

  it('rejects oversized documents', () => {
    const oversized = base64ForBytes(ATTACHMENT_LIMITS.maxDocumentBytes + 1);
    assert.throws(
      () => validateChatMessagesForAttachments([
        {
          role: 'user',
          content: [{ type: 'document', mediaType: 'application/pdf', data: oversized }],
        },
      ]),
      /exceeds max document size/i
    );
  });

  it('rejects too many images in a single message', () => {
    const content = Array.from({ length: ATTACHMENT_LIMITS.maxImages + 1 }, () => ({
      type: 'image',
      mediaType: 'image/png',
      data: SMALL_BASE64,
    }));

    assert.throws(
      () => validateChatMessagesForAttachments([{ role: 'user', content }]),
      /exceeds image attachment limit/i
    );
  });

  it('rejects too many documents in a single message', () => {
    const content = Array.from({ length: ATTACHMENT_LIMITS.maxDocuments + 1 }, () => ({
      type: 'document',
      mediaType: 'application/pdf',
      data: SMALL_BASE64,
      name: 'doc.pdf',
    }));

    assert.throws(
      () => validateChatMessagesForAttachments([{ role: 'user', content }]),
      /exceeds document attachment limit/i
    );
  });

  it('rejects invalid document names', () => {
    assert.throws(
      () => validateChatMessagesForAttachments([
        {
          role: 'user',
          content: [{ type: 'document', mediaType: 'application/pdf', data: SMALL_BASE64, name: '   ' }],
        },
      ]),
      /name must be a non-empty string/i
    );
  });

  it('matches shared contract validation vectors', () => {
    for (const vector of attachmentContract.validationVectors.valid) {
      const messages = JSON.parse(JSON.stringify(vector.messages));
      assert.doesNotThrow(() => validateChatMessagesForAttachments(messages), vector.name);
    }

    for (const vector of attachmentContract.validationVectors.invalid) {
      const messages = JSON.parse(JSON.stringify(vector.messages));
      assert.throws(
        () => validateChatMessagesForAttachments(messages),
        new RegExp(vector.errorIncludes || 'invalid', 'i'),
        vector.name
      );
    }
  });
});

describe('attachment validation rollout policy', () => {
  it('resolves strict mode by default', () => {
    assert.equal(resolveAttachmentValidationMode(undefined), 'strict');
  });

  it('resolves warn mode from guardrail config', () => {
    assert.equal(
      resolveAttachmentValidationMode({ attachmentValidationMode: 'warn' }),
      'warn'
    );
  });

  it('legacy kill switch overrides to off', () => {
    assert.equal(
      resolveAttachmentValidationMode({ attachmentValidationMode: 'warn', attachmentValidation: false }),
      'off'
    );
  });

  it('returns warning instead of throwing in warn mode', () => {
    const result = validateChatMessagesWithPolicy(
      [{ role: 'assistant', content: [{ type: 'text', text: 'not allowed' }] }],
      { mode: 'warn' }
    );
    assert.equal(result.mode, 'warn');
    assert.ok(result.warning instanceof Error);
    assert.ok(result.warning.message.includes('only supported for user role'));
  });

  it('skips validation in off mode', () => {
    const result = validateChatMessagesWithPolicy(
      [{ role: 'assistant', content: [{ type: 'text', text: 'not allowed' }] }],
      { mode: 'off' }
    );
    assert.equal(result.mode, 'off');
    assert.equal(result.warning, null);
  });
});
