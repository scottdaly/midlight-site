import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db from '../db/index.js';

// Production secret validation - fail fast if secrets are weak or missing
if (process.env.NODE_ENV === 'production') {
  if (!process.env.ACCESS_TOKEN_SECRET || process.env.ACCESS_TOKEN_SECRET.includes('dev-')) {
    throw new Error('ACCESS_TOKEN_SECRET must be set in production (cannot contain "dev-")');
  }
  if (!process.env.REFRESH_TOKEN_SECRET || process.env.REFRESH_TOKEN_SECRET.includes('dev-')) {
    throw new Error('REFRESH_TOKEN_SECRET must be set in production (cannot contain "dev-")');
  }
  if (process.env.ACCESS_TOKEN_SECRET.length < 32) {
    throw new Error('ACCESS_TOKEN_SECRET must be at least 32 characters');
  }
  if (process.env.REFRESH_TOKEN_SECRET.length < 32) {
    throw new Error('REFRESH_TOKEN_SECRET must be at least 32 characters');
  }
}

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'dev-access-secret-change-in-production';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'dev-refresh-secret-change-in-production';

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

export function generateAccessToken(userId) {
  return jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

export function generateRefreshToken() {
  return crypto.randomBytes(64).toString('hex');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, ACCESS_TOKEN_SECRET);
  } catch (error) {
    return null;
  }
}

export async function createSession(userId, refreshToken, userAgent, ipHash) {
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  // Remove any existing sessions from the same user/device combination
  // This prevents duplicate sessions when a user logs in multiple times from the same browser
  const deleteStmt = db.prepare(`
    DELETE FROM sessions
    WHERE user_id = ? AND user_agent = ? AND ip_hash = ?
  `);
  deleteStmt.run(userId, userAgent, ipHash);

  const stmt = db.prepare(`
    INSERT INTO sessions (user_id, refresh_token_hash, user_agent, ip_hash, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(userId, tokenHash, userAgent, ipHash, expiresAt.toISOString());

  return {
    refreshToken,
    expiresAt
  };
}

export function validateSession(refreshToken) {
  const tokenHash = hashToken(refreshToken);

  const stmt = db.prepare(`
    SELECT s.*, u.id as user_id, u.email, u.display_name, u.avatar_url
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.refresh_token_hash = ? AND s.expires_at > datetime('now')
  `);

  return stmt.get(tokenHash);
}

export function invalidateSession(refreshToken) {
  const tokenHash = hashToken(refreshToken);

  const stmt = db.prepare('DELETE FROM sessions WHERE refresh_token_hash = ?');
  return stmt.run(tokenHash);
}

export function invalidateAllUserSessions(userId) {
  const stmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  return stmt.run(userId);
}

export function cleanupExpiredSessions() {
  const stmt = db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')");
  return stmt.run();
}

export function generateTokenPair(userId, userAgent, ipHash) {
  const accessToken = generateAccessToken(userId);
  const refreshToken = generateRefreshToken();

  createSession(userId, refreshToken, userAgent, ipHash);

  return {
    accessToken,
    refreshToken,
    expiresIn: 15 * 60 // 15 minutes in seconds
  };
}

// OAuth Exchange Code Functions
// These allow OAuth to use one-time codes instead of exposing tokens in URLs

const EXCHANGE_CODE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a one-time exchange code that can be traded for tokens
 * @param {number} userId - The user ID
 * @param {object} tokens - Object with accessToken and refreshToken
 * @returns {string} - The exchange code
 */
export function generateExchangeCode(userId, tokens) {
  const code = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + EXCHANGE_CODE_EXPIRY_MS);

  const stmt = db.prepare(`
    INSERT INTO oauth_codes (code, user_id, access_token, refresh_token, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(code, userId, tokens.accessToken, tokens.refreshToken, expiresAt.toISOString());

  return code;
}

/**
 * Exchange a one-time code for tokens (single use)
 * @param {string} code - The exchange code
 * @returns {object|null} - Tokens object or null if invalid/expired/used
 */
export function exchangeCodeForTokens(code) {
  // Get the code
  const getStmt = db.prepare(`
    SELECT * FROM oauth_codes
    WHERE code = ? AND used = 0 AND expires_at > datetime('now')
  `);

  const codeRecord = getStmt.get(code);

  if (!codeRecord) {
    return null;
  }

  // Mark as used immediately (single use)
  const updateStmt = db.prepare('UPDATE oauth_codes SET used = 1 WHERE code = ?');
  updateStmt.run(code);

  return {
    userId: codeRecord.user_id,
    accessToken: codeRecord.access_token,
    refreshToken: codeRecord.refresh_token
  };
}

/**
 * Clean up expired/used exchange codes
 */
export function cleanupExpiredCodes() {
  const stmt = db.prepare(`
    DELETE FROM oauth_codes
    WHERE used = 1 OR expires_at <= datetime('now')
  `);
  return stmt.run();
}

// OAuth State Management
// Use cryptographically secure state tokens instead of predictable values

const pendingOAuthStates = new Map();
const OAUTH_STATE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a secure OAuth state token
 * @param {boolean} isDesktop - Whether this is a desktop app OAuth flow
 * @param {number|null} devCallbackPort - Port for dev mode HTTP callback (null for production/protocol)
 * @returns {string} - The state token
 */
export function generateOAuthState(isDesktop, devCallbackPort = null) {
  const state = crypto.randomBytes(32).toString('hex');

  pendingOAuthStates.set(state, {
    isDesktop,
    devCallbackPort,
    createdAt: Date.now()
  });

  // Clean up after expiry
  setTimeout(() => {
    pendingOAuthStates.delete(state);
  }, OAUTH_STATE_EXPIRY_MS);

  return state;
}

/**
 * Validate and consume an OAuth state token
 * @param {string} state - The state token to validate
 * @returns {object|null} - State data or null if invalid/expired
 */
export function validateOAuthState(state) {
  const stateData = pendingOAuthStates.get(state);

  if (!stateData) {
    return null;
  }

  // Check expiry
  if (Date.now() - stateData.createdAt > OAUTH_STATE_EXPIRY_MS) {
    pendingOAuthStates.delete(state);
    return null;
  }

  // Consume the state (single use)
  pendingOAuthStates.delete(state);

  return stateData;
}
