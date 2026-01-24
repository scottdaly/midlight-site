import * as openaiProvider from './openaiProvider.js';
import * as anthropicProvider from './anthropicProvider.js';
import * as geminiProvider from './geminiProvider.js';
import { checkQuota, trackUsage } from './quotaManager.js';
import * as searchService from '../search/index.js';

// Combined model configuration
export const MODELS = {
  openai: openaiProvider.OPENAI_MODELS,
  anthropic: anthropicProvider.ANTHROPIC_MODELS,
  gemini: geminiProvider.GEMINI_MODELS
};

// Tier hierarchy - higher index = more access
const TIER_LEVELS = {
  free: 0,
  premium: 1,
  pro: 2
};

// Check if user tier can access model tier
function canAccessTier(userTier, modelTier) {
  const userLevel = TIER_LEVELS[userTier] ?? 0;
  const modelLevel = TIER_LEVELS[modelTier] ?? 0;
  return userLevel >= modelLevel;
}

function getProvider(providerName) {
  switch (providerName) {
    case 'openai':
      return openaiProvider;
    case 'anthropic':
      return anthropicProvider;
    case 'gemini':
      return geminiProvider;
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}

export async function chat({
  userId,
  provider,
  model,
  messages,
  temperature = 0.7,
  maxTokens = 4096,
  stream = false,
  requestType = 'chat'
}) {
  // Check quota
  const quota = await checkQuota(userId);
  if (!quota.allowed) {
    const error = new Error('Monthly quota exceeded');
    error.code = 'QUOTA_EXCEEDED';
    error.quota = quota;
    throw error;
  }

  // Get provider
  const providerService = getProvider(provider);

  if (!providerService.isConfigured()) {
    throw new Error(`Provider ${provider} is not configured`);
  }

  // Make request
  if (stream) {
    return streamWithTracking({
      userId,
      provider,
      model,
      messages,
      temperature,
      maxTokens,
      requestType,
      providerService
    });
  }

  const response = await providerService.chat({
    model,
    messages,
    temperature,
    maxTokens,
    stream: false
  });

  // Track usage
  await trackUsage(userId, provider, model, response.usage, requestType);

  return response;
}

async function* streamWithTracking({
  userId,
  provider,
  model,
  messages,
  temperature,
  maxTokens,
  requestType,
  providerService
}) {
  const stream = await providerService.chat({
    model,
    messages,
    temperature,
    maxTokens,
    stream: true
  });

  let finalUsage = null;

  for await (const chunk of stream) {
    if (chunk.type === 'done') {
      finalUsage = chunk.usage;
    }
    yield chunk;
  }

  // Track usage after stream completes
  if (finalUsage) {
    await trackUsage(userId, provider, model, finalUsage, requestType);
  }
}

// Search is now unified via Tavily - works with all providers
// See services/search/ for implementation

export async function chatWithTools({
  userId,
  provider,
  model,
  messages,
  tools,
  temperature = 0.7,
  maxTokens = 4096,
  requestType = 'agent',
  webSearchEnabled = false
}) {
  // Check quota
  const quota = await checkQuota(userId);
  if (!quota.allowed) {
    const error = new Error('Monthly quota exceeded');
    error.code = 'QUOTA_EXCEEDED';
    error.quota = quota;
    throw error;
  }

  // Get provider
  const providerService = getProvider(provider);

  if (!providerService.isConfigured()) {
    throw new Error(`Provider ${provider} is not configured`);
  }

  // Unified search pipeline (replaces native provider search)
  let searchResult = null;
  let messagesWithSearch = messages;

  if (webSearchEnabled && searchService.isConfigured()) {
    try {
      // Get conversation context for classifier
      const recentContext = messages
        .slice(-6)
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => `${m.role}: ${(m.content || '').substring(0, 200)}`)
        .join('\n');

      // Get the last user message for search
      const lastUserMessage = messages
        .filter(m => m.role === 'user')
        .pop()?.content || '';

      searchResult = await searchService.executeSearchPipeline({
        userId,
        message: lastUserMessage,
        conversationContext: recentContext
      });

      if (searchResult.searchExecuted && searchResult.formattedContext) {
        // Inject search context into messages
        messagesWithSearch = searchService.injectSearchContext(
          messages,
          searchResult.formattedContext
        );
      }
    } catch (error) {
      console.warn('[LLM] Search pipeline failed, continuing without:', error.message);
    }
  }

  // Call provider WITHOUT native search (now using Tavily)
  const response = await providerService.chatWithTools({
    model,
    messages: messagesWithSearch,
    tools,
    temperature,
    maxTokens,
    webSearchEnabled: false  // Always false - using unified Tavily search
  });

  // Track LLM usage
  await trackUsage(userId, provider, model, response.usage, requestType);

  // Format web searches for response (matching existing format)
  const webSearches = searchResult?.searchExecuted && searchResult.results?.length > 0
    ? [{
        query: searchResult.queries?.join(', ') || 'search',
        results: searchResult.results.map(r => ({
          url: r.url,
          title: r.title || '',
          snippet: (r.content || '').substring(0, 200)
        }))
      }]
    : undefined;

  return {
    ...response,
    webSearches,
    webSearchSupported: searchService.isConfigured(),
    webSearchRequested: webSearchEnabled,
    searchMetrics: searchResult ? {
      executed: searchResult.searchExecuted,
      queries: searchResult.queries,
      cachedCount: searchResult.cachedCount,
      cost: searchResult.cost,
      skipReason: searchResult.skipReason
    } : undefined
  };
}

export function getAvailableModels(tier = 'free') {
  const models = {
    openai: [],
    anthropic: [],
    gemini: []
  };

  // Filter OpenAI models by tier access
  if (openaiProvider.isConfigured()) {
    models.openai = MODELS.openai
      .filter(model => canAccessTier(tier, model.tier))
      .map(model => ({ ...model }));
  }

  // Filter Anthropic models by tier access
  if (anthropicProvider.isConfigured()) {
    models.anthropic = MODELS.anthropic
      .filter(model => canAccessTier(tier, model.tier))
      .map(model => ({ ...model }));
  }

  // Filter Gemini models by tier access
  if (geminiProvider.isConfigured()) {
    models.gemini = MODELS.gemini
      .filter(model => canAccessTier(tier, model.tier))
      .map(model => ({ ...model }));
  }

  return models;
}

export function isModelAllowed(modelId, tier) {
  // Check all models from all providers
  const allModels = [...MODELS.openai, ...MODELS.anthropic, ...MODELS.gemini];
  const model = allModels.find(m => m.id === modelId);

  if (!model) {
    console.warn(`[isModelAllowed] Model not found: "${modelId}". Available models:`, allModels.map(m => m.id));
    return false;
  }

  const allowed = canAccessTier(tier, model.tier);
  if (!allowed) {
    console.warn(`[isModelAllowed] Tier access denied: user tier "${tier}" cannot access model tier "${model.tier}" for model "${modelId}"`);
  }
  return allowed;
}

export function getProviderStatus() {
  return {
    openai: openaiProvider.isConfigured(),
    anthropic: anthropicProvider.isConfigured(),
    gemini: geminiProvider.isConfigured()
  };
}

/**
 * Generate embeddings for text using OpenAI
 * @param {Object} params - Embedding parameters
 * @param {number} params.userId - User ID for quota tracking
 * @param {string[]} params.texts - Array of texts to embed
 * @returns {Promise<{embeddings: number[][], model: string, dimensions: number}>}
 */
export async function embed({ userId, texts }) {
  // Check quota
  const quota = await checkQuota(userId);
  if (!quota.allowed) {
    const error = new Error('Monthly quota exceeded');
    error.code = 'QUOTA_EXCEEDED';
    error.quota = quota;
    throw error;
  }

  if (!openaiProvider.isConfigured()) {
    throw new Error('OpenAI provider is not configured');
  }

  const embeddings = await openaiProvider.embed(texts);

  // Track embedding usage - estimate tokens (roughly 4 chars per token)
  const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
  const estimatedTokens = Math.ceil(totalChars / 4);

  await trackUsage(userId, 'openai', openaiProvider.EMBEDDING_MODEL, {
    promptTokens: estimatedTokens,
    completionTokens: 0,
    totalTokens: estimatedTokens
  }, 'embedding');

  return {
    embeddings,
    model: openaiProvider.EMBEDDING_MODEL,
    dimensions: openaiProvider.EMBEDDING_DIMENSIONS
  };
}
