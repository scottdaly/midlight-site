import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import healthRouter from '../routes/health.js';
import {
  incrementGuardrailMetric,
  resetGuardrailMetrics,
} from '../services/llm/guardrailMetrics.js';

test('health metrics endpoint includes llm guardrail counters', async (t) => {
  resetGuardrailMetrics();
  incrementGuardrailMetric('payloadRejectHttp');
  incrementGuardrailMetric('invalidRequestRejectStream');

  const app = express();
  app.use(healthRouter);
  const server = app.listen(0);
  t.after(() => {
    server.close();
    resetGuardrailMetrics();
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object' && 'port' in address);
  const response = await fetch(`http://127.0.0.1:${address.port}/health/metrics`);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.deepEqual(payload.llmGuardrails, {
    payloadRejectHttp: 1,
    payloadRejectStream: 0,
    invalidRequestRejectHttp: 0,
    invalidRequestRejectStream: 1,
    attachmentValidationWarn: 0,
    pdfExtractionTruncated: 0,
    pdfExtractionFailed: 0,
  });
});
