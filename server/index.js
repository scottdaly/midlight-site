import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import csrf from 'csurf';
import path from 'path';
import { fileURLToPath } from 'url';
import passport from 'passport';
import reportsRouter from './routes/reports.js';
import authRouter from './routes/auth.js';
import userRouter from './routes/user.js';
import llmRouter from './routes/llm.js';
import subscriptionRouter from './routes/subscription.js';
import stripeWebhookRouter from './routes/stripeWebhook.js';
import { configurePassport } from './config/passport.js';
import { cleanupExpiredSessions } from './services/tokenService.js';
import { getProviderStatus } from './services/llm/index.js';

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
const corsOptions = {
  origin: process.env.CORS_ORIGIN || ['http://localhost:5173', 'http://localhost:3000'],
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

app.use(express.json());
app.use(cookieParser());
app.use(passport.initialize());

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

  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic');
    return res.status(401).send('Authentication required');
  }

  const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  const user = auth[0];
  const pass = auth[1];

  const expectedUser = ADMIN_USER || 'admin';
  const expectedPass = ADMIN_PASS || 'midlight_secret';

  if (user === expectedUser && pass === expectedPass) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic');
    return res.status(401).send('Invalid credentials');
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

// Serve static files from frontend in production
const distPath = path.join(__dirname, '../dist');
app.use(express.static(distPath));

// SPA fallback - serve index.html for all non-API routes (client-side routing)
app.get('*', (req, res) => {
  // Don't serve index.html for API routes
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(distPath, 'index.html'));
});

// Cleanup expired sessions periodically (every hour)
setInterval(() => {
  try {
    const result = cleanupExpiredSessions();
    if (result.changes > 0) {
      console.log(`Cleaned up ${result.changes} expired sessions`);
    }
  } catch (error) {
    console.error('Session cleanup error:', error);
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

  // Log LLM provider status
  const providers = getProviderStatus();
  console.log(`LLM Providers: OpenAI ${providers.openai ? '✓' : '✗'}, Anthropic ${providers.anthropic ? '✓' : '✗'}`);
});
