import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Model configuration - each model has its own tier
// Users can access any model at or below their subscription tier
export const GEMINI_MODELS = [
  {
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3 Flash',
    tier: 'free',
    contextWindow: 1048576,
    maxOutput: 65536
  },
  {
    id: 'gemini-3-pro-preview',
    name: 'Gemini 3 Pro',
    tier: 'premium',
    contextWindow: 1048576,
    maxOutput: 65536
  }
];

// Convert OpenAI-style messages to Gemini format
function convertMessages(messages) {
  let systemInstruction = '';
  const geminiContents = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Gemini uses systemInstruction as a separate parameter
      systemInstruction = msg.content;
    } else {
      geminiContents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      });
    }
  }

  return { systemInstruction, contents: geminiContents };
}

// Convert OpenAI-style tools to Gemini function declarations
function convertTools(tools) {
  if (!tools || tools.length === 0) return null;

  return {
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }))
  };
}

export async function chat({
  model,
  messages,
  temperature = 0.7,
  maxTokens = 4096,
  stream = false
}) {
  const { systemInstruction, contents } = convertMessages(messages);

  const generativeModel = genAI.getGenerativeModel({
    model,
    ...(systemInstruction && { systemInstruction }),
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens
    }
  });

  if (stream) {
    return streamChat(generativeModel, contents);
  }

  const result = await generativeModel.generateContent({ contents });
  const response = result.response;
  const text = response.text();

  // Gemini doesn't provide token counts in the same way, estimate from response
  const usageMetadata = response.usageMetadata || {};

  return {
    id: `gemini-${Date.now()}`,
    provider: 'gemini',
    model,
    content: text,
    finishReason: response.candidates?.[0]?.finishReason || 'stop',
    usage: {
      promptTokens: usageMetadata.promptTokenCount || 0,
      completionTokens: usageMetadata.candidatesTokenCount || 0,
      totalTokens: usageMetadata.totalTokenCount || 0
    }
  };
}

async function* streamChat(generativeModel, contents) {
  const result = await generativeModel.generateContentStream({ contents });

  let totalContent = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let finishReason = 'stop';

  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) {
      totalContent += text;
      yield {
        type: 'chunk',
        content: text,
        finishReason: null
      };
    }

    // Check for finish reason
    if (chunk.candidates?.[0]?.finishReason) {
      finishReason = chunk.candidates[0].finishReason;
    }
  }

  // Get final response for usage metadata
  const finalResponse = await result.response;
  const usageMetadata = finalResponse.usageMetadata || {};
  promptTokens = usageMetadata.promptTokenCount || 0;
  completionTokens = usageMetadata.candidatesTokenCount || 0;

  yield {
    type: 'done',
    content: totalContent,
    finishReason,
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
  const { systemInstruction, contents } = convertMessages(messages);
  const geminiTools = convertTools(tools);

  // Build tools array - include function tools and optionally Google Search
  const allTools = [];
  if (geminiTools) {
    allTools.push(geminiTools);
  }
  if (webSearchEnabled) {
    // Enable Google Search grounding
    allTools.push({ googleSearch: {} });
  }

  const generativeModel = genAI.getGenerativeModel({
    model,
    ...(systemInstruction && { systemInstruction }),
    ...(allTools.length > 0 && { tools: allTools }),
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens
    }
  });

  let result;
  try {
    result = await generativeModel.generateContent({ contents });
  } catch (error) {
    const normalizedError = new Error(error.message || 'Gemini request failed');
    normalizedError.code = error.code || 'PROVIDER_ERROR';
    normalizedError.provider = 'gemini';
    throw normalizedError;
  }

  const response = result.response;
  const candidate = response.candidates?.[0];

  // Extract text content and function calls from parts
  let textContent = '';
  const toolCalls = [];

  if (candidate?.content?.parts) {
    for (const part of candidate.content.parts) {
      if (part.text) {
        textContent += part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `call-${Date.now()}-${toolCalls.length}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args || {}
        });
      }
    }
  }

  // Extract web search grounding metadata if available
  const webSearches = [];
  const groundingMetadata = candidate?.groundingMetadata;
  if (groundingMetadata?.groundingChunks && Array.isArray(groundingMetadata.groundingChunks)) {
    // Gemini returns grounding chunks with web sources
    // Filter with proper null checks and URL validation
    const sources = groundingMetadata.groundingChunks
      .filter(chunk =>
        chunk &&
        chunk.web &&
        typeof chunk.web.uri === 'string' &&
        isValidHttpUrl(chunk.web.uri)
      )
      .slice(0, MAX_SEARCH_RESULTS)
      .map(chunk => ({
        url: chunk.web.uri,
        title: chunk.web.title || '',
        snippet: ''
      }));

    if (sources.length > 0) {
      webSearches.push({
        query: groundingMetadata.webSearchQueries?.[0] || 'Google Search',
        results: sources
      });
    }
  }

  const usageMetadata = response.usageMetadata || {};

  return {
    id: `gemini-${Date.now()}`,
    provider: 'gemini',
    model,
    content: textContent,
    toolCalls,
    webSearches: webSearches.length > 0 ? webSearches : undefined,
    finishReason: candidate?.finishReason || 'stop',
    usage: {
      promptTokens: usageMetadata.promptTokenCount || 0,
      completionTokens: usageMetadata.candidatesTokenCount || 0,
      totalTokens: usageMetadata.totalTokenCount || 0
    }
  };
}

export function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}
