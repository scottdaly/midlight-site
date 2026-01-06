/**
 * Centralized Configuration for Backend Server
 *
 * Consolidates magic numbers and configuration values into one place.
 * Environment-specific values can be overridden via environment variables.
 */

const isProduction = process.env.NODE_ENV === 'production';

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

  // Usage quotas
  quota: {
    free: {
      monthlyRequests: 100,
      maxTokensPerRequest: 4000,
    },
    premium: {
      monthlyRequests: Infinity,
      maxTokensPerRequest: 8000,
    },
    pro: {
      monthlyRequests: Infinity,
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
    llm: 1 * 1024 * 1024, // 1MB for LLM requests
    errorReport: 100 * 1024, // 100KB for error reports
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
    timeout: 120000, // 2 minutes
    maxRetries: 2,
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
