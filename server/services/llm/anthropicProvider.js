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

// Maximum number of search results to return
const MAX_SEARCH_RESULTS = 10;

// Validate URL is http/https
function isValidHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export async function chatWithTools({
  model,
  messages,
  tools,
  temperature = 0.7,
  maxTokens = 4096,
  webSearchEnabled = false
}) {
  const { systemMessage, messages: anthropicMessages } = convertMessages(messages);

  // Convert function tools to Anthropic format
  const anthropicTools = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }));

  // Add web search tool if enabled
  // Uses Anthropic's built-in web search capability
  if (webSearchEnabled) {
    anthropicTools.push({
      type: 'web_search_20250305',
      name: 'web_search',
      // No additional configuration needed - Claude decides when to search
    });
  }

  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: anthropicMessages,
      ...(systemMessage && { system: systemMessage }),
      tools: anthropicTools
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

  // Extract web search results if any
  const webSearches = [];
  for (const block of response.content) {
    if (block.type === 'web_search_tool_result') {
      // Extract search query from the preceding tool_use block
      const searchToolUse = response.content.find(
        b => b.type === 'tool_use' && b.name === 'web_search' && b.id === block.tool_use_id
      );
      const query = searchToolUse?.input?.query || 'web search';

      // Parse search results with validation
      const results = (block.content || [])
        .filter(item =>
          item.type === 'web_search_result' &&
          item.url &&
          isValidHttpUrl(item.url)
        )
        .slice(0, MAX_SEARCH_RESULTS)
        .map(item => ({
          url: item.url,
          title: item.title || '',
          snippet: item.page_content?.substring(0, 200) || ''
        }));

      if (results.length > 0) {
        webSearches.push({
          query,
          results
        });
      }
    }
  }

  return {
    id: response.id,
    provider: 'anthropic',
    model: response.model,
    content: textContent,
    toolCalls,
    webSearches: webSearches.length > 0 ? webSearches : undefined,
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
