import express from 'express';
import db from '../../db/index.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/**
 * GET /api/admin/usage/overview
 * Monthly usage overview with provider and tier breakdowns
 */
router.get('/overview', (req, res) => {
  try {
    const currentMonth = new Date().toISOString().slice(0, 7);

    // Total requests and tokens this month
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(request_count), 0) as totalRequests,
        COALESCE(SUM(total_tokens), 0) as totalTokens
      FROM llm_usage_monthly
      WHERE month = ?
    `).get(currentMonth);

    // By provider
    const byProvider = db.prepare(`
      SELECT
        provider,
        COUNT(*) as requests,
        COALESCE(SUM(total_tokens), 0) as tokens
      FROM llm_usage
      WHERE created_at >= date('now', 'start of month')
      GROUP BY provider
      ORDER BY requests DESC
    `).all();

    // By tier (join with subscriptions)
    const byTier = db.prepare(`
      SELECT
        COALESCE(s.tier, 'free') as tier,
        COALESCE(SUM(m.request_count), 0) as requests,
        COALESCE(SUM(m.total_tokens), 0) as tokens,
        COUNT(DISTINCT m.user_id) as users
      FROM llm_usage_monthly m
      LEFT JOIN subscriptions s ON m.user_id = s.user_id
      WHERE m.month = ?
      GROUP BY COALESCE(s.tier, 'free')
      ORDER BY requests DESC
    `).all(currentMonth);

    res.json({
      month: currentMonth,
      totalRequests: totals.totalRequests,
      totalTokens: totals.totalTokens,
      byProvider,
      byTier
    });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching usage overview');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/usage/daily?days=30
 * Daily usage trend
 */
router.get('/daily', (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);

    const daily = db.prepare(`
      SELECT
        date(created_at) as date,
        COUNT(*) as requests,
        COALESCE(SUM(total_tokens), 0) as tokens
      FROM llm_usage
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY date(created_at)
      ORDER BY date ASC
    `).all(days);

    res.json({ daily });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching daily usage');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/usage/users?limit=50&offset=0&sort=requests&order=desc
 * Top users by usage
 */
router.get('/users', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const currentMonth = new Date().toISOString().slice(0, 7);

    const validSorts = ['requests', 'tokens', 'email'];
    const sortMap = { requests: 'm.request_count', tokens: 'm.total_tokens', email: 'u.email' };
    const sort = validSorts.includes(req.query.sort) ? sortMap[req.query.sort] : 'm.request_count';
    const order = req.query.order?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const { total } = db.prepare(`
      SELECT COUNT(*) as total
      FROM llm_usage_monthly m
      WHERE m.month = ?
    `).get(currentMonth);

    const users = db.prepare(`
      SELECT
        m.user_id as userId,
        u.email,
        COALESCE(s.tier, 'free') as tier,
        m.request_count as requests,
        m.total_tokens as tokens,
        (SELECT MAX(created_at) FROM sessions WHERE user_id = m.user_id) as lastActive
      FROM llm_usage_monthly m
      JOIN users u ON m.user_id = u.id
      LEFT JOIN subscriptions s ON m.user_id = s.user_id
      WHERE m.month = ?
      ORDER BY ${sort} ${order}
      LIMIT ? OFFSET ?
    `).all(currentMonth, limit, offset);

    res.json({
      users,
      pagination: { total, limit, offset, hasMore: offset + users.length < total }
    });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching usage users');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/usage/users/:userId
 * Detailed usage for a specific user
 */
router.get('/users/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const currentMonth = new Date().toISOString().slice(0, 7);

    const user = db.prepare(`
      SELECT u.id, u.email, u.display_name, COALESCE(s.tier, 'free') as tier
      FROM users u
      LEFT JOIN subscriptions s ON u.id = s.user_id
      WHERE u.id = ?
    `).get(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const monthly = db.prepare(`
      SELECT request_count as requests, total_tokens as tokens
      FROM llm_usage_monthly
      WHERE user_id = ? AND month = ?
    `).get(userId, currentMonth);

    const breakdown = db.prepare(`
      SELECT
        provider, model,
        COUNT(*) as requests,
        COALESCE(SUM(total_tokens), 0) as tokens
      FROM llm_usage
      WHERE user_id = ? AND created_at >= date('now', 'start of month')
      GROUP BY provider, model
      ORDER BY requests DESC
    `).all(userId);

    const daily = db.prepare(`
      SELECT
        date(created_at) as date,
        COUNT(*) as requests,
        COALESCE(SUM(total_tokens), 0) as tokens
      FROM llm_usage
      WHERE user_id = ? AND created_at >= date('now', 'start of month')
      GROUP BY date(created_at)
      ORDER BY date ASC
    `).all(userId);

    res.json({
      user,
      month: currentMonth,
      requests: monthly?.requests || 0,
      tokens: monthly?.tokens || 0,
      breakdown,
      daily
    });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching user usage');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
