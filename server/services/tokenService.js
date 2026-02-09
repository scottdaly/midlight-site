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

const MAX_SESSIONS_PER_USER = 10;

export async function createSession(userId, refreshToken, userAgent, ipHash) {
  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  // Enforce per-user session cap — delete oldest sessions if at limit
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE user_id = ?');
  const { count } = countStmt.get(userId);
  if (count >= MAX_SESSIONS_PER_USER) {
    const deleteOldest = db.prepare(`
      DELETE FROM sessions WHERE id IN (
        SELECT id FROM sessions WHERE user_id = ?
        ORDER BY created_at ASC LIMIT ?
      )
    `);
    deleteOldest.run(userId, count - MAX_SESSIONS_PER_USER + 1);
  }

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
 * Generate a one-time exchange code that can be traded for tokens.
 * Only stores a hash of the code + userId — no tokens stored.
 * @param {number} userId - The user ID
 * @returns {string} - The exchange code
 */
export function generateExchangeCode(userId) {
  const code = crypto.randomBytes(32).toString('hex');
  const codeHash = hashToken(code);
  const expiresAt = new Date(Date.now() + EXCHANGE_CODE_EXPIRY_MS);

  const stmt = db.prepare(`
    INSERT INTO oauth_codes (code, user_id, access_token, refresh_token, expires_at)
    VALUES (?, ?, '', '', ?)
  `);

  stmt.run(codeHash, userId, expiresAt.toISOString());

  return code;
}

/**
 * Exchange a one-time code for tokens (single use).
 * Generates fresh tokens at exchange time instead of retrieving stored ones.
 * @param {string} code - The exchange code
 * @param {string} userAgent - Client user agent
 * @param {string} ipHash - Hashed client IP
 * @returns {object|null} - Tokens object or null if invalid/expired/used
 */
export function exchangeCodeForTokens(code, userAgent, ipHash) {
  const codeHash = hashToken(code);

  // Lookup by hash
  const getStmt = db.prepare(`
    SELECT * FROM oauth_codes
    WHERE code = ? AND used = 0 AND expires_at > datetime('now')
  `);

  const codeRecord = getStmt.get(codeHash);

  if (!codeRecord) {
    return null;
  }

  // Mark as used immediately (single use)
  const updateStmt = db.prepare('UPDATE oauth_codes SET used = 1 WHERE code = ?');
  updateStmt.run(codeHash);

  // Generate fresh tokens at exchange time
  const tokens = generateTokenPair(codeRecord.user_id, userAgent || 'unknown', ipHash || 'unknown');

  return {
    userId: codeRecord.user_id,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken
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
// Persisted in database to survive server restarts

const OAUTH_STATE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a secure OAuth state token (persisted in DB)
 * @param {boolean} isDesktop - Whether this is a desktop app OAuth flow
 * @param {number|null} devCallbackPort - Port for dev mode HTTP callback (null for production/protocol)
 * @returns {string} - The state token
 */
export function generateOAuthState(isDesktop, devCallbackPort = null) {
  const state = crypto.randomBytes(32).toString('hex');
  const stateHash = hashToken(state);
  const expiresAt = new Date(Date.now() + OAUTH_STATE_EXPIRY_MS);

  const stmt = db.prepare(`
    INSERT INTO oauth_states (state_hash, is_desktop, dev_callback_port, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(stateHash, isDesktop ? 1 : 0, devCallbackPort, expiresAt.toISOString());

  return state;
}

/**
 * Validate and consume an OAuth state token (single use)
 * @param {string} state - The state token to validate
 * @returns {object|null} - State data or null if invalid/expired
 */
export function validateOAuthState(state) {
  const stateHash = hashToken(state);

  const getStmt = db.prepare(`
    SELECT * FROM oauth_states
    WHERE state_hash = ? AND expires_at > datetime('now')
  `);
  const stateData = getStmt.get(stateHash);

  if (!stateData) {
    return null;
  }

  // Consume the state (single use — delete immediately)
  const deleteStmt = db.prepare('DELETE FROM oauth_states WHERE state_hash = ?');
  deleteStmt.run(stateHash);

  return {
    isDesktop: stateData.is_desktop === 1,
    devCallbackPort: stateData.dev_callback_port
  };
}

/**
 * Clean up expired OAuth states
 */
export function cleanupExpiredOAuthStates() {
  const stmt = db.prepare("DELETE FROM oauth_states WHERE expires_at <= datetime('now')");
  return stmt.run();
}

// Password Reset Token Functions

const PASSWORD_RESET_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

/**
 * Generate a password reset token for a user
 * @param {number} userId - The user ID
 * @returns {string} - The reset token
 */
export function generatePasswordResetToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_MS);

  // Delete any existing reset tokens for this user
  const deleteStmt = db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?');
  deleteStmt.run(userId);

  // Insert new token
  const stmt = db.prepare(`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(userId, tokenHash, expiresAt.toISOString());

  return token;
}

/**
 * Validate a password reset token
 * @param {string} token - The reset token
 * @returns {object|null} - User ID and email if valid, null otherwise
 */
export function validatePasswordResetToken(token) {
  const tokenHash = hashToken(token);

  const stmt = db.prepare(`
    SELECT prt.user_id, u.email, u.display_name
    FROM password_reset_tokens prt
    JOIN users u ON prt.user_id = u.id
    WHERE prt.token_hash = ? AND prt.expires_at > datetime('now')
  `);

  return stmt.get(tokenHash) || null;
}

/**
 * Consume (delete) a password reset token after successful reset
 * @param {string} token - The reset token
 */
export function consumePasswordResetToken(token) {
  const tokenHash = hashToken(token);
  const stmt = db.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ?');
  stmt.run(tokenHash);
}

/**
 * Clean up expired password reset tokens
 */
export function cleanupExpiredPasswordResetTokens() {
  const stmt = db.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= datetime('now')");
  return stmt.run();
}

// Email Verification Token Functions

const EMAIL_VERIFICATION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Generate an email verification token for a user
 * @param {number} userId - The user ID
 * @returns {string} - The verification token
 */
export function generateEmailVerificationToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MS);

  // Delete any existing verification tokens for this user
  const deleteStmt = db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?');
  deleteStmt.run(userId);

  // Insert new token
  const stmt = db.prepare(`
    INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(userId, tokenHash, expiresAt.toISOString());

  return token;
}

/**
 * Validate an email verification token
 * @param {string} token - The verification token
 * @returns {object|null} - User ID and email if valid, null otherwise
 */
export function validateEmailVerificationToken(token) {
  const tokenHash = hashToken(token);

  const stmt = db.prepare(`
    SELECT evt.user_id, u.email, u.display_name
    FROM email_verification_tokens evt
    JOIN users u ON evt.user_id = u.id
    WHERE evt.token_hash = ? AND evt.expires_at > datetime('now')
  `);

  return stmt.get(tokenHash) || null;
}

/**
 * Consume (delete) an email verification token after successful verification
 * @param {string} token - The verification token
 */
export function consumeEmailVerificationToken(token) {
  const tokenHash = hashToken(token);
  const stmt = db.prepare('DELETE FROM email_verification_tokens WHERE token_hash = ?');
  stmt.run(tokenHash);
}

/**
 * Clean up expired email verification tokens
 */
export function cleanupExpiredEmailVerificationTokens() {
  const stmt = db.prepare("DELETE FROM email_verification_tokens WHERE expires_at <= datetime('now')");
  return stmt.run();
}
