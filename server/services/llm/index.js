import * as openaiProvider from './openaiProvider.js';
import * as anthropicProvider from './anthropicProvider.js';
import { checkQuota, trackUsage } from './quotaManager.js';

// Combined model configuration
export const MODELS = {
  openai: openaiProvider.OPENAI_MODELS,
  anthropic: anthropicProvider.ANTHROPIC_MODELS
};

// Default models by tier
export const DEFAULT_MODELS = {
  free: {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-haiku-20240307'
  },
  premium: {
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-4-20250514'
  }
};

function getProvider(providerName) {
  switch (providerName) {
    case 'openai':
      return openaiProvider;
    case 'anthropic':
      return anthropicProvider;
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
    anthropic: []
  };

  // Free tier models
  if (openaiProvider.isConfigured()) {
    models.openai.push({
      ...MODELS.openai.free,
      tier: 'free'
    });
  }

  if (anthropicProvider.isConfigured()) {
    models.anthropic.push({
      ...MODELS.anthropic.free,
      tier: 'free'
    });
  }

  // Premium tier models
  if (tier === 'premium') {
    if (openaiProvider.isConfigured()) {
      models.openai.push({
        ...MODELS.openai.premium,
        tier: 'premium'
      });
    }

    if (anthropicProvider.isConfigured()) {
      models.anthropic.push({
        ...MODELS.anthropic.premium,
        tier: 'premium'
      });
    }
  }

  return models;
}

export function isModelAllowed(model, tier) {
  const freeModels = [
    MODELS.openai.free.id,
    MODELS.anthropic.free.id
  ];

  const premiumModels = [
    MODELS.openai.premium.id,
    MODELS.anthropic.premium.id
  ];

  if (freeModels.includes(model)) {
    return true;
  }

  if (tier === 'premium' && premiumModels.includes(model)) {
    return true;
  }

  return false;
}

export function getProviderStatus() {
  return {
    openai: openaiProvider.isConfigured(),
    anthropic: anthropicProvider.isConfigured()
  };
}
