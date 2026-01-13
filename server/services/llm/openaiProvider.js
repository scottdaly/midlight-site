import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Model configuration - each model has its own tier
// Users can access any model at or below their subscription tier
export const OPENAI_MODELS = [
  {
    id: 'gpt-5-nano',
    name: 'GPT-5 Nano',
    tier: 'free',
    contextWindow: 128000,
    maxOutput: 16384
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 Mini',
    tier: 'free',
    contextWindow: 128000,
    maxOutput: 16384
  },
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    tier: 'premium',
    contextWindow: 128000,
    maxOutput: 16384
  }
];

// Models that don't support temperature parameter
const NO_TEMPERATURE_MODELS = ['gpt-5-nano', 'gpt-5-mini', 'gpt-5.2'];

// Convert our message format to OpenAI format
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
  const params = {
    model,
    messages,
    max_completion_tokens: maxTokens,
    stream
  };

  // Only include temperature if the model supports it
  if (!NO_TEMPERATURE_MODELS.includes(model)) {
    params.temperature = temperature;
  }

  if (stream) {
    return streamChat(params);
  }

  const response = await client.chat.completions.create(params);

  return {
    id: response.id,
    provider: 'openai',
    model: response.model,
    content: response.choices[0]?.message?.content || '',
    finishReason: response.choices[0]?.finish_reason,
    usage: {
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
      totalTokens: response.usage?.total_tokens || 0
    }
  };
}

async function* streamChat(params) {
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
  webSearchEnabled = false
}) {
  const params = {
    model,
    messages: convertMessages(messages),
    tools: tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    })),
    max_completion_tokens: maxTokens
  };

  // Only include temperature if the model supports it
  if (!NO_TEMPERATURE_MODELS.includes(model)) {
    params.temperature = temperature;
  }

  // Note: OpenAI web search requires either:
  // 1. Using dedicated search models (gpt-4o-search-preview)
  // 2. Using the Responses API with web_search_preview tool
  // For now, webSearchEnabled is accepted but not implemented for OpenAI
  // TODO: Implement OpenAI web search when using compatible models

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
    provider: 'openai',
    model: response.model,
    content: message?.content || '',
    toolCalls: toolCalls || [],
    webSearches: undefined, // OpenAI web search not yet implemented
    finishReason: response.choices[0]?.finish_reason,
    usage: {
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
      totalTokens: response.usage?.total_tokens || 0
    }
  };
}

export function isConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

// Embedding model configuration
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Generate embeddings for text inputs
 * @param {string[]} texts - Array of texts to embed
 * @returns {Promise<number[][]>} Array of embedding vectors
 */
export async function embed(texts) {
  if (!texts || texts.length === 0) {
    return [];
  }

  // OpenAI has a limit of 8191 tokens per input for embeddings
  // and max 2048 inputs per batch request
  const MAX_BATCH_SIZE = 100; // Keep batches reasonable
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);

    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
      dimensions: EMBEDDING_DIMENSIONS
    });

    // Extract embeddings in the correct order
    const batchEmbeddings = response.data
      .sort((a, b) => a.index - b.index)
      .map(item => item.embedding);

    allEmbeddings.push(...batchEmbeddings);
  }

  return allEmbeddings;
}
