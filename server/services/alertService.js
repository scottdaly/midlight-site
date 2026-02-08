/**
 * Alert Service
 *
 * Handles email notifications for error monitoring alerts.
 * Supports different alert types: new_issue, threshold, and spike detection.
 *
 * Configuration (environment variables):
 * - SMTP_HOST: SMTP server hostname
 * - SMTP_PORT: SMTP server port (default: 587)
 * - SMTP_USER: SMTP username
 * - SMTP_PASS: SMTP password
 * - SMTP_FROM: From address for emails (default: noreply@midlight.ai)
 * - ALERT_ENABLED: Set to 'true' to enable alerts (default: false)
 */

import nodemailer from 'nodemailer';
import db from '../db/index.js';
import { logger } from '../utils/logger.js';

// SMTP transporter (created lazily)
let transporter = null;

/**
 * Get or create the SMTP transporter
 */
function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    logger.warn('SMTP not configured - email alerts disabled');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587'),
    secure: parseInt(SMTP_PORT || '587') === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });

  return transporter;
}

/**
 * Check if alerting is enabled
 */
function isAlertingEnabled() {
  return process.env.ALERT_ENABLED === 'true';
}

/**
 * Send an email alert
 *
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} html - Email body HTML
 * @returns {Promise<boolean>} - Whether the email was sent
 */
async function sendEmail(to, subject, html) {
  const transport = getTransporter();
  if (!transport) return false;

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || 'Midlight Alerts <noreply@midlight.ai>',
      to,
      subject,
      html
    });
    return true;
  } catch (err) {
    logger.error({ error: err?.message || err, to, subject }, 'Failed to send email');
    return false;
  }
}

/**
 * Check and trigger alerts for a new or updated issue
 *
 * @param {object} issue - The error issue
 * @param {boolean} isNew - Whether this is a newly created issue
 */
export async function checkAlertRules(issue, isNew = false) {
  if (!isAlertingEnabled()) return;

  try {
    // Get all enabled alert rules
    const rules = db.prepare(`
      SELECT * FROM alert_rules WHERE enabled = 1
    `).all();

    for (const rule of rules) {
      // Check category filter
      if (rule.category_filter && rule.category_filter !== issue.category) {
        continue;
      }

      let shouldAlert = false;

      switch (rule.rule_type) {
        case 'new_issue':
          shouldAlert = isNew;
          break;

        case 'threshold':
          shouldAlert = await checkThreshold(rule, issue);
          break;

        case 'spike':
          shouldAlert = await checkSpike(rule, issue);
          break;
      }

      if (shouldAlert) {
        await triggerAlert(rule, issue);
      }
    }
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error checking alert rules');
  }
}

/**
 * Check if threshold alert should fire
 */
async function checkThreshold(rule, issue) {
  const { threshold_count, threshold_window_minutes } = rule;

  if (!threshold_count || !threshold_window_minutes) return false;

  // Count errors in the time window
  const count = db.prepare(`
    SELECT COUNT(*) as count FROM error_reports
    WHERE received_at > datetime('now', '-' || ? || ' minutes')
    ${rule.category_filter ? "AND category = ?" : ""}
  `).get(
    threshold_window_minutes,
    ...(rule.category_filter ? [rule.category_filter] : [])
  );

  // Check if we already alerted recently for this rule
  const recentAlert = db.prepare(`
    SELECT id FROM alert_history
    WHERE rule_id = ?
      AND triggered_at > datetime('now', '-' || ? || ' minutes')
  `).get(rule.id, threshold_window_minutes);

  if (recentAlert) return false;

  return count.count >= threshold_count;
}

/**
 * Check if spike alert should fire (3x normal rate)
 */
async function checkSpike(rule, issue) {
  // Compare last hour to average of previous 24 hours

  const lastHour = db.prepare(`
    SELECT COUNT(*) as count FROM error_reports
    WHERE received_at > datetime('now', '-1 hour')
    ${rule.category_filter ? "AND category = ?" : ""}
  `).get(...(rule.category_filter ? [rule.category_filter] : []));

  const previous24h = db.prepare(`
    SELECT COUNT(*) as count FROM error_reports
    WHERE received_at > datetime('now', '-25 hours')
      AND received_at <= datetime('now', '-1 hour')
    ${rule.category_filter ? "AND category = ?" : ""}
  `).get(...(rule.category_filter ? [rule.category_filter] : []));

  const avgPerHour = previous24h.count / 24;
  const spikeThreshold = avgPerHour * 3;

  // Require at least 3 errors to avoid false positives on low-volume
  if (lastHour.count < 3) return false;

  // Check if we already alerted for this spike
  const recentAlert = db.prepare(`
    SELECT id FROM alert_history
    WHERE rule_id = ?
      AND triggered_at > datetime('now', '-1 hour')
  `).get(rule.id);

  if (recentAlert) return false;

  return lastHour.count >= spikeThreshold;
}

/**
 * Trigger an alert - record it and send notification
 */
async function triggerAlert(rule, issue) {
  try {
    // Wrap check-and-insert in transaction to prevent duplicate alerts
    const txn = db.transaction(() => {
      // Check if we already have a recent alert for this rule+issue combo
      const recentAlert = db.prepare(`
        SELECT id FROM alert_history
        WHERE rule_id = ? AND issue_id = ?
          AND triggered_at > datetime('now', '-1 minute')
      `).get(rule.id, issue.id || null);

      if (recentAlert) return null; // Already alerted recently

      const result = db.prepare(`
        INSERT INTO alert_history (rule_id, issue_id, notification_sent)
        VALUES (?, ?, 0)
      `).run(rule.id, issue.id || null);

      return result.lastInsertRowid;
    });

    const alertId = txn();
    if (alertId === null) return; // Duplicate alert prevented

    // Build email content
    const subject = buildSubject(rule, issue);
    const html = buildEmailHtml(rule, issue);

    // Send email
    const sent = await sendEmail(rule.email, subject, html);

    // Update alert history with result
    db.prepare(`
      UPDATE alert_history
      SET notification_sent = ?,
          error_message = ?
      WHERE id = ?
    `).run(sent ? 1 : 0, sent ? null : 'Email sending failed', alertId);

    logger.info({
      ruleId: rule.id,
      ruleName: rule.name,
      issueId: issue.id,
      sent
    }, 'Alert triggered');

  } catch (err) {
    logger.error({
      error: err?.message || err,
      ruleId: rule.id
    }, 'Error triggering alert');
  }
}

/**
 * Build email subject
 */
function buildSubject(rule, issue) {
  switch (rule.rule_type) {
    case 'new_issue':
      return `[Midlight] New Error: ${issue.error_type}`;
    case 'threshold':
      return `[Midlight] Error Threshold Exceeded`;
    case 'spike':
      return `[Midlight] Error Rate Spike Detected`;
    default:
      return `[Midlight] Error Alert`;
  }
}

/**
 * Build email HTML content
 */
function buildEmailHtml(rule, issue) {
  const dashboardUrl = process.env.SITE_URL
    ? `${process.env.SITE_URL}/admin/errors`
    : 'https://midlight.ai/admin/errors';

  const categoryBadge = `
    <span style="background: #374151; color: #9ca3af; padding: 2px 8px; border-radius: 4px; font-size: 12px;">
      ${issue.category || 'unknown'}
    </span>
  `;

  let alertTypeMessage = '';
  switch (rule.rule_type) {
    case 'new_issue':
      alertTypeMessage = '<p style="color: #3b82f6; font-weight: 600;">A new error type has been detected.</p>';
      break;
    case 'threshold':
      alertTypeMessage = `<p style="color: #f59e0b; font-weight: 600;">Error threshold exceeded: ${rule.threshold_count} errors in ${rule.threshold_window_minutes} minutes.</p>`;
      break;
    case 'spike':
      alertTypeMessage = '<p style="color: #ef4444; font-weight: 600;">Error rate spike detected: 3x above normal.</p>';
      break;
  }

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1f1f1f; color: #e5e5e5; margin: 0; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; background: #2d2d2d; border-radius: 12px; overflow: hidden;">
        <div style="background: #374151; padding: 20px;">
          <h1 style="margin: 0; font-size: 20px; color: white;">Midlight Error Alert</h1>
        </div>

        <div style="padding: 20px;">
          ${alertTypeMessage}

          <div style="background: #374151; padding: 15px; border-radius: 8px; margin: 15px 0;">
            <p style="margin: 0 0 10px 0; color: #9ca3af; font-size: 12px;">ERROR TYPE</p>
            <p style="margin: 0; font-weight: 600;">${issue.error_type || 'Unknown'}</p>

            <p style="margin: 15px 0 10px 0; color: #9ca3af; font-size: 12px;">CATEGORY</p>
            <p style="margin: 0;">${categoryBadge}</p>

            ${issue.message_pattern ? `
              <p style="margin: 15px 0 10px 0; color: #9ca3af; font-size: 12px;">PATTERN</p>
              <p style="margin: 0; font-family: monospace; font-size: 13px; background: #1f1f1f; padding: 10px; border-radius: 4px; overflow-x: auto;">
                ${escapeHtml(issue.message_pattern)}
              </p>
            ` : ''}

            ${issue.occurrence_count ? `
              <p style="margin: 15px 0 10px 0; color: #9ca3af; font-size: 12px;">OCCURRENCES</p>
              <p style="margin: 0; font-weight: 600; font-size: 24px; color: #3b82f6;">${issue.occurrence_count}</p>
            ` : ''}
          </div>

          <a href="${dashboardUrl}" style="display: inline-block; background: #3b82f6; color: white; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; margin-top: 10px;">
            View in Dashboard
          </a>
        </div>

        <div style="padding: 15px 20px; background: #1f1f1f; border-top: 1px solid #374151;">
          <p style="margin: 0; color: #6b7280; font-size: 12px;">
            Alert rule: ${escapeHtml(rule.name)} | Type: ${rule.rule_type}
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Escape HTML characters
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Test email configuration by sending a test email
 */
export async function testEmailConfig(email) {
  const html = `
    <div style="font-family: sans-serif; padding: 20px;">
      <h1>Midlight Alert Test</h1>
      <p>If you received this email, your alert configuration is working correctly.</p>
      <p style="color: #6b7280; font-size: 12px;">Sent at: ${new Date().toISOString()}</p>
    </div>
  `;

  return await sendEmail(email, '[Midlight] Test Alert', html);
}

export default {
  checkAlertRules,
  testEmailConfig
};
