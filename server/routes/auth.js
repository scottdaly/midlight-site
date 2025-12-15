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
import { authLimiter, signupLimiter, refreshLimiter } from '../middleware/rateLimiters.js';

const router = Router();

const DESKTOP_REDIRECT_BASE = process.env.DESKTOP_REDIRECT_BASE || 'midlight://auth/callback';
const WEB_REDIRECT_BASE = process.env.WEB_REDIRECT_BASE || 'http://localhost:5173';

// Helper to render desktop OAuth callback page
// This page opens the protocol handler and attempts to close the browser tab
function renderDesktopCallbackPage(res, { success, code, error }) {
  const protocolUrl = success
    ? `${DESKTOP_REDIRECT_BASE}?code=${code}`
    : `${DESKTOP_REDIRECT_BASE}?error=${error || 'auth_failed'}`;

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>${success ? 'Opening Midlight...' : 'Authentication Failed'} - Midlight</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            background: #050505;
            color: #ededed;
            padding: 20px;
          }
          .card {
            text-align: center;
            max-width: 420px;
            padding: 3rem 2.5rem;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 16px;
          }
          .icon-error {
            width: 48px;
            height: 48px;
            margin: 0 auto 1.5rem;
            color: #f87171;
          }
          h1 {
            font-size: 1.5rem;
            font-weight: 600;
            letter-spacing: -0.02em;
            margin-bottom: 0.75rem;
            color: #ededed;
          }
          p {
            color: #888888;
            margin-bottom: 1.5rem;
            line-height: 1.6;
            font-size: 1rem;
          }
          .btn {
            display: inline-block;
            padding: 1rem 2rem;
            background: #f2f2f2;
            color: #050505;
            text-decoration: none;
            border-radius: 50px;
            font-weight: 600;
            font-size: 0.95rem;
            transition: transform 0.2s ease, box-shadow 0.2s ease;
          }
          .btn:hover {
            transform: scale(1.02);
            box-shadow: 0 0 20px rgba(255, 255, 255, 0.15);
          }
          .status {
            margin-top: 1.5rem;
            font-size: 0.875rem;
            color: #666666;
          }
          .status.opening {
            color: #888888;
          }
        </style>
      </head>
      <body>
        <div class="card">
          ${success ? `
            <h1>Opening Midlight...</h1>
            <p>You've signed in successfully. The app should open automatically.</p>
            <a href="${protocolUrl}" class="btn">Open Midlight</a>
            <p class="status opening">Didn't work? Click the button above.</p>
          ` : `
            <svg class="icon-error" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <h1>Authentication Failed</h1>
            <p>Something went wrong during sign in. Please close this tab and try again in the app.</p>
            <a href="${protocolUrl}" class="btn">Back to Midlight</a>
          `}
        </div>
        <script>
          // Immediately try to open the protocol handler
          window.location.href = '${protocolUrl}';

          // Try to close this tab after a delay (gives time for protocol to launch)
          setTimeout(function() {
            window.close();
          }, 2000);
        </script>
      </body>
    </html>
  `;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
}

// Validation middleware
const signupValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number'),
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
router.post('/signup', signupLimiter, signupValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, displayName } = req.body;

    // Check if user already exists
    const existingUser = findUserByEmail(email);
    if (existingUser) {
      // Check if this is an OAuth-only account
      if (!existingUser.password_hash) {
        return res.status(409).json({
          error: 'An account with this email already exists. Try signing in with Google instead.'
        });
      }
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
router.post('/login', authLimiter, loginValidation, async (req, res) => {
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
        error: 'This account uses social login. Please sign in with Google.'
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
router.post('/refresh', refreshLimiter, (req, res) => {
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
        // Production: render callback page that opens protocol and closes tab
        return renderDesktopCallbackPage(res, { success: false, error: 'auth_failed' });
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
      // Production: render callback page that opens protocol and closes tab
      return renderDesktopCallbackPage(res, { success: true, code });
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
