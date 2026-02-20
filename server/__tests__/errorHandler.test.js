import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { errorHandler } from '../middleware/errorHandler.js';
import {
  getGuardrailMetrics,
  resetGuardrailMetrics,
} from '../services/llm/guardrailMetrics.js';

function createMockResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
  };
}

describe('errorHandler payload-too-large normalization', () => {
  it('maps entity.too.large parser errors to PAYLOAD_TOO_LARGE response', () => {
    resetGuardrailMetrics();
    const req = { path: '/api/llm/chat', method: 'POST', user: null, requestId: 'req_1' };
    const res = createMockResponse();
    const err = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
    });

    errorHandler(err, req, res, () => {});

    assert.equal(res.statusCode, 413);
    assert.equal(res.payload.status, 'error');
    assert.equal(res.payload.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(res.payload.message, 'Request payload too large. Try fewer images or smaller files.');
    assert.equal(getGuardrailMetrics().payloadRejectHttp, 1);
  });

  it('maps explicit 413 errors to PAYLOAD_TOO_LARGE response', () => {
    resetGuardrailMetrics();
    const req = { path: '/api/llm/chat-with-tools', method: 'POST', user: { id: 42 }, requestId: 'req_2' };
    const res = createMockResponse();
    const err = Object.assign(new Error('payload over limit'), {
      status: 413,
    });

    errorHandler(err, req, res, () => {});

    assert.equal(res.statusCode, 413);
    assert.equal(res.payload.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(res.payload.message, 'Request payload too large. Try fewer images or smaller files.');
    assert.equal(getGuardrailMetrics().payloadRejectHttp, 1);
  });

  it('does not increment llm guardrail metrics for non-llm routes', () => {
    resetGuardrailMetrics();
    const req = { path: '/api/sync', method: 'POST', user: { id: 42 }, requestId: 'req_3' };
    const res = createMockResponse();
    const err = Object.assign(new Error('payload over limit'), {
      status: 413,
    });

    errorHandler(err, req, res, () => {});

    assert.equal(res.statusCode, 413);
    assert.equal(res.payload.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(getGuardrailMetrics().payloadRejectHttp, 0);
  });
});
