import express from 'express';
import db from '../../db/index.js';
import { logger } from '../../utils/logger.js';
import { getAggregateStats } from '../../services/search/usage.js';

const router = express.Router();

/**
 * GET /api/admin/search/overview
 * Search usage overview for current month
 */
router.get('/overview', (req, res) => {
  try {
    const stats = getAggregateStats();
    res.json(stats);
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching search overview');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/search/daily?days=30
 * Daily search usage trend
 */
router.get('/daily', (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);

    const daily = db.prepare(`
      SELECT
        date(created_at) as date,
        COALESCE(SUM(query_count), 0) as searches,
        COALESCE(SUM(cached_count), 0) as cached,
        COALESCE(SUM(cost_cents), 0) as costCents
      FROM search_usage
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY date(created_at)
      ORDER BY date ASC
    `).all(days);

    res.json({ daily });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching daily search');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/search/users?limit=20
 * Top search users
 */
router.get('/users', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const currentMonth = new Date().toISOString().slice(0, 7);

    const users = db.prepare(`
      SELECT
        sm.user_id as userId,
        u.email,
        sm.search_count as searches,
        sm.cached_count as cached,
        sm.total_cost_cents as costCents
      FROM search_usage_monthly sm
      JOIN users u ON sm.user_id = u.id
      WHERE sm.month = ?
      ORDER BY sm.search_count DESC
      LIMIT ?
    `).all(currentMonth, limit);

    res.json({ users });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching search users');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
