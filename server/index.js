import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import csrf from 'csurf';
import path from 'path';
import { fileURLToPath } from 'url';
import { timingSafeEqual } from 'crypto';
import passport from 'passport';
import reportsRouter from './routes/reports.js';
import authRouter from './routes/auth.js';
import userRouter from './routes/user.js';
import llmRouter from './routes/llm.js';
import subscriptionRouter from './routes/subscription.js';
import stripeWebhookRouter from './routes/stripeWebhook.js';
import healthRouter from './routes/health.js';
import adminRouter from './routes/admin/index.js';
import syncRouter from './routes/sync.js';
import marketplaceRouter from './routes/marketplace.js';
import ragRouter from './routes/rag.js';
import { configurePassport } from './config/passport.js';
import { cleanupExpiredSessions } from './services/tokenService.js';
import db from './db/index.js';
import { getProviderStatus } from './services/llm/index.js';
import {
  errorHandler,
  notFoundHandler,
  setupProcessErrorHandlers
} from './middleware/errorHandler.js';
import { logger, requestLogger } from './utils/logger.js';
import { CONFIG } from './config/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Production security checks - fail fast if critical env vars are missing
if (process.env.NODE_ENV === 'production') {
  if (!process.env.ADMIN_USER || !process.env.ADMIN_PASS) {
    throw new Error('ADMIN_USER and ADMIN_PASS must be set in production');
  }
  if (process.env.ADMIN_PASS.length < 8) {
    throw new Error('ADMIN_PASS must be at least 8 characters in production');
  }
}

// Configure Passport for OAuth
configurePassport();

// Trust proxy (required for correct IP behind Nginx/Caddy)
app.set('trust proxy', 1);

// CORS configuration
// Parse CORS_ORIGIN env var as comma-separated list, or use defaults
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : [
      'http://localhost:5173',  // Web app dev server
      'http://localhost:3000',  // Alternative dev port
      'http://localhost:1420',  // Tauri desktop dev server
      'tauri://localhost',      // Tauri production webview
    ];

const corsOptions = {
  origin: allowedOrigins,
  credentials: true, // Allow cookies
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Type', 'X-CSRF-Token']
};

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "https://static.cloudflareinsights.com"],
      "connect-src": ["'self'", "https://cloudflareinsights.com"],
    },
  },
}));
app.use(cors(corsOptions));

// Stripe webhook needs raw body - mount BEFORE express.json()
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }), stripeWebhookRouter);

// Route-specific body size limits (order matters - specific routes before general)
// LLM requests can be larger (conversations with long context)
app.use('/api/llm', express.json({ limit: CONFIG.requestLimits.llm }));
// Error reports can be moderately large (stack traces, context)
app.use('/api/error-report', express.json({ limit: CONFIG.requestLimits.errorReport }));
// Sync requests can include full document content
app.use('/api/sync', express.json({ limit: CONFIG.requestLimits.sync }));
// Default for all other routes - smaller to prevent abuse
app.use(express.json({ limit: CONFIG.requestLimits.json }));
app.use(cookieParser());
app.use(passport.initialize());

// Request logging (before routes, after body parsing)
app.use('/api', requestLogger);

// Health check routes (no auth, no CSRF, no rate limiting)
// Must be accessible to monitoring tools
app.use(healthRouter);

// CSRF Protection
// Desktop app is exempt (identified by X-Client-Type header)
// Web clients must include CSRF token in requests
const csrfProtection = csrf({
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
});

// Middleware to conditionally apply CSRF protection
const conditionalCsrf = (req, res, next) => {
  // Desktop clients must use Bearer token authentication (prevents CSRF bypass via header spoofing)
  if (req.headers['x-client-type'] === 'desktop') {
    const authHeader = req.headers.authorization;
    // Allow desktop requests only if they have a Bearer token OR are auth routes
    // (auth routes don't have tokens yet - user is logging in)
    const isAuthRoute = req.baseUrl === '/api/auth' || req.path.startsWith('/auth');
    if (!isAuthRoute && (!authHeader || !authHeader.startsWith('Bearer '))) {
      return res.status(401).json({
        error: 'Desktop clients must use Bearer token authentication'
      });
    }
    return next();
  }
  // Exempt GET, HEAD, OPTIONS (safe methods)
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }
  // Exempt /api/auth/refresh - it's already protected by httpOnly + sameSite cookie
  // and needs to work before the client has obtained a CSRF token
  if (req.baseUrl === '/api/auth' && req.path === '/refresh') {
    return next();
  }
  // Apply CSRF protection for web clients on state-changing requests
  csrfProtection(req, res, next);
};

// Apply conditional CSRF to auth and user routes
app.use('/api/auth', conditionalCsrf);
app.use('/api/user', conditionalCsrf);
app.use('/api/llm', conditionalCsrf);
app.use('/api/subscription', conditionalCsrf);
app.use('/api/sync', conditionalCsrf);
app.use('/api/marketplace', conditionalCsrf);
app.use('/api/rag', conditionalCsrf);

// CSRF token endpoint for web clients
app.get('/api/csrf-token', csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// CSRF error handler
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  next(err);
});

// Rate Limiter for Submission Endpoint
const submissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100, // Limit each IP to 100 requests per `window` (here, per hour)
  standardHeaders: true,
  legacyHeaders: false,
});


// Timing-safe string comparison to prevent timing attacks
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  // Ensure both strings are the same length to prevent length-based timing attacks
  // If lengths differ, we still do a comparison to maintain constant time
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  if (aBuffer.length !== bBuffer.length) {
    // Compare a with itself to maintain constant time, then return false
    timingSafeEqual(aBuffer, aBuffer);
    return false;
  }

  return timingSafeEqual(aBuffer, bBuffer);
}

// Basic Auth Middleware for Admin
const basicAuth = (req, res, next) => {
  const ADMIN_USER = process.env.ADMIN_USER;
  const ADMIN_PASS = process.env.ADMIN_PASS;

  // In development, allow fallback credentials but warn
  if (!ADMIN_USER || !ADMIN_PASS) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'Admin authentication not configured' });
    }
    // Dev fallback - still require auth but use defaults
    console.warn('[Security] Using default admin credentials - set ADMIN_USER and ADMIN_PASS in production');
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic');
    return res.status(401).send('Authentication required');
  }

  try {
    const base64 = authHeader.slice(6);
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    const colonIndex = decoded.indexOf(':');

    if (colonIndex === -1) {
      throw new Error('Invalid auth format');
    }

    const user = decoded.slice(0, colonIndex);
    const pass = decoded.slice(colonIndex + 1);

    const expectedUser = ADMIN_USER || 'admin';
    const expectedPass = ADMIN_PASS || 'midlight_secret';

    // Use timing-safe comparison to prevent timing attacks
    if (safeCompare(user, expectedUser) && safeCompare(pass, expectedPass)) {
      next();
    } else {
      res.setHeader('WWW-Authenticate', 'Basic');
      return res.status(401).send('Invalid credentials');
    }
  } catch (error) {
    res.setHeader('WWW-Authenticate', 'Basic');
    return res.status(401).send('Invalid authorization header');
  }
};

// API Routes
// Apply rate limiter specifically to the submission endpoint
app.use('/api', (req, res, next) => {
  if (req.path === '/error-report' && req.method === 'POST') {
    submissionLimiter(req, res, next);
  } else {
    next();
  }
});

// Admin protection
app.use('/api/admin', basicAuth);

// API Routes
app.use('/api', reportsRouter);
app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);
app.use('/api/llm', llmRouter);
app.use('/api/subscription', subscriptionRouter);
app.use('/api/sync', syncRouter);
app.use('/api/marketplace', marketplaceRouter);
app.use('/api/rag', ragRouter);
app.use('/api/admin', adminRouter);

// Health check endpoints (no auth required)
app.use('/', healthRouter);

// Static files served by Caddy in production

// Error handling (must be after all routes)
app.use('/api', notFoundHandler);  // 404 for API routes
app.use(errorHandler);             // Global error handler

// Setup process-level error handlers
setupProcessErrorHandlers();

// Cleanup expired sessions periodically (every hour)
setInterval(() => {
  try {
    const result = cleanupExpiredSessions();
    if (result.changes > 0) {
      logger.info({ sessionsRemoved: result.changes }, 'Cleaned up expired sessions');
    }
  } catch (error) {
    logger.error({ error: error.message }, 'Session cleanup error');
  }
}, 60 * 60 * 1000);

// Cleanup old error reports and alert history (daily, 90-day retention)
setInterval(() => {
  try {
    const reports = db.prepare(
      "DELETE FROM error_reports WHERE received_at < datetime('now', '-90 days')"
    ).run();
    const alerts = db.prepare(
      "DELETE FROM alert_history WHERE triggered_at < datetime('now', '-90 days')"
    ).run();
    if (reports.changes > 0 || alerts.changes > 0) {
      logger.info({
        reportsRemoved: reports.changes,
        alertsRemoved: alerts.changes
      }, 'Cleaned up old error reports and alerts');
    }
  } catch (error) {
    logger.error({ error: error.message }, 'Error report cleanup error');
  }
}, 24 * 60 * 60 * 1000);

app.listen(PORT, () => {
  const providers = getProviderStatus();

  logger.info({
    port: PORT,
    env: process.env.NODE_ENV || 'development',
    providers: {
      openai: providers.openai,
      anthropic: providers.anthropic,
    },
  }, 'Server started');
});
