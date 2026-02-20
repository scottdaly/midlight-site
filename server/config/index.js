/**
 * Centralized Configuration for Backend Server
 *
 * Consolidates magic numbers and configuration values into one place.
 * Environment-specific values can be overridden via environment variables.
 */

import { ATTACHMENT_LIMITS, REQUEST_LIMITS, PDF_EXTRACTION_LIMITS } from './attachmentLimits.js';

const isProduction = process.env.NODE_ENV === 'production';

function parseBooleanEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseAttachmentValidationModeEnv(defaultValue) {
  const raw = process.env.LLM_ATTACHMENT_VALIDATION_MODE;
  if (raw == null) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'strict' || normalized === 'warn' || normalized === 'off') {
    return normalized;
  }
  return defaultValue;
}

function parseMultimodalStrictValidationEnv(defaultValue) {
  const raw = process.env.LLM_MULTIMODAL_STRICT_VALIDATION;
  if (raw == null) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return 'strict';
  if (['false', '0', 'no', 'off'].includes(normalized)) return 'warn';
  return defaultValue;
}

function parsePositiveIntegerEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

const legacyAttachmentValidationEnabled = parseBooleanEnv('LLM_ATTACHMENT_VALIDATION_ENABLED', true);
const defaultAttachmentValidationMode = legacyAttachmentValidationEnabled ? 'strict' : 'off';
const strictValidationFlagMode = parseMultimodalStrictValidationEnv(defaultAttachmentValidationMode);

export const CONFIG = {
  // Rate limiting configurations
  rateLimit: {
    // Auth endpoints (signup, login)
    auth: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // requests per window
    },
    // LLM proxy (per tier)
    llm: {
      free: {
        windowMs: 60 * 1000, // 1 minute
        max: 10,
      },
      premium: {
        windowMs: 60 * 1000,
        max: 30,
      },
      pro: {
        windowMs: 60 * 1000,
        max: 60,
      },
    },
    // Sync operations (per tier)
    sync: {
      free: {
        windowMs: 60 * 1000, // 1 minute
        max: 20, // Lower rate for free tier
      },
      premium: {
        windowMs: 60 * 1000,
        max: 60,
      },
      pro: {
        windowMs: 60 * 1000,
        max: 120,
      },
    },
    // Password change attempts
    password: {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 5,
    },
    // Error reports
    errorReport: {
      windowMs: 60 * 1000,
      max: 10,
    },
  },

  // Usage quotas (token-based)
  quota: {
    free: {
      monthlyTokens: 500000,
      maxTokensPerRequest: 4000,
    },
    premium: {
      monthlyTokens: Infinity,
      maxTokensPerRequest: 8000,
    },
    pro: {
      monthlyTokens: Infinity,
      maxTokensPerRequest: 16000,
    },
  },

  // Token expiration times
  tokens: {
    accessExpiry: '15m',
    refreshExpiry: '7d',
    oauthCodeExpiry: 5 * 60 * 1000, // 5 minutes in ms
    passwordResetExpiry: 60 * 60 * 1000, // 1 hour in ms
  },

  // Pagination defaults
  pagination: {
    defaultLimit: 50,
    maxLimit: 1000,
  },

  // Request size limits (in bytes)
  requestLimits: {
    json: 10 * 1024, // 10KB default
    // Multimodal LLM payload cap (mirrors client-side preflight checks).
    llm: REQUEST_LIMITS.llmPayloadBytes,
    errorReport: 100 * 1024, // 100KB for error reports
    sync: 5 * 1024 * 1024, // 5MB for document sync
  },

  // Sync storage quotas (in bytes)
  syncStorage: {
    free: {
      maxBytes: 100 * 1024 * 1024, // 100MB
      maxDocuments: 100,
    },
    premium: {
      maxBytes: 1024 * 1024 * 1024, // 1GB
      maxDocuments: 1000,
    },
    pro: {
      maxBytes: 10 * 1024 * 1024 * 1024, // 10GB
      maxDocuments: 10000,
    },
  },

  // Session / Cookie settings
  session: {
    cookieName: 'midlight_session',
    cookieMaxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    secure: isProduction,
    sameSite: isProduction ? 'strict' : 'lax',
  },

  // CORS settings
  cors: {
    allowedOrigins: [
      process.env.WEB_REDIRECT_BASE,
      'https://midlight.ai',
      !isProduction && 'http://localhost:5173',
    ].filter(Boolean),
    credentials: true,
  },

  // LLM Provider settings
  llm: {
    defaultProvider: 'anthropic',
    maxRetries: 2,
    guardrails: {
      attachmentValidation: legacyAttachmentValidationEnabled,
      attachmentValidationMode: parseAttachmentValidationModeEnv(
        strictValidationFlagMode
      ),
    },
    pdfExtraction: {
      maxPdfBytes: parsePositiveIntegerEnv(
        'LLM_PDF_EXTRACTION_MAX_PDF_BYTES',
        PDF_EXTRACTION_LIMITS.maxPdfBytes ?? ATTACHMENT_LIMITS.maxDocumentBytes
      ),
      maxPages: parsePositiveIntegerEnv('LLM_PDF_EXTRACTION_MAX_PAGES', PDF_EXTRACTION_LIMITS.maxPages),
      maxTextChars: parsePositiveIntegerEnv(
        'LLM_PDF_EXTRACTION_MAX_TEXT_CHARS',
        PDF_EXTRACTION_LIMITS.maxTextChars
      ),
    },
    providers: {
      anthropic: {
        defaultModel: 'claude-sonnet-4-20250514',
        maxTokens: 4096,
      },
      openai: {
        defaultModel: 'gpt-4-turbo-preview',
        maxTokens: 4096,
      },
    },
  },

  // Web search settings (Tavily-based)
  search: {
    enabled: !!process.env.TAVILY_API_KEY,
    cacheTtlMinutes: parseInt(process.env.SEARCH_CACHE_TTL_MINUTES) || 15,
    limits: {
      free: {
        maxSearchesPerDay: 20,
        maxCostPerMonthCents: 100, // $1
      },
      premium: {
        maxSearchesPerDay: 50,
        maxCostPerMonthCents: 500, // $5
      },
      pro: {
        maxSearchesPerDay: 100,
        maxCostPerMonthCents: 1000, // $10
      },
      enterprise: {
        maxSearchesPerDay: 200,
        maxCostPerMonthCents: 2000, // $20
      },
    },
    // Cleanup interval for expired cache
    cacheCleanupIntervalMs: 60 * 60 * 1000, // 1 hour
  },

  // Database settings
  database: {
    // Cleanup old data intervals
    cleanup: {
      expiredTokensIntervalMs: 60 * 60 * 1000, // 1 hour
      oldUsageLogsIntervalMs: 24 * 60 * 60 * 1000, // 1 day
      usageRetentionDays: 90,
    },
  },

  // Error reporting
  errorReporting: {
    enabled: isProduction,
    maxMessageLength: 10000,
    maxContextSize: 50000,
  },

  // Health check
  health: {
    path: '/health',
    readyPath: '/health/ready',
  },

  // Admin settings
  admin: {
    realm: 'Admin Area',
  },
};

/**
 * Get a config value with optional default
 * @param {string} path - Dot-notation path (e.g., 'rateLimit.auth.max')
 * @param {*} defaultValue - Default value if path not found
 */
export function getConfig(path, defaultValue = undefined) {
  const keys = path.split('.');
  let value = CONFIG;

  for (const key of keys) {
    if (value === undefined || value === null) {
      return defaultValue;
    }
    value = value[key];
  }

  return value !== undefined ? value : defaultValue;
}

/**
 * Check if running in production
 */
export function isProductionEnv() {
  return isProduction;
}

export default CONFIG;
