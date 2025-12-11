import express from 'express';
import crypto from 'crypto';
import db from '../db/index.js';

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
      sessionId,
      timestamp // Client provided timestamp, but we usually use server time for 'received_at'
    } = req.body;

    // Basic Validation
    if (!category || !errorType || !sessionId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Comprehensive Validation based on @ERROR_REPORTING_BACKEND.md
    const validCategories = {
      'update': ['checksum', 'network', 'download', 'install', 'unknown'],
      'import': ['path_traversal', 'file_read', 'file_write', 'parse', 'disk_space', 'checksum', 'rollback', 'cancelled', 'unknown'],
      'file_system': [], // Assuming generic file system errors or not strictly defined yet, allowing any
      'crash': ['uncaught_exception', 'renderer_crash', 'renderer_unresponsive'],
      'uncaught': ['unhandled_rejection', 'renderer_react_error', 'renderer_window_error', 'renderer_unhandled_promise']
    };

    if (!Object.keys(validCategories).includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    // Validate errorType if the category has specific types defined
    // For 'file_system', we currently allow any type as it wasn't explicitly enumerated with a closed set in the prompt's reference, 
    // or we can treat it as open. If strict validation is needed for file_system, we would need those types.
    // Based on the prompt, only Update, Import, Crash, and Uncaught have specific types listed.
    if (validCategories[category].length > 0 && !validCategories[category].includes(errorType)) {
       return res.status(400).json({ error: `Invalid errorType '${errorType}' for category '${category}'` });
    }

    // Validate Context (must be an object if present)
    if (context && (typeof context !== 'object' || Array.isArray(context))) {
      return res.status(400).json({ error: 'Context must be a JSON object' });
    }

    const ipHash = hashIp(req.ip);
    const contextStr = context ? JSON.stringify(context) : null;

    const stmt = db.prepare(`
      INSERT INTO error_reports (
        category, error_type, message, app_version, platform, arch, os_version, context, session_id, ip_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      category,
      errorType,
      message || '',
      appVersion || '',
      platform || '',
      arch || '',
      osVersion || '',
      contextStr,
      sessionId,
      ipHash
    );

    res.status(200).json({ success: true });

  } catch (err) {
    console.error('Error processing report:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/errors
// Protected by Basic Auth (middleware applied in main server file or here)
router.get('/admin/errors', (req, res) => {
  try {
    const { limit = 100, offset = 0, category } = req.query;
    
    let query = 'SELECT * FROM error_reports';
    const params = [];

    if (category) {
      query += ' WHERE category = ?';
      params.push(category);
    }

    query += ' ORDER BY received_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

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
    console.error('Error fetching reports:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
