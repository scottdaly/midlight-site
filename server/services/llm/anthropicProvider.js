import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Model configuration - each model has its own tier
// Users can access any model at or below their subscription tier
export const ANTHROPIC_MODELS = [
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    tier: 'free',
    contextWindow: 200000,
    maxOutput: 8192
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    tier: 'premium',
    contextWindow: 200000,
    maxOutput: 8192
  },
  {
    id: 'claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    tier: 'pro',
    contextWindow: 200000,
    maxOutput: 8192
  }
];

// Convert OpenAI-style messages to Anthropic format
function convertMessages(messages) {
  let systemMessage = '';
  const anthropicMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMessage = msg.content;
    } else {
      anthropicMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      });
    }
  }

  return { systemMessage, messages: anthropicMessages };
}

export async function chat({
  model,
  messages,
  temperature = 0.7,
  maxTokens = 4096,
  stream = false
}) {
  const { systemMessage, messages: anthropicMessages } = convertMessages(messages);

  const params = {
    model,
    max_tokens: maxTokens,
    messages: anthropicMessages,
    ...(systemMessage && { system: systemMessage })
  };

  if (stream) {
    return streamChat(params);
  }

  const response = await client.messages.create(params);

  const content = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  return {
    id: response.id,
    provider: 'anthropic',
    model: response.model,
    content,
    finishReason: response.stop_reason,
    usage: {
      promptTokens: response.usage?.input_tokens || 0,
      completionTokens: response.usage?.output_tokens || 0,
      totalTokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)
    }
  };
}

async function* streamChat(params) {
  const stream = await client.messages.stream(params);

  let totalContent = '';
  let promptTokens = 0;
  let completionTokens = 0;

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      const delta = event.delta.text;
      totalContent += delta;

      yield {
        type: 'chunk',
        content: delta,
        finishReason: null
      };
    }

    if (event.type === 'message_delta') {
      if (event.usage) {
        completionTokens = event.usage.output_tokens;
      }
    }

    if (event.type === 'message_start' && event.message?.usage) {
      promptTokens = event.message.usage.input_tokens;
    }
  }

  // Get final message for complete usage
  const finalMessage = await stream.finalMessage();
  promptTokens = finalMessage.usage?.input_tokens || promptTokens;
  completionTokens = finalMessage.usage?.output_tokens || completionTokens;

  yield {
    type: 'done',
    content: totalContent,
    finishReason: finalMessage.stop_reason,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    }
  };
}

export async function chatWithTools({
  model,
  messages,
  tools,
  temperature = 0.7,
  maxTokens = 4096
}) {
  const { systemMessage, messages: anthropicMessages } = convertMessages(messages);

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: anthropicMessages,
    ...(systemMessage && { system: systemMessage }),
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }))
  });

  const textContent = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  const toolCalls = response.content
    .filter(block => block.type === 'tool_use')
    .map(block => ({
      id: block.id,
      name: block.name,
      arguments: block.input
    }));

  return {
    id: response.id,
    provider: 'anthropic',
    model: response.model,
    content: textContent,
    toolCalls,
    finishReason: response.stop_reason,
    usage: {
      promptTokens: response.usage?.input_tokens || 0,
      completionTokens: response.usage?.output_tokens || 0,
      totalTokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)
    }
  };
}

export function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}
