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
    id: 'gemini-3-flash-thinking-low',
    name: 'Gemini 3 Flash (Thinking Low)',
    tier: 'free',
    contextWindow: 1048576,
    maxOutput: 65536
  },
  {
    id: 'gemini-3-flash-thinking-high',
    name: 'Gemini 3 Flash (Thinking High)',
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

// Alias → real API model ID
const MODEL_ID_MAP = {
  'gemini-3-flash-thinking-low': 'gemini-3-flash-preview',
  'gemini-3-flash-thinking-high': 'gemini-3-flash-preview',
};

// Alias → thinkingConfig params (includeThoughts enables streaming thought summaries)
const THINKING_CONFIG = {
  'gemini-3-flash-thinking-low': { thinkingConfig: { thinkingBudget: 2048, includeThoughts: true } },
  'gemini-3-flash-thinking-high': { thinkingConfig: { thinkingBudget: 24576, includeThoughts: true } },
};

// Convert OpenAI-style messages to Gemini format
function convertMessages(messages) {
  let systemInstruction = '';
  const geminiContents = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Gemini uses systemInstruction as a separate parameter
      systemInstruction = msg.content;
    } else if (msg.role === 'assistant') {
      // Assistant messages may have tool calls
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const parts = [];
        if (msg.content) {
          parts.push({ text: msg.content });
        }
        for (const toolCall of msg.toolCalls) {
          parts.push({
            functionCall: {
              name: toolCall.name,
              args: toolCall.arguments
            }
          });
        }
        geminiContents.push({
          role: 'model',
          parts
        });
      } else {
        geminiContents.push({
          role: 'model',
          parts: [{ text: msg.content }]
        });
      }
    } else if (msg.role === 'tool') {
      // Tool result messages - Gemini expects functionResponse in user role
      let parsedContent;
      try {
        parsedContent = JSON.parse(msg.content);
      } catch {
        parsedContent = { result: msg.content };
      }
      geminiContents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: msg.name || 'tool',
            response: parsedContent
          }
        }]
      });
    } else if (Array.isArray(msg.content)) {
      // Multimodal message (vision) — convert to Gemini format
      geminiContents.push({
        role: 'user',
        parts: msg.content.map(part => {
          if (part.type === 'image') {
            return { inlineData: { mimeType: part.mediaType, data: part.data } };
          }
          return { text: part.text };
        })
      });
    } else {
      // User messages
      geminiContents.push({
        role: 'user',
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
  const apiModel = MODEL_ID_MAP[model] || model;
  const thinkingCfg = THINKING_CONFIG[model];

  const generativeModel = genAI.getGenerativeModel({
    model: apiModel,
    ...(systemInstruction && { systemInstruction }),
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      ...(thinkingCfg || {})
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
    const parts = chunk.candidates?.[0]?.content?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.thought && part.text) {
          // Thinking/reasoning content
          yield { type: 'thinking', thinking: part.text, finishReason: null };
        } else if (part.text) {
          // Regular content (avoid chunk.text() which includes thought parts)
          totalContent += part.text;
          yield { type: 'chunk', content: part.text, finishReason: null };
        }
      }
    } else {
      // Fallback for chunks without parts structure
      const text = chunk.text();
      if (text) {
        totalContent += text;
        yield { type: 'chunk', content: text, finishReason: null };
      }
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
  const { systemInstruction, contents } = convertMessages(messages);
  const geminiTools = convertTools(tools);
  const apiModel = MODEL_ID_MAP[model] || model;
  const thinkingCfg = THINKING_CONFIG[model];

  const generativeModel = genAI.getGenerativeModel({
    model: apiModel,
    ...(systemInstruction && { systemInstruction }),
    ...(geminiTools && { tools: [geminiTools] }),
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      ...(thinkingCfg || {})
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

  const usageMetadata = response.usageMetadata || {};

  return {
    id: `gemini-${Date.now()}`,
    provider: 'gemini',
    model,
    content: textContent,
    toolCalls,
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
