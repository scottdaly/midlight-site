import express from 'express';
import fs from 'fs';
import db, { dbPath } from '../../db/index.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/**
 * GET /api/admin/system
 * System info: DB size, user counts, uptime, app versions
 */
router.get('/', (req, res) => {
  try {
    // Database size
    let sizeBytes = 0;
    try {
      const stat = fs.statSync(dbPath);
      sizeBytes = stat.size;
    } catch {
      // DB file might not be at expected path
    }

    // User counts
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const active30d = db.prepare(`
      SELECT COUNT(DISTINCT user_id) as count
      FROM sessions
      WHERE created_at > datetime('now', '-30 days')
    `).get().count;
    const active7d = db.prepare(`
      SELECT COUNT(DISTINCT user_id) as count
      FROM sessions
      WHERE created_at > datetime('now', '-7 days')
    `).get().count;

    // Server info
    const uptimeSeconds = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const uptimeFormatted = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    // App versions from error reports
    const appVersions = db.prepare(`
      SELECT app_version as version, COUNT(*) as reportCount
      FROM error_reports
      WHERE app_version IS NOT NULL AND app_version != ''
      GROUP BY app_version
      ORDER BY reportCount DESC
      LIMIT 20
    `).all();

    res.json({
      database: {
        sizeBytes,
        sizeMB: (sizeBytes / (1024 * 1024)).toFixed(1)
      },
      users: {
        total: totalUsers,
        active30d,
        active7d
      },
      server: {
        uptimeSeconds,
        uptimeFormatted,
        nodeVersion: process.version,
        platform: process.platform
      },
      appVersions
    });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching system info');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
