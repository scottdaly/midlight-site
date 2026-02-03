import OpenAI from 'openai';

// Kimi K2.5 uses OpenAI-compatible API
// API docs: https://platform.moonshot.ai/docs/guide/kimi-k2-5-quickstart
const client = new OpenAI({
  apiKey: process.env.KIMI_API_KEY,
  baseURL: 'https://api.moonshot.ai/v1'
});

// Model configuration - each model has its own tier
// Users can access any model at or below their subscription tier
export const KIMI_MODELS = [
  {
    id: 'kimi-k2.5',
    name: 'Kimi K2.5',
    tier: 'premium',
    contextWindow: 262144, // 256k context
    maxOutput: 8192
  },
  {
    id: 'kimi-k2.5-thinking',
    name: 'Kimi K2.5 (Thinking)',
    tier: 'premium',
    contextWindow: 262144,
    maxOutput: 8192
  }
];

// Thinking mode models that return reasoning_content
const THINKING_MODELS = ['kimi-k2.5-thinking'];

// Convert our message format to OpenAI format (Kimi is OpenAI-compatible)
function convertMessages(messages) {
  return messages.map(msg => {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Assistant message with tool calls - convert toolCalls to tool_calls format
      return {
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments)
          }
        }))
      };
    } else if (msg.role === 'tool') {
      // Tool result message - convert toolCallId to tool_call_id
      return {
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content
      };
    } else {
      // Regular message (system, user, or assistant without tool calls)
      return {
        role: msg.role,
        content: msg.content
      };
    }
  });
}

export async function chat({
  model,
  messages,
  temperature = 0.7,
  maxTokens = 4096,
  stream = false
}) {
  const isThinkingMode = THINKING_MODELS.includes(model);

  // Use the base model ID for API calls (strip -thinking suffix for API)
  const apiModel = model.replace('-thinking', '');

  const params = {
    model: apiModel,
    messages: convertMessages(messages),
    max_tokens: maxTokens,
    stream,
    // Kimi recommended settings
    // Thinking mode: temperature=1.0, Instant mode: temperature=0.6
    temperature: isThinkingMode ? 1.0 : (temperature ?? 0.6),
    top_p: 0.95
  };

  if (stream) {
    return streamChat(params, model);
  }

  const response = await client.chat.completions.create(params);

  // Extract reasoning content if present (thinking mode)
  const choice = response.choices[0];
  let content = choice?.message?.content || '';

  // If there's reasoning_content, we could include it in metadata
  // For now, we just return the main content
  const reasoningContent = choice?.message?.reasoning_content;

  return {
    id: response.id,
    provider: 'kimi',
    model: model, // Return the original model ID
    content,
    finishReason: choice?.finish_reason,
    usage: {
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
      totalTokens: response.usage?.total_tokens || 0
    },
    // Include reasoning if available
    ...(reasoningContent && { reasoning: reasoningContent })
  };
}

async function* streamChat(params, originalModel) {
  const stream = await client.chat.completions.create(params);

  let totalContent = '';
  let promptTokens = 0;
  let completionTokens = 0;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || '';
    totalContent += delta;

    // Usage is only available in the final chunk for some models
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens;
      completionTokens = chunk.usage.completion_tokens;
    }

    yield {
      type: 'chunk',
      content: delta,
      finishReason: chunk.choices[0]?.finish_reason || null
    };
  }

  // Final message with usage stats
  yield {
    type: 'done',
    content: totalContent,
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
  maxTokens = 4096,
  webSearchEnabled = false // Ignored - search handled by Tavily service
}) {
  const isThinkingMode = THINKING_MODELS.includes(model);
  const apiModel = model.replace('-thinking', '');

  const params = {
    model: apiModel,
    messages: convertMessages(messages),
    tools: tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    })),
    max_tokens: maxTokens,
    temperature: isThinkingMode ? 1.0 : (temperature ?? 0.6),
    top_p: 0.95
  };

  const response = await client.chat.completions.create(params);

  const message = response.choices[0]?.message;
  const toolCalls = message?.tool_calls?.map(tc => {
    let args = {};
    try {
      args = JSON.parse(tc.function.arguments);
    } catch (e) {
      console.error('Failed to parse tool arguments:', tc.function.arguments, e);
      args = {};
    }
    return {
      id: tc.id,
      name: tc.function.name,
      arguments: args
    };
  });

  return {
    id: response.id,
    provider: 'kimi',
    model: model,
    content: message?.content || '',
    toolCalls: toolCalls || [],
    finishReason: response.choices[0]?.finish_reason,
    usage: {
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
      totalTokens: response.usage?.total_tokens || 0
    }
  };
}

export function isConfigured() {
  return !!process.env.KIMI_API_KEY;
}
