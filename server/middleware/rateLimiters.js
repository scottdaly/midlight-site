import rateLimit from 'express-rate-limit';
import { createHash } from 'crypto';
import db from '../db/index.js';

// Rate Limiter for Admin API (already behind Basic Auth, generous limit)
export const adminLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // High limit since already behind Basic Auth
  message: { error: 'Too many admin requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate Limiters for Auth Endpoints (brute force protection)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window per IP
  message: { error: 'Too many authentication attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 signups per hour per IP
  message: { error: 'Too many accounts created, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // More lenient for token refresh
  message: { error: 'Too many refresh attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const exchangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window per IP
  message: { error: 'Too many exchange attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================================================
// Password Change Rate Limiting (database-backed, per-user)
// ============================================================================

const PASSWORD_RATE_LIMIT = {
  maxAttempts: 5,      // Max failed attempts
  windowMinutes: 60,   // Time window in minutes
};

/**
 * Hash an IP address for privacy-preserving storage
 */
function hashIp(ip) {
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex').substring(0, 16);
}

/**
 * Check if user has exceeded password change rate limit
 * @param {number} userId - User ID to check
 * @returns {boolean} - True if under limit, false if exceeded
 */
export function checkPasswordRateLimit(userId) {
  const since = new Date(Date.now() - PASSWORD_RATE_LIMIT.windowMinutes * 60 * 1000).toISOString();

  const result = db.prepare(`
    SELECT COUNT(*) as count FROM password_attempts
    WHERE user_id = ? AND attempted_at > ? AND success = 0
  `).get(userId, since);

  return result.count < PASSWORD_RATE_LIMIT.maxAttempts;
}

/**
 * Record a password change attempt
 * @param {number} userId - User ID
 * @param {boolean} success - Whether the attempt was successful
 * @param {string} ip - IP address (will be hashed)
 */
export function recordPasswordAttempt(userId, success, ip) {
  db.prepare(`
    INSERT INTO password_attempts (user_id, success, ip_hash)
    VALUES (?, ?, ?)
  `).run(userId, success ? 1 : 0, hashIp(ip));

  // Cleanup old attempts (keep 30 days for audit trail)
  db.prepare(`
    DELETE FROM password_attempts
    WHERE attempted_at < datetime('now', '-30 days')
  `).run();
}

/**
 * Get remaining attempts for a user
 * @param {number} userId - User ID
 * @returns {number} - Remaining attempts
 */
export function getRemainingPasswordAttempts(userId) {
  const since = new Date(Date.now() - PASSWORD_RATE_LIMIT.windowMinutes * 60 * 1000).toISOString();

  const result = db.prepare(`
    SELECT COUNT(*) as count FROM password_attempts
    WHERE user_id = ? AND attempted_at > ? AND success = 0
  `).get(userId, since);

  return Math.max(0, PASSWORD_RATE_LIMIT.maxAttempts - result.count);
}
