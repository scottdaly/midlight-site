import * as openaiProvider from './openaiProvider.js';
import * as anthropicProvider from './anthropicProvider.js';
import * as geminiProvider from './geminiProvider.js';
import { checkQuota, trackUsage } from './quotaManager.js';

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

// Providers that support native web search
const WEB_SEARCH_PROVIDERS = ['anthropic', 'gemini'];

// Haiku model for fast/cheap search pass
const SEARCH_MODEL = 'claude-haiku-4-5-20251001';

// Format search results as context for injection
function formatSearchResultsAsContext(webSearches) {
  if (!webSearches || webSearches.length === 0) return '';

  const parts = [];
  for (const search of webSearches) {
    parts.push(`Search query: "${search.query}"`);
    for (const result of search.results || []) {
      parts.push(`- ${result.title}: ${result.snippet || result.url}`);
    }
  }
  return parts.join('\n');
}

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

  // Check if we need hybrid search approach
  // Gemini 3 can't combine Google Search with function calling
  const isGemini3 = provider === 'gemini' && model.startsWith('gemini-3');
  const hasCustomTools = tools && tools.length > 0;
  const needsHybridSearch = webSearchEnabled && isGemini3 && hasCustomTools && anthropicProvider.isConfigured();

  let webSearchResults = [];
  let messagesWithSearch = messages;

  if (needsHybridSearch) {
    // Step 1: Do web search with Anthropic (fast Haiku model)
    try {
      const searchResponse = await anthropicProvider.chatWithTools({
        model: SEARCH_MODEL,
        messages,
        tools: [], // No custom tools, just web search
        temperature: 0.3,
        maxTokens: 1024,
        webSearchEnabled: true
      });

      // Track the search usage separately
      if (searchResponse.usage) {
        await trackUsage(userId, 'anthropic', SEARCH_MODEL, searchResponse.usage, 'search');
      }

      // Extract web search results
      if (searchResponse.webSearches?.length > 0) {
        webSearchResults = searchResponse.webSearches;

        // Inject search results into context for the main model
        const searchContext = formatSearchResultsAsContext(webSearchResults);
        if (searchContext) {
          // Add search results to the last user message
          const lastMsgIndex = messages.length - 1;
          messagesWithSearch = [
            ...messages.slice(0, lastMsgIndex),
            {
              ...messages[lastMsgIndex],
              content: `${messages[lastMsgIndex].content}\n\n<web_search_results>\n${searchContext}\n</web_search_results>`
            }
          ];
        }
      }
    } catch (error) {
      // Log but don't fail - continue without search results
      console.warn('[LLM] Hybrid search failed, continuing without:', error.message);
    }
  }

  // Check if provider supports web search (for non-hybrid case)
  const webSearchSupported = WEB_SEARCH_PROVIDERS.includes(provider);
  // For hybrid search, we've already done the search; for Gemini 3 with tools, disable native search
  const effectiveWebSearchEnabled = needsHybridSearch ? false : (webSearchEnabled && webSearchSupported && !(isGemini3 && hasCustomTools));

  const response = await providerService.chatWithTools({
    model,
    messages: messagesWithSearch,
    tools,
    temperature,
    maxTokens,
    webSearchEnabled: effectiveWebSearchEnabled
  });

  // Track usage
  await trackUsage(userId, provider, model, response.usage, requestType);

  // Combine web search results: use hybrid results if available, otherwise provider's results
  const combinedWebSearches = webSearchResults.length > 0
    ? webSearchResults
    : response.webSearches;

  // Include web search support info in response
  return {
    ...response,
    webSearches: combinedWebSearches,
    webSearchSupported: webSearchSupported || needsHybridSearch,
    webSearchRequested: webSearchEnabled
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
