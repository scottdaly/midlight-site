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
    id: 'claude-sonnet-4-5-thinking',
    name: 'Claude Sonnet 4.5 (Thinking)',
    tier: 'premium',
    contextWindow: 200000,
    maxOutput: 16384
  },
  {
    id: 'claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    tier: 'pro',
    contextWindow: 200000,
    maxOutput: 8192
  }
];

// Alias → real API model ID
const MODEL_ID_MAP = {
  'claude-sonnet-4-5-thinking': 'claude-sonnet-4-5-20250929',
};

// Models that use extended thinking
const THINKING_MODELS = new Set(['claude-sonnet-4-5-thinking']);

// Convert OpenAI-style messages to Anthropic format
function convertMessages(messages) {
  let systemMessage = '';
  const anthropicMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMessage = msg.content;
    } else if (msg.role === 'assistant') {
      // Assistant messages may have tool calls
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        // Build content array with text (if any) and tool_use blocks
        const content = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const toolCall of msg.toolCalls) {
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.arguments
          });
        }
        anthropicMessages.push({
          role: 'assistant',
          content
        });
      } else {
        anthropicMessages.push({
          role: 'assistant',
          content: msg.content
        });
      }
    } else if (msg.role === 'tool') {
      // Tool result messages - Anthropic expects these as user messages with tool_result content
      anthropicMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: msg.content
        }]
      });
    } else if (Array.isArray(msg.content)) {
      // Multimodal message (vision) — convert to Anthropic format
      anthropicMessages.push({
        role: 'user',
        content: msg.content.map(part => {
          if (part.type === 'image') {
            return {
              type: 'image',
              source: { type: 'base64', media_type: part.mediaType, data: part.data }
            };
          }
          return { type: 'text', text: part.text };
        })
      });
    } else {
      // User messages
      anthropicMessages.push({
        role: 'user',
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
  const apiModel = MODEL_ID_MAP[model] || model;
  const isThinking = THINKING_MODELS.has(model);

  const params = {
    model: apiModel,
    max_tokens: isThinking ? Math.max(maxTokens, 16384) : maxTokens,
    messages: anthropicMessages,
    ...(systemMessage && { system: systemMessage }),
    ...(isThinking && {
      thinking: { type: 'enabled', budget_tokens: 10240 },
      temperature: 1.0
    })
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
    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        const delta = event.delta.text;
        totalContent += delta;
        yield { type: 'chunk', content: delta, finishReason: null };
      } else if (event.delta.type === 'thinking_delta') {
        yield { type: 'thinking', thinking: event.delta.thinking };
      }
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

// Note: Web search is now handled by unified Tavily service in services/search/
// The webSearchEnabled parameter is kept for backwards compatibility but ignored

export async function chatWithTools({
  model,
  messages,
  tools,
  temperature = 0.7,
  maxTokens = 4096,
  webSearchEnabled = false  // Ignored - search handled by Tavily service
}) {
  const { systemMessage, messages: anthropicMessages } = convertMessages(messages);
  const apiModel = MODEL_ID_MAP[model] || model;
  const isThinking = THINKING_MODELS.has(model);

  // Convert function tools to Anthropic format
  const anthropicTools = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }));

  let response;
  try {
    response = await client.messages.create({
      model: apiModel,
      max_tokens: isThinking ? Math.max(maxTokens, 16384) : maxTokens,
      messages: anthropicMessages,
      ...(systemMessage && { system: systemMessage }),
      ...(anthropicTools.length > 0 && { tools: anthropicTools }),
      ...(isThinking && {
        thinking: { type: 'enabled', budget_tokens: 10240 },
        temperature: 1.0
      })
    });
  } catch (error) {
    const normalizedError = new Error(error.message || 'Anthropic request failed');
    normalizedError.code = error.status || 'PROVIDER_ERROR';
    normalizedError.provider = 'anthropic';
    throw normalizedError;
  }

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

export async function* chatWithToolsStream({
  model,
  messages,
  tools,
  temperature = 0.7,
  maxTokens = 4096,
  webSearchEnabled = false
}) {
  const { systemMessage, messages: anthropicMessages } = convertMessages(messages);
  const apiModel = MODEL_ID_MAP[model] || model;
  const isThinking = THINKING_MODELS.has(model);

  const anthropicTools = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }));

  const params = {
    model: apiModel,
    max_tokens: isThinking ? Math.max(maxTokens, 16384) : maxTokens,
    messages: anthropicMessages,
    ...(systemMessage && { system: systemMessage }),
    ...(anthropicTools.length > 0 && { tools: anthropicTools }),
    ...(isThinking && {
      thinking: { type: 'enabled', budget_tokens: 10240 },
      temperature: 1.0
    })
  };

  const stream = await client.messages.stream(params);

  let promptTokens = 0;
  let completionTokens = 0;
  let currentToolCall = null;
  let currentToolInput = '';

  for await (const event of stream) {
    if (event.type === 'message_start' && event.message?.usage) {
      promptTokens = event.message.usage.input_tokens;
    }

    if (event.type === 'content_block_start') {
      if (event.content_block?.type === 'tool_use') {
        currentToolCall = {
          id: event.content_block.id,
          name: event.content_block.name,
        };
        currentToolInput = '';
        // Emit early notification so frontend can show "Creating document..." immediately
        yield {
          type: 'tool_call',
          toolCall: { id: currentToolCall.id, name: currentToolCall.name, arguments: {} }
        };
      }
    }

    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        yield { type: 'content', content: event.delta.text };
      } else if (event.delta.type === 'thinking_delta') {
        yield { type: 'thinking', thinking: event.delta.thinking };
      } else if (event.delta.type === 'input_json_delta' && currentToolCall) {
        currentToolInput += event.delta.partial_json;
      }
    }

    if (event.type === 'content_block_stop' && currentToolCall) {
      try {
        const args = currentToolInput ? JSON.parse(currentToolInput) : {};
        yield {
          type: 'tool_call',
          toolCall: {
            id: currentToolCall.id,
            name: currentToolCall.name,
            arguments: args
          }
        };
      } catch (parseError) {
        console.warn(`[Anthropic] Failed to parse streamed tool call arguments for "${currentToolCall.name}": ${parseError.message}`, currentToolInput.substring(0, 200));
        yield {
          type: 'tool_call',
          toolCall: {
            id: currentToolCall.id,
            name: currentToolCall.name,
            arguments: {}
          }
        };
      }
      currentToolCall = null;
      currentToolInput = '';
    }

    if (event.type === 'message_delta') {
      if (event.usage) {
        completionTokens = event.usage.output_tokens;
      }
    }
  }

  const finalMessage = await stream.finalMessage();
  promptTokens = finalMessage.usage?.input_tokens || promptTokens;
  completionTokens = finalMessage.usage?.output_tokens || completionTokens;

  yield {
    type: 'done',
    finishReason: finalMessage.stop_reason,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    }
  };
}

export function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}
