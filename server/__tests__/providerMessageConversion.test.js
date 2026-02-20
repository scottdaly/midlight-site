import { before, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let anthropicPrivate;
let geminiPrivate;
let kimiPrivate;
let openaiPrivate;

before(async () => {
  process.env.ANTHROPIC_API_KEY ||= 'test-anthropic-key';
  process.env.GEMINI_API_KEY ||= 'test-gemini-key';
  process.env.OPENAI_API_KEY ||= 'test-openai-key';

  ({ __private: anthropicPrivate } = await import('../services/llm/anthropicProvider.js'));
  ({ __private: geminiPrivate } = await import('../services/llm/geminiProvider.js'));
  ({ __private: kimiPrivate } = await import('../services/llm/kimiProvider.js'));
  ({ __private: openaiPrivate } = await import('../services/llm/openaiProvider.js'));
});

afterEach(() => {
  kimiPrivate.resetPdfTextExtractorForTests();
  openaiPrivate.resetPdfTextExtractorForTests();
});

describe('provider message conversion', () => {
  it('converts multimodal messages for Anthropic with system separation', () => {
    const input = [
      { role: 'system', content: 'System prompt' },
      {
        role: 'user',
        content: [
          { type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=' },
          { type: 'document', mediaType: 'application/pdf', data: 'cGRm' },
          { type: 'text', text: 'Analyze this' },
        ],
      },
    ];

    const result = anthropicPrivate.convertMessages(input);

    assert.equal(result.systemMessage, 'System prompt');
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, 'user');
    assert.deepEqual(result.messages[0].content[0], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
    });
    assert.deepEqual(result.messages[0].content[1], {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
    });
    assert.deepEqual(result.messages[0].content[2], {
      type: 'text',
      text: 'Analyze this',
    });
  });

  it('converts multimodal and tool messages for Gemini', () => {
    const input = [
      { role: 'system', content: 'System instruction' },
      {
        role: 'user',
        content: [
          { type: 'document', mediaType: 'application/pdf', data: 'cGRm' },
          { type: 'text', text: 'Summarize' },
        ],
      },
      { role: 'tool', name: 'lookup', content: '{"ok":true}' },
    ];

    const result = geminiPrivate.convertMessages(input);

    assert.equal(result.systemInstruction, 'System instruction');
    assert.equal(result.contents[0].role, 'user');
    assert.deepEqual(result.contents[0].parts[0], {
      inlineData: { mimeType: 'application/pdf', data: 'cGRm' },
    });
    assert.deepEqual(result.contents[0].parts[1], { text: 'Summarize' });
    assert.equal(result.contents[1].role, 'user');
    assert.equal(result.contents[1].parts[0].functionResponse.name, 'lookup');
    assert.deepEqual(result.contents[1].parts[0].functionResponse.response, { ok: true });
  });

  it('converts image and document parts for OpenAI using document text fallback', async () => {
    let seenExtractionOptions = null;
    openaiPrivate.setPdfTextExtractorForTests(async (base64Data, filename, extractionOptions) => {
      seenExtractionOptions = extractionOptions ?? null;
      return `[Document: ${filename || 'PDF'}]\n\nExtracted from ${base64Data.length} chars`;
    });

    const input = [
      {
        role: 'user',
        content: [
          { type: 'image', mediaType: 'image/jpeg', data: 'aW1hZ2U=' },
          { type: 'document', mediaType: 'application/pdf', data: 'cGRm', name: 'input.pdf' },
          { type: 'text', text: 'Compare both files' },
        ],
      },
    ];

    const result = await openaiPrivate.convertMessages(input);

    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.deepEqual(result[0].content[0], {
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,aW1hZ2U=' },
    });
    assert.equal(result[0].content[1].type, 'text');
    assert.ok(result[0].content[1].text.includes('[Document: input.pdf]'));
    assert.deepEqual(result[0].content[2], {
      type: 'text',
      text: 'Compare both files',
    });
    assert.ok(seenExtractionOptions);
    assert.equal(typeof seenExtractionOptions.maxPdfBytes, 'number');
    assert.equal(typeof seenExtractionOptions.maxPages, 'number');
    assert.equal(typeof seenExtractionOptions.maxTextChars, 'number');
  });

  it('converts image and document parts for Kimi using document text fallback', async () => {
    let seenExtractionOptions = null;
    kimiPrivate.setPdfTextExtractorForTests(async (base64Data, filename, extractionOptions) => {
      seenExtractionOptions = extractionOptions ?? null;
      return `[Document: ${filename || 'PDF'}]\n\nExtracted from ${base64Data.length} chars`;
    });

    const input = [
      {
        role: 'user',
        content: [
          { type: 'image', mediaType: 'image/jpeg', data: 'aW1hZ2U=' },
          { type: 'document', mediaType: 'application/pdf', data: 'cGRm', name: 'input.pdf' },
          { type: 'text', text: 'Compare both files' },
        ],
      },
    ];

    const result = await kimiPrivate.convertMessages(input);

    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.deepEqual(result[0].content[0], {
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,aW1hZ2U=' },
    });
    assert.equal(result[0].content[1].type, 'text');
    assert.ok(result[0].content[1].text.includes('[Document: input.pdf]'));
    assert.deepEqual(result[0].content[2], {
      type: 'text',
      text: 'Compare both files',
    });
    assert.ok(seenExtractionOptions);
    assert.equal(typeof seenExtractionOptions.maxPdfBytes, 'number');
    assert.equal(typeof seenExtractionOptions.maxPages, 'number');
    assert.equal(typeof seenExtractionOptions.maxTextChars, 'number');
  });

  it('converts assistant tool calls and tool results for OpenAI', async () => {
    const input = [
      {
        role: 'assistant',
        content: 'Calling tool',
        toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { q: 'weather' } }],
      },
      {
        role: 'tool',
        toolCallId: 'call-1',
        content: '{"ok":true}',
      },
    ];

    const result = await openaiPrivate.convertMessages(input);

    assert.equal(result[0].role, 'assistant');
    assert.equal(result[0].tool_calls[0].function.name, 'lookup');
    assert.equal(result[0].tool_calls[0].function.arguments, '{"q":"weather"}');
    assert.equal(result[1].role, 'tool');
    assert.equal(result[1].tool_call_id, 'call-1');
    assert.equal(result[1].content, '{"ok":true}');
  });
});
