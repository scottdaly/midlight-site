import express from 'express';
import crypto from 'crypto';
import db from '../db/index.js';
import { logger } from '../utils/logger.js';
import { processErrorReport } from '../services/errorAggregator.js';

const router = express.Router();

// Helper to hash IP
const hashIp = (ip) => {
  return crypto.createHash('sha256').update(ip || 'unknown').digest('hex');
};

// POST /api/error-report
router.post('/error-report', (req, res) => {
  try {
    const {
      category,
      errorType,
      message,
      appVersion,
      platform,
      arch,
      osVersion,
      context,
      stackTrace,
      sessionId,
      timestamp, // Client provided timestamp, but we usually use server time for 'received_at'
      breadcrumbs
    } = req.body;

    // Basic Validation
    if (!category || !errorType || !sessionId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Valid categories from Tauri app (packages/core and apps/desktop)
    const validCategories = [
      'import',
      'export',
      'file_system',
      'editor',
      'llm',
      'auth',
      'recovery',
      'update',
      'crash',
      'uncaught',
      'sync',
      'unknown'
    ];

    if (!validCategories.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    // Allow any errorType - the client knows best what specific error occurred

    // Validate Context (must be an object if present)
    if (context && (typeof context !== 'object' || Array.isArray(context))) {
      return res.status(400).json({ error: 'Context must be a JSON object' });
    }

    // Validate context size (prevent oversized payloads)
    if (context) {
      const contextStr = JSON.stringify(context);
      if (contextStr.length > 50000) {
        return res.status(400).json({ error: 'Context too large (max 50KB)' });
      }
      // Enforce flat key-value structure (no nested objects)
      for (const value of Object.values(context)) {
        if (value !== null && typeof value === 'object') {
          return res.status(400).json({ error: 'Context values must be flat (no nested objects)' });
        }
      }
    }

    const ipHash = hashIp(req.ip);
    const contextStr = context ? JSON.stringify(context) : null;
    const stackTraceStr = typeof stackTrace === 'string' ? stackTrace.slice(0, 10000) : null;

    // Validate and cap breadcrumbs
    let breadcrumbsStr = null;
    if (breadcrumbs && Array.isArray(breadcrumbs)) {
      const capped = breadcrumbs.slice(0, 50);
      const serialized = JSON.stringify(capped);
      if (serialized.length <= 102400) { // 100KB cap
        breadcrumbsStr = serialized;
      }
    }

    const stmt = db.prepare(`
      INSERT INTO error_reports (
        category, error_type, message, app_version, platform, arch, os_version,
        context, stack_trace, session_id, ip_hash, breadcrumbs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      category,
      errorType,
      message || '',
      appVersion || '',
      platform || '',
      arch || '',
      osVersion || '',
      contextStr,
      stackTraceStr,
      sessionId,
      ipHash,
      breadcrumbsStr
    );

    // Aggregate error into issues and trigger alerts if needed
    try {
      const issue = processErrorReport(result.lastInsertRowid, {
        category,
        errorType,
        message: message || ''
      });

      // Log new issues for visibility
      if (issue.isNew) {
        logger.info({
          issueId: issue.id,
          category,
          errorType
        }, 'New error issue detected');
      }
    } catch (aggregateErr) {
      // Don't fail the request if aggregation fails
      logger.error({
        error: aggregateErr?.message || aggregateErr
      }, 'Error aggregating report');
    }

    res.status(200).json({ success: true });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error processing report');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/errors
// Protected by Basic Auth (middleware applied in main server file or here)
router.get('/admin/errors', (req, res) => {
  try {
    const { category } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const offset = parseInt(req.query.offset) || 0;

    let query = 'SELECT * FROM error_reports';
    const params = [];

    if (category) {
      query += ' WHERE category = ?';
      params.push(category);
    }

    query += ' ORDER BY received_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = db.prepare(query);
    const reports = stmt.all(...params);

    // Parse context JSON for frontend convenience
    const parsedReports = reports.map(r => ({
      ...r,
      context: r.context ? JSON.parse(r.context) : {}
    }));

    // Get stats
    const statsStmt = db.prepare(`
      SELECT category, COUNT(*) as count 
      FROM error_reports 
      WHERE received_at > datetime('now', '-24 hours')
      GROUP BY category
    `);
    const stats = statsStmt.all();

    res.json({ reports: parsedReports, stats });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching reports');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/error-report/batch
// Accepts up to 50 reports in a single request
router.post('/error-report/batch', (req, res) => {
  try {
    const { reports } = req.body;

    if (!Array.isArray(reports) || reports.length === 0) {
      return res.status(400).json({ error: 'reports must be a non-empty array' });
    }

    if (reports.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 reports per batch' });
    }

    const ipHash = hashIp(req.ip);
    let processed = 0;
    let failed = 0;

    const validCategories = [
      'import', 'export', 'file_system', 'editor', 'llm', 'auth',
      'recovery', 'update', 'crash', 'uncaught', 'sync', 'unknown'
    ];

    const insertStmt = db.prepare(`
      INSERT INTO error_reports (
        category, error_type, message, app_version, platform, arch, os_version,
        context, stack_trace, session_id, ip_hash, breadcrumbs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const report of reports) {
      try {
        const {
          category, errorType, message, appVersion, platform,
          arch, osVersion, context, stackTrace, sessionId, breadcrumbs
        } = report;

        // Basic validation
        if (!category || !errorType || !sessionId) {
          failed++;
          continue;
        }

        if (!validCategories.includes(category)) {
          failed++;
          continue;
        }

        // Validate context
        if (context && (typeof context !== 'object' || Array.isArray(context))) {
          failed++;
          continue;
        }

        if (context) {
          const contextStr = JSON.stringify(context);
          if (contextStr.length > 50000) {
            failed++;
            continue;
          }
          for (const value of Object.values(context)) {
            if (value !== null && typeof value === 'object') {
              failed++;
              continue;
            }
          }
        }

        const contextStr = context ? JSON.stringify(context) : null;
        const stackTraceStr = typeof stackTrace === 'string' ? stackTrace.slice(0, 10000) : null;

        // Validate and cap breadcrumbs
        let breadcrumbsStr = null;
        if (breadcrumbs && Array.isArray(breadcrumbs)) {
          const capped = breadcrumbs.slice(0, 50);
          const serialized = JSON.stringify(capped);
          if (serialized.length <= 102400) { // 100KB cap
            breadcrumbsStr = serialized;
          }
        }

        const result = insertStmt.run(
          category,
          errorType,
          message || '',
          appVersion || '',
          platform || '',
          arch || '',
          osVersion || '',
          contextStr,
          stackTraceStr,
          sessionId,
          ipHash,
          breadcrumbsStr
        );

        // Aggregate
        try {
          const issue = processErrorReport(result.lastInsertRowid, {
            category,
            errorType,
            message: message || ''
          });
          if (issue.isNew) {
            logger.info({ issueId: issue.id, category, errorType }, 'New error issue detected (batch)');
          }
        } catch (aggregateErr) {
          logger.error({ error: aggregateErr?.message || aggregateErr }, 'Error aggregating batch report');
        }

        processed++;
      } catch (reportErr) {
        logger.error({ error: reportErr?.message || reportErr }, 'Error processing batch report item');
        failed++;
      }
    }

    res.status(200).json({ processed, failed });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error processing batch report');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
