import OpenAI from 'openai';

// Kimi K2.5 uses OpenAI-compatible API
// Primary: NVIDIA (free tier)
// Fallback: Together AI (paid, more reliable)

// NVIDIA client (primary - free)
const nvidiaClient = process.env.NVIDIA_API_KEY ? new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1'
}) : null;

// Together AI client (fallback)
const togetherClient = process.env.KIMI_API_KEY ? new OpenAI({
  apiKey: process.env.KIMI_API_KEY,
  baseURL: 'https://api.together.xyz/v1'
}) : null;

// Model configuration - each model has its own tier
// Users can access any model at or below their subscription tier
export const KIMI_MODELS = [
  {
    id: 'kimi-k2.5',
    name: 'Kimi K2.5',
    tier: 'free',
    contextWindow: 262144, // 256k context
    maxOutput: 8192
  },
  {
    id: 'kimi-k2.5-thinking',
    name: 'Kimi K2.5 Thinking',
    tier: 'free',
    contextWindow: 262144,
    maxOutput: 8192
  }
];

// Model IDs (same for both providers) — thinking alias maps to same underlying model
const MODEL_ID_MAP = {
  'kimi-k2.5': 'moonshotai/kimi-k2.5',
  'kimi-k2.5-thinking': 'moonshotai/kimi-k2.5'
};

// Models that should enable thinking mode
const THINKING_MODELS = new Set(['kimi-k2.5-thinking']);

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
    } else if (Array.isArray(msg.content)) {
      // Multimodal message (vision) — convert to OpenAI-compatible format
      return {
        role: msg.role,
        content: msg.content.map(part => {
          if (part.type === 'image') {
            return {
              type: 'image_url',
              image_url: { url: `data:${part.mediaType};base64,${part.data}` }
            };
          }
          return { type: 'text', text: part.text };
        })
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

/**
 * Try a request with NVIDIA first, fall back to Together AI on error.
 * @param {Function} requestFn - Function that takes a client and returns a promise
 * @returns {Promise} - Result from whichever client succeeds
 */
async function withFallback(requestFn) {
  // Try NVIDIA first if available
  if (nvidiaClient) {
    try {
      return await requestFn(nvidiaClient, 'nvidia');
    } catch (error) {
      console.warn('[Kimi] NVIDIA API failed, falling back to Together AI:', error.message);
      // Fall through to Together AI
    }
  }

  // Fallback to Together AI
  if (togetherClient) {
    return await requestFn(togetherClient, 'together');
  }

  throw new Error('No Kimi API configured. Set NVIDIA_API_KEY or KIMI_API_KEY.');
}

export async function chat({
  model,
  messages,
  temperature = 0.7,
  maxTokens = 4096,
  stream = false
}) {
  const apiModel = MODEL_ID_MAP[model] || model;

  const isThinking = THINKING_MODELS.has(model);
  const params = {
    model: apiModel,
    messages: convertMessages(messages),
    max_tokens: maxTokens,
    stream,
    // Thinking mode: temperature=1.0 recommended; instant: 0.6
    temperature: isThinking ? 1.0 : (temperature ?? 0.6),
    top_p: 0.95,
    ...(isThinking ? { chat_template_kwargs: { thinking: true } } : {})
  };

  if (stream) {
    return streamChat(params, model);
  }

  return withFallback(async (client, source) => {
    const response = await client.chat.completions.create(params);

    const choice = response.choices[0];
    let content = choice?.message?.content || '';

    console.log(`[Kimi] Chat completed via ${source}`);

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
      }
    };
  });
}

async function* streamChat(params, originalModel) {
  // For streaming, we need to handle fallback differently
  // Try NVIDIA first, if it fails on connection, try Together
  let client = nvidiaClient;
  let source = 'nvidia';

  if (!client) {
    client = togetherClient;
    source = 'together';
  }

  if (!client) {
    throw new Error('No Kimi API configured. Set NVIDIA_API_KEY or KIMI_API_KEY.');
  }

  let stream;
  try {
    stream = await client.chat.completions.create(params);
  } catch (error) {
    // If NVIDIA failed and we have Together AI, try that
    if (source === 'nvidia' && togetherClient) {
      console.warn('[Kimi] NVIDIA streaming failed, falling back to Together AI:', error.message);
      client = togetherClient;
      source = 'together';
      stream = await client.chat.completions.create(params);
    } else {
      throw error;
    }
  }

  console.log(`[Kimi] Streaming via ${source}`);

  let totalContent = '';
  let promptTokens = 0;
  let completionTokens = 0;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;

    // Thinking/reasoning content (OpenAI-compatible thinking models)
    const thinking = delta?.reasoning_content || delta?.reasoning || '';
    if (thinking) {
      yield { type: 'thinking', thinking, finishReason: null };
    }

    const content = delta?.content || '';
    if (content) {
      totalContent += content;
      yield { type: 'chunk', content, finishReason: chunk.choices[0]?.finish_reason || null };
    }

    // Usage is only available in the final chunk for some models
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens;
      completionTokens = chunk.usage.completion_tokens;
    }

    // Yield finish reason if no content (e.g. final chunk)
    if (!content && !thinking && chunk.choices[0]?.finish_reason) {
      yield { type: 'chunk', content: '', finishReason: chunk.choices[0].finish_reason };
    }
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
  const apiModel = MODEL_ID_MAP[model] || model;

  const isThinking = THINKING_MODELS.has(model);
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
    temperature: isThinking ? 1.0 : (temperature ?? 0.6),
    top_p: 0.95,
    ...(isThinking ? { chat_template_kwargs: { thinking: true } } : {})
  };

  return withFallback(async (client, source) => {
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

    console.log(`[Kimi] Chat with tools completed via ${source}`);

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
  });
}

export async function* chatWithToolsStream({
  model,
  messages,
  tools,
  temperature = 0.7,
  maxTokens = 4096,
  webSearchEnabled = false
}) {
  const apiModel = MODEL_ID_MAP[model] || model;
  const isThinking = THINKING_MODELS.has(model);

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
    stream: true,
    temperature: isThinking ? 1.0 : (temperature ?? 0.6),
    top_p: 0.95,
    ...(isThinking ? { chat_template_kwargs: { thinking: true } } : {})
  };

  let client = nvidiaClient;
  let source = 'nvidia';
  if (!client) {
    client = togetherClient;
    source = 'together';
  }
  if (!client) {
    throw new Error('No Kimi API configured. Set NVIDIA_API_KEY or KIMI_API_KEY.');
  }

  let stream;
  const connectStart = Date.now();
  try {
    stream = await client.chat.completions.create(params);
  } catch (error) {
    if (source === 'nvidia' && togetherClient) {
      console.warn('[Kimi] NVIDIA streaming failed, falling back to Together AI:', error.message);
      client = togetherClient;
      source = 'together';
      stream = await client.chat.completions.create(params);
    } else {
      throw error;
    }
  }

  const streamStart = Date.now();
  console.log(`[Kimi] Streaming with tools via ${source} (connection: ${streamStart - connectStart}ms)`);

  let promptTokens = 0;
  let completionTokens = 0;
  let firstChunkLogged = false;
  // Accumulate tool calls by index
  const toolCallAccumulators = new Map();

  for await (const chunk of stream) {
    if (!firstChunkLogged) {
      console.log(`[Kimi] First chunk received: ${Date.now() - streamStart}ms after stream start (type: ${chunk.choices[0]?.delta?.reasoning_content ? 'thinking' : chunk.choices[0]?.delta?.content ? 'content' : chunk.choices[0]?.delta?.tool_calls ? 'tool_call' : 'other'})`);
      firstChunkLogged = true;
    }

    const delta = chunk.choices[0]?.delta;

    // Thinking/reasoning content
    const thinking = delta?.reasoning_content || delta?.reasoning || '';
    if (thinking) {
      yield { type: 'thinking', thinking };
    }

    // Regular content
    const content = delta?.content || '';
    if (content) {
      yield { type: 'content', content };
    }

    // Tool calls (streamed incrementally by index)
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallAccumulators.has(idx)) {
          toolCallAccumulators.set(idx, { id: '', name: '', arguments: '' });
        }
        const acc = toolCallAccumulators.get(idx);
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
      }
    }

    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens;
      completionTokens = chunk.usage.completion_tokens;
    }
  }

  // Emit completed tool calls
  for (const [, acc] of toolCallAccumulators) {
    let args = {};
    try {
      args = acc.arguments ? JSON.parse(acc.arguments) : {};
    } catch (e) {
      console.error('[Kimi] Failed to parse streamed tool arguments:', acc.arguments?.substring(0, 200), e);
    }
    yield {
      type: 'tool_call',
      toolCall: { id: acc.id, name: acc.name, arguments: args }
    };
  }

  yield {
    type: 'done',
    finishReason: 'stop',
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    }
  };
}

export function isConfigured() {
  return !!(process.env.NVIDIA_API_KEY || process.env.KIMI_API_KEY);
}
