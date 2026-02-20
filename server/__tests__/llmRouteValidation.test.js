import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validationResult } from 'express-validator';
import CONFIG from '../config/index.js';
import { getGuardrailMetrics, resetGuardrailMetrics } from '../services/llm/guardrailMetrics.js';
import { __private as llmRoutePrivate } from '../routes/llm.js';

const {
  chatValidation,
  chatWithToolsValidation,
  returnValidationErrorIfAny,
  returnKnownLlmErrorIfAny,
  formatStreamErrorPayload,
  writeStreamErrorAndEnd,
  normalizeRequestType,
  getAttachmentValidationMode,
  isAttachmentValidationEnabled,
} = llmRoutePrivate;

async function runValidation(chains, body) {
  const req = { body };
  for (const chain of chains) {
    await chain.run(req);
  }
  return { req, errors: validationResult(req).array() };
}

describe('llm route validation chains', () => {
  const smallBase64 = Buffer.from('hello').toString('base64');

  it('accepts valid chat payloads with multimodal user content', async () => {
    const { errors } = await runValidation(chatValidation, {
      provider: 'openai',
      model: 'gpt-5-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', mediaType: 'image/png', data: smallBase64 },
            { type: 'document', mediaType: 'application/pdf', data: smallBase64, name: 'input.pdf' },
            { type: 'text', text: 'Please summarize.' },
          ],
        },
      ],
    });

    assert.equal(errors.length, 0);
  });

  it('accepts url-safe base64 payloads for chat validation', async () => {
    const { errors } = await runValidation(chatValidation, {
      provider: 'openai',
      model: 'gpt-5-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', mediaType: 'application/pdf', data: 'SGVsbG8_', name: 'urlsafe.pdf' },
            { type: 'text', text: 'check this' },
          ],
        },
      ],
    });

    assert.equal(errors.length, 0);
  });

  it('rejects multimodal arrays on non-user roles', async () => {
    const { errors } = await runValidation(chatValidation, {
      provider: 'openai',
      model: 'gpt-5-mini',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'not allowed' }],
        },
      ],
    });

    assert.ok(errors.some((e) => String(e.msg).includes('only supported for user role')));
  });

  it('can disable attachment validation via guardrail kill switch', async () => {
    const original = CONFIG.llm.guardrails.attachmentValidation;
    const originalMode = CONFIG.llm.guardrails.attachmentValidationMode;
    CONFIG.llm.guardrails.attachmentValidation = false;

    try {
      const { errors } = await runValidation(chatValidation, {
        provider: 'openai',
        model: 'gpt-5-mini',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'not allowed when validation is on' }],
          },
        ],
      });

      assert.equal(isAttachmentValidationEnabled(), false);
      assert.equal(getAttachmentValidationMode(), 'off');
      assert.equal(errors.length, 0);
    } finally {
      CONFIG.llm.guardrails.attachmentValidation = original;
      CONFIG.llm.guardrails.attachmentValidationMode = originalMode;
    }
  });

  it('supports warn-only mode without rejecting route validation', async () => {
    const original = CONFIG.llm.guardrails.attachmentValidation;
    const originalMode = CONFIG.llm.guardrails.attachmentValidationMode;
    CONFIG.llm.guardrails.attachmentValidation = true;
    CONFIG.llm.guardrails.attachmentValidationMode = 'warn';

    try {
      const { errors } = await runValidation(chatValidation, {
        provider: 'openai',
        model: 'gpt-5-mini',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'normally invalid in strict mode' }],
          },
        ],
      });

      assert.equal(getAttachmentValidationMode(), 'warn');
      assert.equal(isAttachmentValidationEnabled(), true);
      assert.equal(errors.length, 0);
    } finally {
      CONFIG.llm.guardrails.attachmentValidation = original;
      CONFIG.llm.guardrails.attachmentValidationMode = originalMode;
    }
  });

  it('rejects empty multimodal content arrays', async () => {
    const { errors } = await runValidation(chatValidation, {
      provider: 'openai',
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: [] }],
    });

    assert.ok(errors.some((e) => String(e.msg).includes('must not be empty')));
  });

  it('rejects chat-with-tools payloads without tools', async () => {
    const { errors } = await runValidation(chatWithToolsValidation, {
      provider: 'openai',
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'hello' }],
    });

    assert.ok(errors.some((e) => String(e.msg).includes('Tools array required')));
  });

  it('accepts url-safe base64 payloads for chat-with-tools validation', async () => {
    const { errors } = await runValidation(chatWithToolsValidation, {
      provider: 'openai',
      model: 'gpt-5-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', mediaType: 'application/pdf', data: 'SGVsbG8_', name: 'urlsafe-tool.pdf' },
            { type: 'text', text: 'run tool' },
          ],
        },
      ],
      tools: [
        {
          name: 'test_tool',
          description: 'Test tool',
          parameters: { type: 'object', properties: {} },
        },
      ],
    });

    assert.equal(errors.length, 0);
  });
});

describe('llm validation error response', () => {
  it('returns standardized invalid request payload with first message', async () => {
    const { req } = await runValidation(chatValidation, {
      provider: 'openai',
      model: 'gpt-5-mini',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'nope' }] }],
    });

    const captured = {
      status: null,
      payload: null,
    };
    const res = {
      status(code) {
        captured.status = code;
        return this;
      },
      json(payload) {
        captured.payload = payload;
        return this;
      },
    };

    const handled = returnValidationErrorIfAny(req, res);
    assert.equal(handled, true);
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.code, 'INVALID_REQUEST');
    assert.equal(captured.payload.error, captured.payload.message);
    assert.equal(Array.isArray(captured.payload.errors), true);
    assert.ok(String(captured.payload.message).includes('only supported for user role'));
  });
});

describe('llm known error response', () => {
  function createResCapture() {
    const captured = { status: null, payload: null };
    const res = {
      status(code) {
        captured.status = code;
        return this;
      },
      json(payload) {
        captured.payload = payload;
        return this;
      },
    };
    return { res, captured };
  }

  it('maps INVALID_REQUEST to a structured 400 response', () => {
    resetGuardrailMetrics();
    const { res, captured } = createResCapture();

    const handled = returnKnownLlmErrorIfAny(res, {
      code: 'INVALID_REQUEST',
      message: 'messages[0].content array must not be empty',
    });

    assert.equal(handled, true);
    assert.equal(captured.status, 400);
    assert.equal(captured.payload.code, 'INVALID_REQUEST');
    assert.equal(captured.payload.error, 'messages[0].content array must not be empty');
    assert.equal(captured.payload.message, 'messages[0].content array must not be empty');
    assert.equal(getGuardrailMetrics().invalidRequestRejectHttp, 1);
  });

  it('maps QUOTA_EXCEEDED to 429', () => {
    const { res, captured } = createResCapture();
    const quota = { used: 123, limit: 456 };

    const handled = returnKnownLlmErrorIfAny(res, {
      code: 'QUOTA_EXCEEDED',
      quota,
    });

    assert.equal(handled, true);
    assert.equal(captured.status, 429);
    assert.equal(captured.payload.code, 'QUOTA_EXCEEDED');
    assert.equal(captured.payload.error, 'Monthly quota exceeded');
    assert.equal(captured.payload.message, 'Monthly quota exceeded');
    assert.equal(captured.payload.quota, quota);
  });

  it('maps PAYLOAD_TOO_LARGE to 413', () => {
    resetGuardrailMetrics();
    const { res, captured } = createResCapture();

    const handled = returnKnownLlmErrorIfAny(res, {
      code: 'PAYLOAD_TOO_LARGE',
      message: 'too big',
    });

    assert.equal(handled, true);
    assert.equal(captured.status, 413);
    assert.equal(captured.payload.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(captured.payload.error, 'Request payload too large. Try fewer images or smaller files.');
    assert.equal(captured.payload.message, 'Request payload too large. Try fewer images or smaller files.');
    assert.equal(getGuardrailMetrics().payloadRejectHttp, 1);
  });

  it('returns false for unknown errors', () => {
    const { res, captured } = createResCapture();

    const handled = returnKnownLlmErrorIfAny(res, new Error('boom'));

    assert.equal(handled, false);
    assert.equal(captured.status, null);
    assert.equal(captured.payload, null);
  });
});

describe('llm stream error payload formatting', () => {
  it('formats quota errors consistently', () => {
    const quota = { used: 10, limit: 100 };
    assert.deepEqual(
      formatStreamErrorPayload({ code: 'QUOTA_EXCEEDED', quota }),
      { error: 'quota_exceeded', quota }
    );
    assert.deepEqual(
      formatStreamErrorPayload({ code: 'QUOTA_EXCEEDED', quota }, true),
      { type: 'error', error: 'quota_exceeded', quota }
    );
  });

  it('formats invalid request errors consistently', () => {
    resetGuardrailMetrics();
    assert.deepEqual(
      formatStreamErrorPayload({ code: 'INVALID_REQUEST', message: 'bad payload' }),
      { error: 'invalid_request', message: 'bad payload' }
    );
    assert.deepEqual(
      formatStreamErrorPayload({ code: 'INVALID_REQUEST', message: 'bad payload' }, true),
      { type: 'error', error: 'invalid_request', message: 'bad payload' }
    );
    assert.equal(getGuardrailMetrics().invalidRequestRejectStream, 2);
  });

  it('formats payload-too-large errors consistently', () => {
    resetGuardrailMetrics();
    assert.deepEqual(
      formatStreamErrorPayload({ code: 'PAYLOAD_TOO_LARGE' }),
      { error: 'payload_too_large', message: 'Request payload too large. Try fewer images or smaller files.' }
    );
    assert.deepEqual(
      formatStreamErrorPayload({ code: 'PAYLOAD_TOO_LARGE' }, true),
      { type: 'error', error: 'payload_too_large', message: 'Request payload too large. Try fewer images or smaller files.' }
    );
    assert.equal(getGuardrailMetrics().payloadRejectStream, 2);
  });

  it('formats unknown errors with fallback message', () => {
    assert.deepEqual(
      formatStreamErrorPayload({ message: 'provider failed' }),
      { error: 'provider failed' }
    );
  });

  it('writes SSE stream errors and closes the response', () => {
    let written = '';
    let endCalled = false;
    const res = {
      write(chunk) {
        written += chunk;
      },
      end() {
        endCalled = true;
      },
    };

    writeStreamErrorAndEnd(res, { code: 'INVALID_REQUEST', message: 'bad payload' }, true);

    assert.equal(
      written,
      'data: {"type":"error","error":"invalid_request","message":"bad payload"}\n\n'
    );
    assert.equal(endCalled, true);
  });
});

describe('request type normalization', () => {
  it('accepts canonical request types', () => {
    assert.equal(normalizeRequestType('chat'), 'chat');
    assert.equal(normalizeRequestType('inline-edit'), 'inline-edit');
    assert.equal(normalizeRequestType('workflow'), 'workflow');
  });

  it('maps alias request types to canonical forms', () => {
    assert.equal(normalizeRequestType('inline_edit'), 'inline-edit');
    assert.equal(normalizeRequestType('chat_with_tools'), 'chat-with-tools');
  });

  it('falls back to chat for unknown values', () => {
    assert.equal(normalizeRequestType('classification'), 'chat');
    assert.equal(normalizeRequestType(null), 'chat');
  });
});
