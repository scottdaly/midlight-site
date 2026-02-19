import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
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
import performanceRouter from './routes/performance.js';
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
import promptsRouter from './routes/prompts.js';
import shareRouter from './routes/share.js';
import commentsRouter from './routes/comments.js';
import suggestionsRouter from './routes/suggestions.js';
import activityRouter from './routes/activity.js';
import notificationsRouter from './routes/notifications.js';
import teamsRouter from './routes/teams.js';
import branchesRouter from './routes/branches.js';
import { adminLimiter } from './middleware/rateLimiters.js';
import { configurePassport } from './config/passport.js';
import db from './db/index.js';
import { startCleanupService } from './services/cleanupService.js';
import { getProviderStatus } from './services/llm/index.js';
import { countStaleMobileDevices, pruneStaleMobileDevices } from './services/mobileDeviceService.js';
import {
  errorHandler,
  notFoundHandler,
  setupProcessErrorHandlers
} from './middleware/errorHandler.js';
import { logger, requestLogger } from './utils/logger.js';
import { CONFIG } from './config/index.js';
import { startSyncCleanup } from './services/syncCleanupService.js';
import { WebSocketServer } from 'ws';
import { hocuspocus } from './services/collabService.js';

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
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Client-Type',
    'X-CSRF-Token',
    'X-Share-Token',
    'X-Midlight-Client',
    'X-Midlight-Platform',
    'X-Midlight-App-Version',
    'X-Midlight-Build-Channel',
    'X-Midlight-Network-State',
  ]
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
// Share requests can include document content (for collaborative edits)
app.use('/api/share', express.json({ limit: '5mb' }));
// Default for all other routes - smaller to prevent abuse
app.use(express.json({ limit: CONFIG.requestLimits.json }));
app.use(cookieParser());
app.use(passport.initialize());

// Request logging (before routes, after body parsing)
app.use('/api', requestLogger);

// Health check routes (no auth, no CSRF, no rate limiting)
// Must be accessible to monitoring tools
app.use(healthRouter);
app.use('/api', healthRouter);

// CSRF Protection
// Native clients (desktop/mobile) are exempt because they rely on bearer tokens
// instead of browser cookies.
// Web clients must include CSRF token in state-changing requests.
const csrfProtection = csrf({
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
});

// Middleware to conditionally apply CSRF protection
const conditionalCsrf = (req, res, next) => {
  const legacyClientType = String(req.headers['x-client-type'] || '').toLowerCase();
  const midlightClient = String(req.headers['x-midlight-client'] || req.body?.client || '').toLowerCase();
  const midlightPlatform = String(req.headers['x-midlight-platform'] || req.body?.platform || '').toLowerCase();
  const isNativeClient = legacyClientType === 'desktop'
    || ['desktop', 'ios', 'android', 'mobile', 'native'].includes(midlightClient)
    || ['ios', 'android'].includes(midlightPlatform);

  // Native clients must use Bearer auth on non-auth routes (prevents spoofed bypass).
  if (isNativeClient) {
    const authHeader = req.headers.authorization;
    // Auth routes are allowed without bearer (login/exchange/bootstrap flows).
    const isAuthRoute = req.baseUrl === '/api/auth' || req.path.startsWith('/auth');
    if (!isAuthRoute && (!authHeader || !authHeader.startsWith('Bearer '))) {
      return res.status(401).json({
        error: 'Native clients must use Bearer token authentication'
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
app.use('/api/share', conditionalCsrf);
app.use('/api/comments', conditionalCsrf);
app.use('/api/suggestions', conditionalCsrf);
app.use('/api/activity', conditionalCsrf);
app.use('/api/notifications', conditionalCsrf);
app.use('/api/teams', conditionalCsrf);
app.use('/api/branches', conditionalCsrf);
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
  windowMs: CONFIG.rateLimit.errorReport.windowMs,
  max: CONFIG.rateLimit.errorReport.max,
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
  if (
    req.method === 'POST' &&
    (req.path === '/error-report' || req.path === '/error-report/batch')
  ) {
    submissionLimiter(req, res, next);
  } else {
    next();
  }
});

// Admin protection
app.use('/api/admin', adminLimiter, (req, res, next) => {
  // Sourcemap upload uses API-key bearer auth inside the route handler.
  // Keep admin Basic Auth for all other admin endpoints.
  if (req.path === '/sourcemaps/upload') {
    return next();
  }
  return basicAuth(req, res, next);
});

// API Routes
app.use('/api', reportsRouter);
app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);
app.use('/api/llm', llmRouter);
app.use('/api/subscription', subscriptionRouter);
app.use('/api/sync', syncRouter);
app.use('/api/share', shareRouter);
app.use('/api/comments', commentsRouter);
app.use('/api/suggestions', suggestionsRouter);
app.use('/api/activity', activityRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/teams', teamsRouter);
app.use('/api/branches', branchesRouter);
app.use('/api/marketplace', marketplaceRouter);
app.use('/api/rag', ragRouter);
app.use('/api/prompts', promptsRouter);
app.use('/api/perf-report', performanceRouter);
app.use('/api/admin/performance', performanceRouter);
app.use('/api/admin', adminRouter);

// Health check endpoints (no auth required)
app.use('/', healthRouter);

// Static files served by Caddy in production

// Error handling (must be after all routes)
app.use('/api', notFoundHandler);  // 404 for API routes
app.use(errorHandler);             // Global error handler

// Setup process-level error handlers
setupProcessErrorHandlers();

// Create HTTP server for Express + WebSocket upgrade handling
const server = createServer(app);

function shouldRunMobileDevicePruneOnStartup() {
  if (process.env.MOBILE_DEVICE_PRUNE_ON_STARTUP != null) {
    return process.env.MOBILE_DEVICE_PRUNE_ON_STARTUP === 'true';
  }
  return process.env.NODE_ENV === 'production';
}

function runStartupMobileDeviceMaintenance() {
  if (!shouldRunMobileDevicePruneOnStartup()) {
    return;
  }

  const staleDays = Math.max(1, Number(process.env.MOBILE_DEVICE_STALE_DAYS || 60) || 60);
  const before = countStaleMobileDevices({ staleDays });
  const deleted = pruneStaleMobileDevices({ staleDays });

  logger.info({
    staleDays,
    staleBefore: before,
    pruned: deleted,
  }, 'Mobile device maintenance completed');
}

// WebSocket upgrade handler for collaborative editing
const collabWss = new WebSocketServer({ noServer: true });

collabWss.on('connection', (ws, request) => {
  hocuspocus.handleConnection(ws, request);
});

server.on('upgrade', (request, socket, head) => {
  if (!request.url?.startsWith('/collab')) {
    socket.destroy();
    return;
  }

  // Origin validation (CORS doesn't apply to WebSocket upgrades)
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    logger.warn({ origin }, 'WebSocket upgrade rejected: invalid origin');
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  collabWss.handleUpgrade(request, socket, head, (ws) => {
    collabWss.emit('connection', ws, request);
  });
});

server.listen(PORT, () => {
  const providers = getProviderStatus();

  // Start sync cleanup service (expired documents, resolved conflicts, old logs)
  startSyncCleanup();

  // Start consolidated cleanup service (expired tokens, sessions, old audit data)
  startCleanupService();

  // Prune stale mobile push registrations
  runStartupMobileDeviceMaintenance();

  logger.info({
    port: PORT,
    env: process.env.NODE_ENV || 'development',
    providers: {
      openai: providers.openai,
      anthropic: providers.anthropic,
    },
  }, 'Server started');
});

// Graceful shutdown: flush Y.js state before exit
function gracefulShutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  server.close();
  collabWss.close();
  hocuspocus.destroy();
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
