import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import passport from 'passport';
import {
  findUserByEmail,
  createUser,
  verifyPassword,
  hashIP
} from '../services/authService.js';
import {
  generateTokenPair,
  validateSession,
  invalidateSession,
  generateExchangeCode,
  exchangeCodeForTokens,
  generateOAuthState,
  validateOAuthState
} from '../services/tokenService.js';

const router = Router();

const DESKTOP_REDIRECT_BASE = process.env.DESKTOP_REDIRECT_BASE || 'midlight://auth/callback';
const WEB_REDIRECT_BASE = process.env.WEB_REDIRECT_BASE || 'http://localhost:5173';

// Validation middleware
const signupValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('displayName').optional().trim().isLength({ min: 1, max: 100 })
];

const loginValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password required')
];

// Helper to get client info
function getClientInfo(req) {
  return {
    userAgent: req.headers['user-agent'] || 'unknown',
    ipHash: hashIP(req.ip)
  };
}

// Helper to set refresh token cookie
function setRefreshCookie(res, refreshToken, expiresAt) {
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: expiresAt,
    path: '/api/auth'
  });
}

// POST /api/auth/signup
router.post('/signup', signupValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, displayName } = req.body;

    // Check if user already exists
    const existingUser = findUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Create user
    const user = await createUser({ email, password, displayName });

    // Generate tokens
    const { userAgent, ipHash } = getClientInfo(req);
    const tokens = generateTokenPair(user.id, userAgent, ipHash);

    // Set refresh token cookie
    setRefreshCookie(res, tokens.refreshToken, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url
      },
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// POST /api/auth/login
router.post('/login', loginValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Find user
    const user = findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check if user has password (might be OAuth-only)
    if (!user.password_hash) {
      return res.status(401).json({
        error: 'This account uses social login. Please sign in with Google or GitHub.'
      });
    }

    // Verify password
    const validPassword = await verifyPassword(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate tokens
    const { userAgent, ipHash } = getClientInfo(req);
    const tokens = generateTokenPair(user.id, userAgent, ipHash);

    // Set refresh token cookie
    setRefreshCookie(res, tokens.refreshToken, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url
      },
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;

    if (!refreshToken) {
      return res.status(401).json({ error: 'Refresh token required' });
    }

    // Validate refresh token
    const session = validateSession(refreshToken);
    if (!session) {
      res.clearCookie('refreshToken', { path: '/api/auth' });
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // Invalidate old session
    invalidateSession(refreshToken);

    // Generate new token pair
    const { userAgent, ipHash } = getClientInfo(req);
    const tokens = generateTokenPair(session.user_id, userAgent, ipHash);

    // Set new refresh token cookie
    setRefreshCookie(res, tokens.refreshToken, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    res.json({
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;

    if (refreshToken) {
      invalidateSession(refreshToken);
    }

    res.clearCookie('refreshToken', { path: '/api/auth' });
    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// GET /api/auth/google - Initiate Google OAuth
router.get('/google', (req, res, next) => {
  const isDesktop = req.query.desktop === 'true';
  // Dev mode: accept callback_port for local HTTP server callback (avoids protocol conflicts)
  const devCallbackPort = req.query.callback_port ? parseInt(req.query.callback_port, 10) : null;
  // Use cryptographically secure state instead of predictable 'desktop'/'web'
  const state = generateOAuthState(isDesktop, devCallbackPort);

  passport.authenticate('google', {
    scope: ['profile', 'email'],
    state
  })(req, res, next);
});

// GET /api/auth/google/callback
router.get('/google/callback', (req, res, next) => {
  // Validate state before processing callback
  const stateData = validateOAuthState(req.query.state);
  if (!stateData) {
    console.error('Google auth error: Invalid or expired OAuth state');
    return res.redirect(`${WEB_REDIRECT_BASE}/login?error=invalid_state`);
  }

  passport.authenticate('google', { session: false }, (err, user) => {
    if (err || !user) {
      console.error('Google auth error:', err);
      if (stateData.isDesktop) {
        // Dev mode: redirect to local HTTP server
        if (stateData.devCallbackPort) {
          return res.redirect(`http://localhost:${stateData.devCallbackPort}/auth/callback?error=auth_failed`);
        }
        return res.redirect(`${DESKTOP_REDIRECT_BASE}?error=auth_failed`);
      }
      return res.redirect(`${WEB_REDIRECT_BASE}/login?error=auth_failed`);
    }

    // Generate tokens
    const { userAgent, ipHash } = getClientInfo(req);
    const tokens = generateTokenPair(user.id, userAgent, ipHash);

    if (stateData.isDesktop) {
      // Desktop: use one-time exchange code instead of exposing tokens in URL
      const code = generateExchangeCode(user.id, tokens);
      // Dev mode: redirect to local HTTP server instead of protocol handler
      if (stateData.devCallbackPort) {
        return res.redirect(`http://localhost:${stateData.devCallbackPort}/auth/callback?code=${code}`);
      }
      return res.redirect(`${DESKTOP_REDIRECT_BASE}?code=${code}`);
    }

    // Web: set cookie and redirect (access token in URL is less risky for web)
    setRefreshCookie(res, tokens.refreshToken, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    res.redirect(`${WEB_REDIRECT_BASE}?accessToken=${tokens.accessToken}`);
  })(req, res, next);
});

// GET /api/auth/github - Initiate GitHub OAuth
router.get('/github', (req, res, next) => {
  const isDesktop = req.query.desktop === 'true';
  // Dev mode: accept callback_port for local HTTP server callback (avoids protocol conflicts)
  const devCallbackPort = req.query.callback_port ? parseInt(req.query.callback_port, 10) : null;
  // Use cryptographically secure state instead of predictable 'desktop'/'web'
  const state = generateOAuthState(isDesktop, devCallbackPort);

  passport.authenticate('github', {
    scope: ['user:email'],
    state
  })(req, res, next);
});

// GET /api/auth/github/callback
router.get('/github/callback', (req, res, next) => {
  // Validate state before processing callback
  const stateData = validateOAuthState(req.query.state);
  if (!stateData) {
    console.error('GitHub auth error: Invalid or expired OAuth state');
    return res.redirect(`${WEB_REDIRECT_BASE}/login?error=invalid_state`);
  }

  passport.authenticate('github', { session: false }, (err, user) => {
    if (err || !user) {
      console.error('GitHub auth error:', err);
      if (stateData.isDesktop) {
        // Dev mode: redirect to local HTTP server
        if (stateData.devCallbackPort) {
          return res.redirect(`http://localhost:${stateData.devCallbackPort}/auth/callback?error=auth_failed`);
        }
        return res.redirect(`${DESKTOP_REDIRECT_BASE}?error=auth_failed`);
      }
      return res.redirect(`${WEB_REDIRECT_BASE}/login?error=auth_failed`);
    }

    // Generate tokens
    const { userAgent, ipHash } = getClientInfo(req);
    const tokens = generateTokenPair(user.id, userAgent, ipHash);

    if (stateData.isDesktop) {
      // Desktop: use one-time exchange code instead of exposing tokens in URL
      const code = generateExchangeCode(user.id, tokens);
      // Dev mode: redirect to local HTTP server instead of protocol handler
      if (stateData.devCallbackPort) {
        return res.redirect(`http://localhost:${stateData.devCallbackPort}/auth/callback?code=${code}`);
      }
      return res.redirect(`${DESKTOP_REDIRECT_BASE}?code=${code}`);
    }

    // Web: set cookie and redirect (access token in URL is less risky for web)
    setRefreshCookie(res, tokens.refreshToken, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    res.redirect(`${WEB_REDIRECT_BASE}?accessToken=${tokens.accessToken}`);
  })(req, res, next);
});

// POST /api/auth/exchange - Exchange one-time code for tokens (desktop app only)
router.post('/exchange', (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Exchange code required' });
    }

    const result = exchangeCodeForTokens(code);

    if (!result) {
      return res.status(401).json({ error: 'Invalid or expired code' });
    }

    // Set refresh token cookie (for future refreshes)
    setRefreshCookie(res, result.refreshToken, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    res.json({
      accessToken: result.accessToken,
      expiresIn: 15 * 60 // 15 minutes
    });
  } catch (error) {
    console.error('Code exchange error:', error);
    res.status(500).json({ error: 'Code exchange failed' });
  }
});

export default router;
