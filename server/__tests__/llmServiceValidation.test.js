import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import CONFIG from '../config/index.js';
import { __private as llmServicePrivate } from '../services/llm/index.js';
import { getGuardrailMetrics, resetGuardrailMetrics } from '../services/llm/guardrailMetrics.js';

describe('llm service message validation guard', () => {
  const { validateMessagesOrThrow, getAttachmentValidationMode } = llmServicePrivate;

  it('accepts valid user multimodal payloads', () => {
    const smallBase64 = Buffer.from('ok').toString('base64');
    assert.doesNotThrow(() =>
      validateMessagesOrThrow([
        {
          role: 'user',
          content: [
            { type: 'image', mediaType: 'image/png', data: smallBase64 },
            { type: 'document', mediaType: 'application/pdf', data: smallBase64, name: 'form.pdf' },
            { type: 'text', text: 'fill this' },
          ],
        },
      ])
    );
  });

  it('throws INVALID_REQUEST for malformed attachment payloads', () => {
    assert.throws(
      () =>
        validateMessagesOrThrow([
          {
            role: 'assistant',
            content: [{ type: 'document', mediaType: 'application/pdf', data: 'cGRm' }],
          },
        ]),
      (error) => {
        assert.equal(error?.code, 'INVALID_REQUEST');
        assert.ok(String(error?.message).includes('only supported for user role'));
        return true;
      }
    );
  });

  it('accepts malformed payloads in warn mode and records warning metric', () => {
    const originalEnabled = CONFIG.llm.guardrails.attachmentValidation;
    const originalMode = CONFIG.llm.guardrails.attachmentValidationMode;
    resetGuardrailMetrics();
    CONFIG.llm.guardrails.attachmentValidation = true;
    CONFIG.llm.guardrails.attachmentValidationMode = 'warn';

    try {
      assert.equal(getAttachmentValidationMode(), 'warn');
      assert.doesNotThrow(() =>
        validateMessagesOrThrow([
          {
            role: 'assistant',
            content: [{ type: 'document', mediaType: 'application/pdf', data: 'cGRm' }],
          },
        ])
      );
      assert.equal(getGuardrailMetrics().attachmentValidationWarn, 1);
    } finally {
      CONFIG.llm.guardrails.attachmentValidation = originalEnabled;
      CONFIG.llm.guardrails.attachmentValidationMode = originalMode;
      resetGuardrailMetrics();
    }
  });

  it('skips attachment validation entirely when mode is off', () => {
    const originalEnabled = CONFIG.llm.guardrails.attachmentValidation;
    const originalMode = CONFIG.llm.guardrails.attachmentValidationMode;
    resetGuardrailMetrics();
    CONFIG.llm.guardrails.attachmentValidation = false;
    CONFIG.llm.guardrails.attachmentValidationMode = 'strict';

    try {
      assert.equal(getAttachmentValidationMode(), 'off');
      assert.doesNotThrow(() =>
        validateMessagesOrThrow([
          {
            role: 'assistant',
            content: [{ type: 'document', mediaType: 'application/pdf', data: 'cGRm' }],
          },
        ])
      );
      assert.equal(getGuardrailMetrics().attachmentValidationWarn, 0);
    } finally {
      CONFIG.llm.guardrails.attachmentValidation = originalEnabled;
      CONFIG.llm.guardrails.attachmentValidationMode = originalMode;
      resetGuardrailMetrics();
    }
  });
});
