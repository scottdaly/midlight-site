/**
 * Admin Routes for Error Monitoring Dashboard
 *
 * Provides API endpoints for viewing and managing error issues,
 * viewing statistics, and configuring alert rules.
 */

import express from 'express';
import db from '../../db/index.js';
import { logger } from '../../utils/logger.js';
import { getIssueStats } from '../../services/errorAggregator.js';

const router = express.Router();

// ============================================================================
// Dashboard Statistics
// ============================================================================

/**
 * GET /api/admin/stats
 * Returns dashboard statistics including error counts and trends
 */
router.get('/stats', (req, res) => {
  try {
    const stats = getIssueStats();

    // Get errors by category for last 7 days
    const byCategory = db.prepare(`
      SELECT category, COUNT(*) as count
      FROM error_reports
      WHERE received_at > datetime('now', '-7 days')
      GROUP BY category
      ORDER BY count DESC
    `).all();

    // Get errors by version for last 7 days
    const byVersion = db.prepare(`
      SELECT app_version, COUNT(*) as count
      FROM error_reports
      WHERE received_at > datetime('now', '-7 days')
        AND app_version IS NOT NULL AND app_version != ''
      GROUP BY app_version
      ORDER BY count DESC
      LIMIT 10
    `).all();

    // Get daily trend for last 14 days
    const dailyTrend = db.prepare(`
      SELECT date(received_at) as date, COUNT(*) as count
      FROM error_reports
      WHERE received_at > datetime('now', '-14 days')
      GROUP BY date(received_at)
      ORDER BY date ASC
    `).all();

    res.json({
      ...stats,
      byCategory,
      byVersion,
      dailyTrend
    });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching admin stats');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// Error Issues Management
// ============================================================================

/**
 * GET /api/admin/issues
 * List all error issues with pagination and filtering
 */
router.get('/issues', (req, res) => {
  try {
    const { status, category, sort = 'last_seen_at', order = 'DESC' } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    // Build WHERE clause
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }

    if (category) {
      conditions.push('category = ?');
      params.push(category);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // Validate sort column
    const validSortCols = ['last_seen_at', 'first_seen_at', 'occurrence_count', 'category'];
    const sortCol = validSortCols.includes(sort) ? sort : 'last_seen_at';
    const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM error_issues ${whereClause}`;
    const { total } = db.prepare(countQuery).get(...params);

    // Get issues
    const query = `
      SELECT id, fingerprint, category, error_type, message_pattern,
             first_seen_at, last_seen_at, occurrence_count, status,
             resolved_at, resolved_in_version, notes
      FROM error_issues
      ${whereClause}
      ORDER BY ${sortCol} ${sortOrder}
      LIMIT ? OFFSET ?
    `;

    const issues = db.prepare(query).all(...params, limit, offset);

    res.json({
      issues,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + issues.length < total
      }
    });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching issues');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/issues/:id
 * Get a single error issue with full details
 */
router.get('/issues/:id', (req, res) => {
  try {
    const { id } = req.params;

    const issue = db.prepare(`
      SELECT * FROM error_issues WHERE id = ?
    `).get(id);

    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    // Get version distribution for this issue
    const versionDistribution = db.prepare(`
      SELECT app_version, COUNT(*) as count
      FROM error_reports
      WHERE issue_id = ?
      GROUP BY app_version
      ORDER BY count DESC
    `).all(id);

    // Get platform distribution
    const platformDistribution = db.prepare(`
      SELECT platform, COUNT(*) as count
      FROM error_reports
      WHERE issue_id = ?
      GROUP BY platform
      ORDER BY count DESC
    `).all(id);

    // Get recent trend (last 7 days)
    const recentTrend = db.prepare(`
      SELECT date(received_at) as date, COUNT(*) as count
      FROM error_reports
      WHERE issue_id = ? AND received_at > datetime('now', '-7 days')
      GROUP BY date(received_at)
      ORDER BY date ASC
    `).all(id);

    res.json({
      issue,
      versionDistribution,
      platformDistribution,
      recentTrend
    });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching issue');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/admin/issues/:id
 * Update an issue's status or notes
 */
router.patch('/issues/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, resolved_in_version } = req.body;

    // Validate status
    if (status && !['open', 'resolved', 'ignored'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Check issue exists
    const existing = db.prepare('SELECT id FROM error_issues WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    // Build update
    const updates = [];
    const params = [];

    if (status !== undefined) {
      updates.push('status = ?');
      params.push(status);

      if (status === 'resolved') {
        updates.push('resolved_at = CURRENT_TIMESTAMP');
        if (resolved_in_version) {
          updates.push('resolved_in_version = ?');
          params.push(resolved_in_version);
        }
      }
    }

    if (notes !== undefined) {
      updates.push('notes = ?');
      params.push(notes);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    params.push(id);
    const query = `UPDATE error_issues SET ${updates.join(', ')} WHERE id = ?`;
    db.prepare(query).run(...params);

    // Return updated issue
    const updated = db.prepare('SELECT * FROM error_issues WHERE id = ?').get(id);

    logger.info({ issueId: id, status, notes }, 'Issue updated');

    res.json({ issue: updated });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error updating issue');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/issues/bulk
 * Bulk update multiple issues
 */
router.post('/issues/bulk', (req, res) => {
  try {
    const { ids, status, notes } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }

    if (status && !['open', 'resolved', 'ignored'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const updates = [];
    const params = [];

    if (status) {
      updates.push('status = ?');
      params.push(status);

      if (status === 'resolved') {
        updates.push('resolved_at = CURRENT_TIMESTAMP');
      }
    }

    if (notes !== undefined) {
      updates.push('notes = ?');
      params.push(notes);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    const placeholders = ids.map(() => '?').join(',');
    const query = `UPDATE error_issues SET ${updates.join(', ')} WHERE id IN (${placeholders})`;

    const result = db.prepare(query).run(...params, ...ids);

    logger.info({ issueIds: ids, status }, 'Bulk issues updated');

    res.json({ updated: result.changes });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error bulk updating issues');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/issues/:id/reports
 * Get individual error reports for a specific issue
 */
router.get('/issues/:id/reports', (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    // Get total count
    const { total } = db.prepare(
      'SELECT COUNT(*) as total FROM error_reports WHERE issue_id = ?'
    ).get(id);

    // Get reports
    const reports = db.prepare(`
      SELECT id, category, error_type, message, app_version, platform,
             arch, os_version, context, session_id, received_at
      FROM error_reports
      WHERE issue_id = ?
      ORDER BY received_at DESC
      LIMIT ? OFFSET ?
    `).all(id, limit, offset);

    // Parse context JSON
    const parsedReports = reports.map(r => ({
      ...r,
      context: r.context ? JSON.parse(r.context) : {}
    }));

    res.json({
      reports: parsedReports,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + reports.length < total
      }
    });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching issue reports');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// Alert Rules Management
// ============================================================================

/**
 * GET /api/admin/alerts
 * List all alert rules
 */
router.get('/alerts', (req, res) => {
  try {
    const rules = db.prepare(`
      SELECT * FROM alert_rules ORDER BY created_at DESC
    `).all();

    res.json({ rules });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching alert rules');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/alerts
 * Create a new alert rule
 */
router.post('/alerts', (req, res) => {
  try {
    const {
      name,
      rule_type,
      category_filter,
      threshold_count,
      threshold_window_minutes,
      email
    } = req.body;

    if (!name || !rule_type || !email) {
      return res.status(400).json({ error: 'name, rule_type, and email are required' });
    }

    if (!['new_issue', 'threshold', 'spike'].includes(rule_type)) {
      return res.status(400).json({ error: 'Invalid rule_type' });
    }

    if (rule_type === 'threshold' && (!threshold_count || !threshold_window_minutes)) {
      return res.status(400).json({ error: 'threshold rules require threshold_count and threshold_window_minutes' });
    }

    const result = db.prepare(`
      INSERT INTO alert_rules (name, rule_type, category_filter, threshold_count, threshold_window_minutes, email)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, rule_type, category_filter || null, threshold_count || null, threshold_window_minutes || null, email);

    const rule = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(result.lastInsertRowid);

    logger.info({ ruleId: rule.id, name, rule_type }, 'Alert rule created');

    res.status(201).json({ rule });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error creating alert rule');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/admin/alerts/:id
 * Update an alert rule
 */
router.patch('/alerts/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, enabled, email, threshold_count, threshold_window_minutes, category_filter } = req.body;

    const existing = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Alert rule not found' });
    }

    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name);
    }
    if (enabled !== undefined) {
      updates.push('enabled = ?');
      params.push(enabled ? 1 : 0);
    }
    if (email !== undefined) {
      updates.push('email = ?');
      params.push(email);
    }
    if (threshold_count !== undefined) {
      updates.push('threshold_count = ?');
      params.push(threshold_count);
    }
    if (threshold_window_minutes !== undefined) {
      updates.push('threshold_window_minutes = ?');
      params.push(threshold_window_minutes);
    }
    if (category_filter !== undefined) {
      updates.push('category_filter = ?');
      params.push(category_filter || null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    params.push(id);
    db.prepare(`UPDATE alert_rules SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id);

    logger.info({ ruleId: id }, 'Alert rule updated');

    res.json({ rule: updated });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error updating alert rule');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/admin/alerts/:id
 * Delete an alert rule
 */
router.delete('/alerts/:id', (req, res) => {
  try {
    const { id } = req.params;

    const existing = db.prepare('SELECT id FROM alert_rules WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ error: 'Alert rule not found' });
    }

    db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);

    logger.info({ ruleId: id }, 'Alert rule deleted');

    res.json({ success: true });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error deleting alert rule');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/alerts/history
 * Get alert history
 */
router.get('/alerts/history', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const history = db.prepare(`
      SELECT ah.*, ar.name as rule_name, ar.rule_type,
             ei.category, ei.error_type, ei.message_pattern
      FROM alert_history ah
      LEFT JOIN alert_rules ar ON ah.rule_id = ar.id
      LEFT JOIN error_issues ei ON ah.issue_id = ei.id
      ORDER BY ah.triggered_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    res.json({ history });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching alert history');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
