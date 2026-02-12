import * as openaiProvider from './openaiProvider.js';
import * as anthropicProvider from './anthropicProvider.js';
import * as geminiProvider from './geminiProvider.js';
import * as kimiProvider from './kimiProvider.js';
import { checkQuota, trackUsage } from './quotaManager.js';
import * as searchService from '../search/index.js';
import { CONFIG } from '../../config/index.js';

// Combined model configuration
export const MODELS = {
  openai: openaiProvider.OPENAI_MODELS,
  anthropic: anthropicProvider.ANTHROPIC_MODELS,
  gemini: geminiProvider.GEMINI_MODELS,
  kimi: kimiProvider.KIMI_MODELS
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
    case 'kimi':
      return kimiProvider;
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}

/**
 * Cap maxTokens based on the user's subscription tier
 */
function capMaxTokens(maxTokens, tier) {
  const tierConfig = CONFIG.quota[tier] || CONFIG.quota.free;
  const tierMax = tierConfig.maxTokensPerRequest;
  return tierMax ? Math.min(maxTokens, tierMax) : maxTokens;
}

/**
 * Runs the Tavily search pipeline if enabled and configured.
 * Shared between chat() and chatWithTools().
 * Returns { messagesWithSearch, searchResult } where messagesWithSearch
 * has search context injected if search was executed.
 */
async function runSearchIfEnabled({ messages, webSearchEnabled, userTier, userId }) {
  let searchResult = null;
  let messagesWithSearch = messages;

  if (!webSearchEnabled || !searchService.isConfigured()) {
    if (webSearchEnabled && !searchService.isConfigured()) {
      console.warn('[LLM] Web search requested but TAVILY_API_KEY not configured');
    }
    return { messagesWithSearch, searchResult };
  }

  try {
    const recentContext = messages
      .slice(-6)
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role}: ${(m.content || '').substring(0, 200)}`)
      .join('\n');

    const lastUserMessage = messages
      .filter(m => m.role === 'user')
      .pop()?.content || '';

    searchResult = await searchService.executeSearchPipeline({
      userId,
      message: lastUserMessage,
      conversationContext: recentContext,
      limits: CONFIG.search.limits[userTier] || (console.warn(`[LLM] Unknown search tier '${userTier}', falling back to free limits`), CONFIG.search.limits.free)
    });

    console.log(`[LLM] Search result: executed=${searchResult.searchExecuted}, results=${searchResult.results?.length || 0}, skipReason=${searchResult.skipReason}`);

    if (searchResult.searchExecuted && searchResult.formattedContext) {
      messagesWithSearch = searchService.injectSearchContext(
        messages,
        searchResult.formattedContext
      );
      console.log(`[LLM] Search context injected, context tokens: ${searchResult.contextTokens}`);
    }
  } catch (error) {
    console.warn('[LLM] Search pipeline failed, continuing without:', error.message);
  }

  return { messagesWithSearch, searchResult };
}

export async function chat({
  userId,
  provider,
  model,
  messages,
  temperature = 0.7,
  maxTokens = 4096,
  stream = false,
  requestType = 'chat',
  webSearchEnabled = false,
  userTier = 'free',
  effortLane = null,
  promptVersion = null,
  promptVariant = null
}) {
  // Check quota
  const quota = await checkQuota(userId);
  if (!quota.allowed) {
    const error = new Error('Monthly quota exceeded');
    error.code = 'QUOTA_EXCEEDED';
    error.quota = quota;
    throw error;
  }

  // Cap maxTokens by tier
  maxTokens = capMaxTokens(maxTokens, quota.tier);

  // Get provider
  const providerService = getProvider(provider);

  if (!providerService.isConfigured()) {
    throw new Error(`Provider ${provider} is not configured`);
  }

  // Run search pipeline if enabled
  const { messagesWithSearch } = await runSearchIfEnabled({
    messages, webSearchEnabled, userTier, userId
  });

  // Make request
  if (stream) {
    return streamWithTracking({
      userId,
      provider,
      model,
      messages: messagesWithSearch,
      temperature,
      maxTokens,
      requestType,
      providerService,
      effortLane,
      promptVersion,
      promptVariant
    });
  }

  const response = await providerService.chat({
    model,
    messages: messagesWithSearch,
    temperature,
    maxTokens,
    stream: false
  });

  // Track usage
  await trackUsage(userId, provider, model, response.usage, requestType, effortLane, promptVersion, promptVariant);

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
  providerService,
  effortLane = null,
  promptVersion = null,
  promptVariant = null
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
    await trackUsage(userId, provider, model, finalUsage, requestType, effortLane, promptVersion, promptVariant);
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
  webSearchEnabled = false,
  userTier = 'free',
  effortLane = null,
  promptVersion = null,
  promptVariant = null
}) {
  // Check quota
  const quota = await checkQuota(userId);
  if (!quota.allowed) {
    const error = new Error('Monthly quota exceeded');
    error.code = 'QUOTA_EXCEEDED';
    error.quota = quota;
    throw error;
  }

  // Cap maxTokens by tier
  maxTokens = capMaxTokens(maxTokens, quota.tier);

  // Get provider
  const providerService = getProvider(provider);

  if (!providerService.isConfigured()) {
    throw new Error(`Provider ${provider} is not configured`);
  }

  // Unified search pipeline (replaces native provider search)
  const { messagesWithSearch, searchResult } = await runSearchIfEnabled({
    messages, webSearchEnabled, userTier, userId
  });

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
  await trackUsage(userId, provider, model, response.usage, requestType, effortLane, promptVersion, promptVariant);

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

export async function chatWithToolsStream({
  userId,
  provider,
  model,
  messages,
  tools,
  temperature = 0.7,
  maxTokens = 4096,
  requestType = 'agent',
  webSearchEnabled = false,
  userTier = 'free',
  effortLane = null,
  promptVersion = null,
  promptVariant = null
}) {
  const t0 = Date.now();

  // Check quota
  const quota = await checkQuota(userId);
  console.log(`[LLM Timing] Quota check: ${Date.now() - t0}ms`);
  if (!quota.allowed) {
    const error = new Error('Monthly quota exceeded');
    error.code = 'QUOTA_EXCEEDED';
    error.quota = quota;
    throw error;
  }

  // Cap maxTokens by tier
  maxTokens = capMaxTokens(maxTokens, quota.tier);

  // Get provider
  const providerService = getProvider(provider);

  if (!providerService.isConfigured()) {
    throw new Error(`Provider ${provider} is not configured`);
  }

  // Run search pipeline
  const t1 = Date.now();
  const { messagesWithSearch, searchResult } = await runSearchIfEnabled({
    messages, webSearchEnabled, userTier, userId
  });
  console.log(`[LLM Timing] Search pipeline: ${Date.now() - t1}ms`);

  let sources = [];
  if (searchResult?.searchExecuted && searchResult.results?.length > 0) {
    sources = searchResult.results.map(r => ({
      url: r.url,
      title: r.title || '',
      snippet: (r.content || '').substring(0, 200)
    }));
  }

  if (!providerService.chatWithToolsStream) {
    // Fall back to non-streaming for providers without stream support
    const response = await providerService.chatWithTools({ model, messages: messagesWithSearch, tools, temperature, maxTokens, webSearchEnabled: false });
    async function* nonStreamingFallback() {
      if (response.thinkingContent) {
        yield { type: 'thinking', thinking: response.thinkingContent };
      }
      if (response.content) {
        yield { type: 'content', content: response.content };
      }
      if (response.toolCalls) {
        for (const tc of response.toolCalls) {
          yield { type: 'tool_call', toolCall: tc };
        }
      }
      yield { type: 'done', finishReason: response.finishReason, usage: response.usage };
    }
    await trackUsage(userId, provider, model, response.usage, requestType, effortLane, promptVersion, promptVariant);
    return { stream: nonStreamingFallback(), sources };
  }

  // Create the streaming generator with usage tracking wrapper
  const providerStream = providerService.chatWithToolsStream({
    model,
    messages: messagesWithSearch,
    tools,
    temperature,
    maxTokens,
    webSearchEnabled: false
  });

  async function* streamWithTracking() {
    let finalUsage = null;
    for await (const chunk of providerStream) {
      if (chunk.type === 'done') {
        finalUsage = chunk.usage;
      }
      yield chunk;
    }
    if (finalUsage) {
      await trackUsage(userId, provider, model, finalUsage, requestType, effortLane, promptVersion, promptVariant);
    }
  }

  return {
    stream: streamWithTracking(),
    sources
  };
}

export function getAvailableModels(tier = 'free') {
  const models = {
    openai: [],
    anthropic: [],
    gemini: [],
    kimi: []
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

  // Filter Kimi models by tier access
  if (kimiProvider.isConfigured()) {
    models.kimi = MODELS.kimi
      .filter(model => canAccessTier(tier, model.tier))
      .map(model => ({ ...model }));
  }

  return models;
}

export function isModelAllowed(modelId, tier) {
  // Check all models from all providers
  const allModels = [...MODELS.openai, ...MODELS.anthropic, ...MODELS.gemini, ...MODELS.kimi];
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
    gemini: geminiProvider.isConfigured(),
    kimi: kimiProvider.isConfigured()
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
