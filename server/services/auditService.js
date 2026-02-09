/**
 * Auth Audit Service
 *
 * Logs authentication events for security monitoring.
 */

import db from '../db/index.js';

/**
 * Log an authentication event
 * @param {object} params
 * @param {number|null} params.userId - User ID (null for failed logins with unknown user)
 * @param {string} params.eventType - Event type (signup, login, login_failed, logout, password_reset, oauth_login, email_verified)
 * @param {string} [params.ipHash] - Hashed IP address
 * @param {string} [params.userAgent] - User agent string
 * @param {object} [params.metadata] - Additional metadata (e.g., provider, email)
 */
export function logAuthEvent({ userId, eventType, ipHash, userAgent, metadata }) {
  try {
    const stmt = db.prepare(`
      INSERT INTO auth_events (user_id, event_type, ip_hash, user_agent, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      userId || null,
      eventType,
      ipHash || null,
      userAgent || null,
      metadata ? JSON.stringify(metadata) : null
    );
  } catch {
    // Don't let audit logging failures break auth flows
  }
}

/**
 * Clean up old auth events (keep 90 days)
 */
export function cleanupOldAuthEvents() {
  const stmt = db.prepare("DELETE FROM auth_events WHERE created_at < datetime('now', '-90 days')");
  return stmt.run();
}
