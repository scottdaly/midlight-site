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
  const { category, errorType, message } = errorData;
  const messagePattern = normalizeMessage(message);

  try {
    // Try to find existing issue
    const existingIssue = db.prepare(
      'SELECT * FROM error_issues WHERE fingerprint = ?'
    ).get(fingerprint);

    if (existingIssue) {
      // Update existing issue
      db.prepare(`
        UPDATE error_issues
        SET occurrence_count = occurrence_count + 1,
            last_seen_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(existingIssue.id);

      // If issue was resolved, check if we should reopen it
      if (existingIssue.status === 'resolved') {
        logger.info({
          issueId: existingIssue.id,
          fingerprint
        }, 'Resolved issue has new occurrence');
      }

      return {
        ...existingIssue,
        occurrence_count: existingIssue.occurrence_count + 1,
        isNew: false
      };
    }

    // Create new issue
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
      isNew: true
    };

    logger.info({
      issueId: newIssue.id,
      category,
      errorType
    }, 'New error issue created');

    return newIssue;

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
  const { category, errorType, message } = errorData;

  // Generate fingerprint
  const fingerprint = generateFingerprint(category, errorType, message);

  // Find or create issue
  const issue = findOrCreateIssue(fingerprint, errorData);

  // Link report to issue
  linkReportToIssue(reportId, issue.id);

  // Check alert rules asynchronously (don't block the request)
  setImmediate(() => {
    checkAlertRules(issue, issue.isNew).catch(err => {
      logger.error({ error: err?.message || err }, 'Error checking alert rules');
    });
  });

  return issue;
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
