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

export async function chatWithTools({
  userId,
  provider,
  model,
  messages,
  tools,
  temperature = 0.7,
  maxTokens = 4096,
  requestType = 'agent'
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

  const response = await providerService.chatWithTools({
    model,
    messages,
    tools,
    temperature,
    maxTokens
  });

  // Track usage
  await trackUsage(userId, provider, model, response.usage, requestType);

  return response;
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
    return false;
  }

  return canAccessTier(tier, model.tier);
}

export function getProviderStatus() {
  return {
    openai: openaiProvider.isConfigured(),
    anthropic: anthropicProvider.isConfigured(),
    gemini: geminiProvider.isConfigured()
  };
}
