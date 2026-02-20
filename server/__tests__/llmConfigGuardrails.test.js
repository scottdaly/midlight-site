import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEYS = [
  'LLM_ATTACHMENT_VALIDATION_ENABLED',
  'LLM_ATTACHMENT_VALIDATION_MODE',
  'LLM_MULTIMODAL_STRICT_VALIDATION',
];

const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

async function loadConfigFresh() {
  return import(`../config/index.js?cacheBust=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original == null) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

describe('llm guardrail configuration', () => {
  it('defaults attachment validation mode to strict', async () => {
    delete process.env.LLM_ATTACHMENT_VALIDATION_ENABLED;
    delete process.env.LLM_ATTACHMENT_VALIDATION_MODE;
    delete process.env.LLM_MULTIMODAL_STRICT_VALIDATION;

    const { CONFIG } = await loadConfigFresh();
    assert.equal(CONFIG.llm.guardrails.attachmentValidationMode, 'strict');
  });

  it('maps LLM_MULTIMODAL_STRICT_VALIDATION=false to warn mode', async () => {
    delete process.env.LLM_ATTACHMENT_VALIDATION_MODE;
    process.env.LLM_MULTIMODAL_STRICT_VALIDATION = 'false';

    const { CONFIG } = await loadConfigFresh();
    assert.equal(CONFIG.llm.guardrails.attachmentValidationMode, 'warn');
  });

  it('explicit attachment mode env overrides strict-validation boolean flag', async () => {
    process.env.LLM_MULTIMODAL_STRICT_VALIDATION = 'true';
    process.env.LLM_ATTACHMENT_VALIDATION_MODE = 'off';

    const { CONFIG } = await loadConfigFresh();
    assert.equal(CONFIG.llm.guardrails.attachmentValidationMode, 'off');
  });

  it('legacy attachment validation kill switch still forces off mode', async () => {
    process.env.LLM_ATTACHMENT_VALIDATION_ENABLED = 'false';
    delete process.env.LLM_MULTIMODAL_STRICT_VALIDATION;
    delete process.env.LLM_ATTACHMENT_VALIDATION_MODE;

    const { CONFIG } = await loadConfigFresh();
    assert.equal(CONFIG.llm.guardrails.attachmentValidation, false);
    assert.equal(CONFIG.llm.guardrails.attachmentValidationMode, 'off');
  });
});
