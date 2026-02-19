import express from 'express';
import crypto from 'crypto';
import db from '../db/index.js';
import { logger } from '../utils/logger.js';
import { processErrorReport } from '../services/errorAggregator.js';
import { symbolicate } from '../services/sourcemapService.js';

const router = express.Router();

const VALID_CATEGORIES = [
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

// Helper to hash IP
const hashIp = (ip) => {
  return crypto.createHash('sha256').update(ip || 'unknown').digest('hex');
};

function validateContext(context) {
  if (!context) {
    return { ok: true, contextStr: null };
  }

  if (typeof context !== 'object' || Array.isArray(context)) {
    return { ok: false, error: 'Context must be a JSON object' };
  }

  const contextStr = JSON.stringify(context);
  if (contextStr.length > 50000) {
    return { ok: false, error: 'Context too large (max 50KB)' };
  }

  for (const value of Object.values(context)) {
    if (value !== null && typeof value === 'object') {
      return { ok: false, error: 'Context values must be flat (no nested objects)' };
    }
  }

  return { ok: true, contextStr };
}

function normalizeBreadcrumbs(breadcrumbs) {
  if (!breadcrumbs || !Array.isArray(breadcrumbs)) {
    return null;
  }
  const capped = breadcrumbs.slice(0, 50);
  const serialized = JSON.stringify(capped);
  if (serialized.length > 102400) {
    return null;
  }
  return serialized;
}

function normalizeUserHash(userHash) {
  return typeof userHash === 'string' && /^[0-9a-f]{64}$/i.test(userHash) ? userHash : null;
}

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
      breadcrumbs,
      userHash,
      snapshots
    } = req.body;

    // Basic Validation
    if (!category || !errorType || !sessionId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const contextValidation = validateContext(context);
    if (!contextValidation.ok) {
      return res.status(400).json({ error: contextValidation.error });
    }

    const ipHash = hashIp(req.ip);
    const contextStr = contextValidation.contextStr;
    const stackTraceStr = typeof stackTrace === 'string' ? stackTrace.slice(0, 10000) : null;
    const breadcrumbsStr = normalizeBreadcrumbs(breadcrumbs);
    const userHashStr = normalizeUserHash(userHash);

    const stmt = db.prepare(`
      INSERT INTO error_reports (
        category, error_type, message, app_version, platform, arch, os_version,
        context, stack_trace, session_id, ip_hash, breadcrumbs, user_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      breadcrumbsStr,
      userHashStr
    );

    // Aggregate error into issues and trigger alerts if needed
    try {
      const issue = processErrorReport(result.lastInsertRowid, {
        category,
        errorType,
        message: message || '',
        appVersion: appVersion || '',
        stackTrace: stackTraceStr,
        sessionId,
        userHash: userHashStr
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

    // Store session snapshots asynchronously
    if (Array.isArray(snapshots) && snapshots.length > 0) {
      setImmediate(() => {
        try {
          const snapshotStmt = db.prepare(`
            INSERT INTO session_snapshots (report_id, snapshot_index, timestamp, trigger_reason, snapshot_data)
            VALUES (?, ?, ?, ?, ?)
          `);
          const capped = snapshots.slice(0, 10); // Max 10 snapshots per report
          for (const snap of capped) {
            if (!snap.data || typeof snap.data !== 'string') continue;
            if (snap.data.length > 200000) continue; // 200KB cap per snapshot
            snapshotStmt.run(
              result.lastInsertRowid,
              snap.index ?? 0,
              snap.timestamp ? new Date(snap.timestamp).toISOString() : new Date().toISOString(),
              snap.trigger || null,
              snap.data
            );
          }
        } catch (snapErr) {
          logger.debug({ error: snapErr?.message }, 'Failed to store session snapshots');
        }
      });
    }

    // Symbolicate stack trace asynchronously (don't block the response)
    if (stackTraceStr && appVersion) {
      setImmediate(async () => {
        try {
          // For web, use short git SHA; for desktop, app_version is the semver
          const releaseVersion = appVersion === 'web' ? null : appVersion;
          // Try to find release by looking up most recent for web platform
          let version = releaseVersion;
          if (!version) {
            const latest = db.prepare(
              "SELECT version FROM releases WHERE platform = 'web' ORDER BY created_at DESC LIMIT 1"
            ).get();
            if (latest) version = latest.version;
          }

          if (version) {
            const symbolicatedStack = await symbolicate(stackTraceStr, version);
            if (symbolicatedStack) {
              const release = db.prepare('SELECT id FROM releases WHERE version = ?').get(version);
              db.prepare(
                'UPDATE error_reports SET symbolicated_stack = ?, release_id = ? WHERE id = ?'
              ).run(symbolicatedStack, release?.id || null, result.lastInsertRowid);
            }
          }
        } catch (symErr) {
          logger.debug({ error: symErr?.message }, 'Symbolication failed for report');
        }
      });
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
    const results = [];

    const insertStmt = db.prepare(`
      INSERT INTO error_reports (
        category, error_type, message, app_version, platform, arch, os_version,
        context, stack_trace, session_id, ip_hash, breadcrumbs, user_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const [index, report] of reports.entries()) {
      try {
        const resultItem = { index, accepted: false, reason: null };
        const {
          category, errorType, message, appVersion, platform,
          arch, osVersion, context, stackTrace, sessionId, breadcrumbs, userHash
        } = report;

        // Basic validation
        if (!category || !errorType || !sessionId) {
          resultItem.reason = 'missing_required_fields';
          results.push(resultItem);
          failed++;
          continue;
        }

        if (!VALID_CATEGORIES.includes(category)) {
          resultItem.reason = 'invalid_category';
          results.push(resultItem);
          failed++;
          continue;
        }

        const contextValidation = validateContext(context);
        if (!contextValidation.ok) {
          resultItem.reason = 'invalid_context';
          results.push(resultItem);
          failed++;
          continue;
        }

        const contextStr = contextValidation.contextStr;
        const stackTraceStr = typeof stackTrace === 'string' ? stackTrace.slice(0, 10000) : null;
        const breadcrumbsStr = normalizeBreadcrumbs(breadcrumbs);
        const userHashStr = normalizeUserHash(userHash);

        const insertResult = insertStmt.run(
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
          breadcrumbsStr,
          userHashStr
        );

        // Aggregate
        try {
          const issue = processErrorReport(insertResult.lastInsertRowid, {
            category,
            errorType,
            message: message || '',
            appVersion: appVersion || '',
            stackTrace: stackTraceStr,
            sessionId,
            userHash: userHashStr
          });
          if (issue.isNew) {
            logger.info({ issueId: issue.id, category, errorType }, 'New error issue detected (batch)');
          }
        } catch (aggregateErr) {
          logger.error({ error: aggregateErr?.message || aggregateErr }, 'Error aggregating batch report');
        }

        resultItem.accepted = true;
        resultItem.reportId = insertResult.lastInsertRowid;
        results.push(resultItem);
        processed++;
      } catch (reportErr) {
        logger.error({ error: reportErr?.message || reportErr }, 'Error processing batch report item');
        results.push({
          index,
          accepted: false,
          reason: 'internal_error'
        });
        failed++;
      }
    }

    res.status(200).json({ processed, failed, results });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error processing batch report');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
