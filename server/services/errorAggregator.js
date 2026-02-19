/**
 * Error Aggregator Service
 *
 * Groups similar errors together by fingerprinting error patterns.
 * This allows for easier management and deduplication of errors.
 */

import crypto from 'crypto';
import db from '../db/index.js';
import { logger } from '../utils/logger.js';
import { checkAlertRules } from './alertService.js';
import { parseStack, extractSignificantFrames, generateStackFingerprint } from './stackParser.js';

/**
 * Normalize an error message by stripping variable parts.
 * This helps group similar errors even when they have different IDs, paths, or timestamps.
 *
 * @param {string} message - The original error message
 * @returns {string} - Normalized message pattern
 */
export function normalizeMessage(message) {
  if (!message) return '';

  let normalized = message;

  // Replace UUIDs (various formats)
  normalized = normalized.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '<UUID>'
  );

  // Replace hex strings (32+ chars, likely hashes or IDs)
  normalized = normalized.replace(/\b[0-9a-f]{32,}\b/gi, '<HASH>');

  // Replace file paths (Unix and Windows)
  // Unix paths: /Users/... or /home/...
  normalized = normalized.replace(/\/(?:Users|home|var|tmp|opt)\/[^\s:]+/g, '<PATH>');
  // Windows paths: C:\... or D:\...
  normalized = normalized.replace(/[A-Z]:\\[^\s:]+/gi, '<PATH>');

  // Replace timestamps (ISO 8601)
  normalized = normalized.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    '<TIMESTAMP>'
  );

  // Replace numeric timestamps (Unix epoch in ms)
  normalized = normalized.replace(/\b1[0-9]{12}\b/g, '<TIMESTAMP>');

  // Replace port numbers in URLs
  normalized = normalized.replace(/:\d{4,5}(?=[\/\s]|$)/g, ':<PORT>');

  // Replace IP addresses
  normalized = normalized.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<IP>');

  // Replace large numbers (likely IDs)
  normalized = normalized.replace(/\b\d{6,}\b/g, '<ID>');

  // Replace line numbers in stack traces
  normalized = normalized.replace(/:\d+:\d+/g, ':<LINE>');

  // Normalize whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}

/**
 * Generate a fingerprint for an error based on its key characteristics.
 * Errors with the same fingerprint are considered the same issue.
 *
 * @param {string} category - Error category (e.g., 'crash', 'import')
 * @param {string} errorType - Error type (e.g., 'uncaught_exception')
 * @param {string} message - Error message (will be normalized)
 * @returns {string} - SHA-256 fingerprint
 */
export function generateFingerprint(category, errorType, message) {
  const normalizedMessage = normalizeMessage(message);
  const input = `${category}:${errorType}:${normalizedMessage}`;

  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Find an existing issue by fingerprint, or create a new one.
 * Updates occurrence count and last_seen_at for existing issues.
 *
 * @param {string} fingerprint - The error fingerprint
 * @param {object} errorData - Error data to use when creating a new issue
 * @returns {object} - The issue record (existing or newly created)
 */
export function findOrCreateIssue(fingerprint, errorData) {
  const { category, errorType, message, appVersion } = errorData;
  const messagePattern = normalizeMessage(message);

  // Wrap in transaction to prevent race conditions with concurrent requests
  const txn = db.transaction(() => {
    const existingIssue = db.prepare(
      'SELECT * FROM error_issues WHERE fingerprint = ?'
    ).get(fingerprint);

    if (existingIssue) {
      // Check for regression: issue was resolved but appears in a different version
      let regressed = false;
      if (existingIssue.status === 'resolved' && appVersion && appVersion !== existingIssue.resolved_in_version) {
        db.prepare(`
          UPDATE error_issues
          SET status = 'open',
              occurrence_count = occurrence_count + 1,
              last_seen_at = CURRENT_TIMESTAMP,
              regression_count = COALESCE(regression_count, 0) + 1,
              last_regression_version = ?,
              resolved_at = NULL
          WHERE id = ?
        `).run(appVersion, existingIssue.id);

        regressed = true;
        logger.warn({
          issueId: existingIssue.id,
          fingerprint,
          version: appVersion,
          resolvedIn: existingIssue.resolved_in_version
        }, 'Resolved issue REGRESSED in new version');
      } else {
        db.prepare(`
          UPDATE error_issues
          SET occurrence_count = occurrence_count + 1,
              last_seen_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(existingIssue.id);

        if (existingIssue.status === 'resolved') {
          logger.info({
            issueId: existingIssue.id,
            fingerprint
          }, 'Resolved issue has new occurrence');
        }
      }

      return {
        ...existingIssue,
        occurrence_count: existingIssue.occurrence_count + 1,
        isNew: false,
        regressed
      };
    }

    const result = db.prepare(`
      INSERT INTO error_issues (
        fingerprint, category, error_type, message_pattern
      ) VALUES (?, ?, ?, ?)
    `).run(fingerprint, category, errorType, messagePattern);

    const newIssue = {
      id: result.lastInsertRowid,
      fingerprint,
      category,
      error_type: errorType,
      message_pattern: messagePattern,
      occurrence_count: 1,
      status: 'open',
      isNew: true,
      regressed: false
    };

    logger.info({
      issueId: newIssue.id,
      category,
      errorType
    }, 'New error issue created');

    return newIssue;
  });

  try {
    return txn();
  } catch (err) {
    logger.error({
      error: err?.message || err,
      fingerprint
    }, 'Error in findOrCreateIssue');
    throw err;
  }
}

/**
 * Link an error report to its corresponding issue.
 * This is done by adding the issue_id to the error_report record.
 *
 * @param {number} reportId - The error_reports.id
 * @param {number} issueId - The error_issues.id
 */
export function linkReportToIssue(reportId, issueId) {
  try {
    db.prepare(
      'UPDATE error_reports SET issue_id = ? WHERE id = ?'
    ).run(issueId, reportId);
  } catch (err) {
    logger.error({
      error: err?.message || err,
      reportId,
      issueId
    }, 'Error linking report to issue');
    throw err;
  }
}

/**
 * Process an incoming error report and aggregate it with existing issues.
 * This is the main entry point called from the reports endpoint.
 *
 * @param {number} reportId - The ID of the newly inserted error report
 * @param {object} errorData - The error data from the report
 * @returns {object} - The issue the report was linked to
 */
export function processErrorReport(reportId, errorData) {
  const {
    category,
    errorType,
    message,
    symbolicatedStack,
    stackTrace,
    appVersion,
    userHash,
    sessionId
  } = errorData;

  // Generate fingerprint — prefer stack-based when symbolicated stack is available
  let fingerprint;
  let fingerprintVersion = 1;

  const stackForFingerprinting = symbolicatedStack || stackTrace;
  if (stackForFingerprinting) {
    const frames = parseStack(stackForFingerprinting);
    const significant = extractSignificantFrames(frames, 3);

    if (significant.length > 0) {
      fingerprint = generateStackFingerprint(category, errorType, significant);
      fingerprintVersion = 2;
    }
  }

  // Fall back to message-based fingerprint
  if (!fingerprint) {
    fingerprint = generateFingerprint(category, errorType, message);
  }

  // Find or create issue
  const issue = findOrCreateIssue(fingerprint, { ...errorData, appVersion });

  // Update fingerprint version if this is a new stack-based issue
  if (issue.isNew && fingerprintVersion === 2) {
    try {
      db.prepare('UPDATE error_issues SET fingerprint_version = ? WHERE id = ?').run(fingerprintVersion, issue.id);
    } catch { /* ignore */ }
  }

  // Link report to issue
  linkReportToIssue(reportId, issue.id);

  // Update affected users/sessions counts
  if (userHash || sessionId) {
    try {
      updateAffectedCounts(issue.id, userHash, sessionId);
    } catch (err) {
      logger.debug({ error: err?.message }, 'Error updating affected counts');
    }
  }

  // Check alert rules asynchronously (don't block the request)
  setImmediate(() => {
    // Also check for regression alerts
    const alertType = issue.regressed ? 'regression' : (issue.isNew ? 'new' : 'existing');
    checkAlertRules(issue, issue.isNew || issue.regressed).catch(err => {
      logger.error({ error: err?.message || err }, 'Error checking alert rules');
    });
  });

  return issue;
}

/**
 * Update the affected_users and affected_sessions counts for an issue
 */
function updateAffectedCounts(issueId, userHash, sessionId) {
  if (userHash) {
    const userCount = db.prepare(`
      SELECT COUNT(DISTINCT user_hash) as count
      FROM error_reports
      WHERE issue_id = ? AND user_hash IS NOT NULL
    `).get(issueId);

    if (userCount) {
      db.prepare('UPDATE error_issues SET affected_users = ? WHERE id = ?')
        .run(userCount.count, issueId);
    }
  }

  if (sessionId) {
    const sessionCount = db.prepare(`
      SELECT COUNT(DISTINCT session_id) as count
      FROM error_reports
      WHERE issue_id = ? AND session_id IS NOT NULL
    `).get(issueId);

    if (sessionCount) {
      db.prepare('UPDATE error_issues SET affected_sessions = ? WHERE id = ?')
        .run(sessionCount.count, issueId);
    }
  }
}

/**
 * Get issue statistics for the dashboard
 *
 * @returns {object} - Statistics about error issues
 */
export function getIssueStats() {
  try {
    const stats = {
      totalIssues: db.prepare('SELECT COUNT(*) as count FROM error_issues').get().count,
      openIssues: db.prepare("SELECT COUNT(*) as count FROM error_issues WHERE status = 'open'").get().count,
      resolvedIssues: db.prepare("SELECT COUNT(*) as count FROM error_issues WHERE status = 'resolved'").get().count,
      ignoredIssues: db.prepare("SELECT COUNT(*) as count FROM error_issues WHERE status = 'ignored'").get().count,

      // Last 24 hours
      last24h: db.prepare(`
        SELECT COUNT(*) as count FROM error_reports
        WHERE received_at > datetime('now', '-24 hours')
      `).get().count,

      // Last 7 days
      last7d: db.prepare(`
        SELECT COUNT(*) as count FROM error_reports
        WHERE received_at > datetime('now', '-7 days')
      `).get().count,

      // Top issues by occurrence
      topIssues: db.prepare(`
        SELECT id, category, error_type, message_pattern, occurrence_count,
               first_seen_at, last_seen_at, status
        FROM error_issues
        WHERE status = 'open'
        ORDER BY occurrence_count DESC
        LIMIT 10
      `).all()
    };

    return stats;

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error getting issue stats');
    throw err;
  }
}

export default {
  normalizeMessage,
  generateFingerprint,
  findOrCreateIssue,
  linkReportToIssue,
  processErrorReport,
  getIssueStats
};
