import {
  cleanupExpiredSessions,
  cleanupExpiredOAuthStates,
  cleanupExpiredCodes,
  cleanupExpiredPasswordResetTokens,
  cleanupExpiredEmailVerificationTokens
} from './tokenService.js';
import { cleanupOldAuthEvents } from './auditService.js';
import db from '../db/index.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../config/index.js';

/**
 * Run all cleanup tasks:
 * - Expired sessions, OAuth states, codes, password reset tokens, email verification tokens
 * - Old auth events (>90 days)
 * - Old error reports and alert history (>90 days)
 */
export function runCleanup() {
  try {
    // Expired tokens/sessions
    const sessions = cleanupExpiredSessions();
    const oauthStates = cleanupExpiredOAuthStates();
    const codes = cleanupExpiredCodes();
    const resetTokens = cleanupExpiredPasswordResetTokens();
    const verificationTokens = cleanupExpiredEmailVerificationTokens();

    // Old audit/report data (90-day retention)
    const authEvents = cleanupOldAuthEvents();
    const reports = db.prepare(
      "DELETE FROM error_reports WHERE received_at < datetime('now', '-90 days')"
    ).run();
    const alerts = db.prepare(
      "DELETE FROM alert_history WHERE triggered_at < datetime('now', '-90 days')"
    ).run();

    // Stale Y.js document states (30-day retention — can be recreated from Tiptap JSON)
    const yjsDocs = db.prepare(
      "DELETE FROM yjs_documents WHERE updated_at < datetime('now', '-30 days')"
    ).run();

    // Expired document share links (clean up expired-at shares with no access entries)
    const expiredShares = db.prepare(
      "DELETE FROM document_shares WHERE expires_at IS NOT NULL AND expires_at < datetime('now', '-7 days')"
    ).run();

    const totalChanges = sessions.changes + oauthStates.changes + codes.changes +
      resetTokens.changes + verificationTokens.changes +
      authEvents.changes + reports.changes + alerts.changes +
      yjsDocs.changes + expiredShares.changes;

    if (totalChanges > 0) {
      logger.info({
        sessionsRemoved: sessions.changes,
        oauthStatesRemoved: oauthStates.changes,
        codesRemoved: codes.changes,
        resetTokensRemoved: resetTokens.changes,
        verificationTokensRemoved: verificationTokens.changes,
        authEventsRemoved: authEvents.changes,
        reportsRemoved: reports.changes,
        alertsRemoved: alerts.changes,
        yjsDocsRemoved: yjsDocs.changes,
        expiredSharesRemoved: expiredShares.changes,
      }, 'Cleanup completed');
    }
  } catch (error) {
    logger.error({ error: error.message }, 'Cleanup service error');
  }
}

let cleanupTimer = null;

/**
 * Start the periodic cleanup service.
 * Runs immediately on start, then on the configured interval.
 */
export function startCleanupService() {
  // Run once on startup
  runCleanup();

  // Schedule periodic runs
  const intervalMs = CONFIG.database.cleanup.expiredTokensIntervalMs;
  cleanupTimer = setInterval(runCleanup, intervalMs);
  logger.info({ intervalMs }, 'Cleanup service started');
}

export function stopCleanupService() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
