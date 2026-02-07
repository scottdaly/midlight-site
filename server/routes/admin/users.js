import express from 'express';
import db from '../../db/index.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/**
 * GET /api/admin/users?limit=50&offset=0&sort=created_at&order=desc&search=&tier=
 * List users with search and filtering
 */
router.get('/', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const { search, tier } = req.query;

    const conditions = [];
    const params = [];

    if (search) {
      conditions.push('(u.email LIKE ? OR u.display_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    if (tier) {
      if (tier === 'free') {
        conditions.push('(s.tier IS NULL OR s.tier = ?)');
        params.push('free');
      } else {
        conditions.push('s.tier = ?');
        params.push(tier);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const validSorts = ['created_at', 'email', 'last_active'];
    const sortMap = {
      created_at: 'u.created_at',
      email: 'u.email',
      last_active: 'lastActive'
    };
    const sort = validSorts.includes(req.query.sort) ? sortMap[req.query.sort] : 'u.created_at';
    const order = req.query.order?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const { total } = db.prepare(`
      SELECT COUNT(*) as total
      FROM users u
      LEFT JOIN subscriptions s ON u.id = s.user_id
      ${whereClause}
    `).get(...params);

    const users = db.prepare(`
      SELECT
        u.id,
        u.email,
        u.display_name as displayName,
        COALESCE(s.tier, 'free') as tier,
        COALESCE(s.status, 'none') as status,
        u.email_verified as emailVerified,
        u.created_at as createdAt,
        (SELECT MAX(created_at) FROM sessions WHERE user_id = u.id) as lastActive
      FROM users u
      LEFT JOIN subscriptions s ON u.id = s.user_id
      ${whereClause}
      ORDER BY ${sort} ${order}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({
      users,
      pagination: { total, limit, offset, hasMore: offset + users.length < total }
    });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching users');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/users/:id
 * Detailed user info
 */
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const currentMonth = new Date().toISOString().slice(0, 7);

    const user = db.prepare(`
      SELECT
        u.id, u.email, u.display_name as displayName,
        u.email_verified as emailVerified,
        u.created_at as createdAt
      FROM users u
      WHERE u.id = ?
    `).get(id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const subscription = db.prepare(`
      SELECT tier, status, stripe_subscription_id as stripeId,
             billing_interval as billingInterval,
             current_period_end as periodEnd,
             created_at as createdAt
      FROM subscriptions
      WHERE user_id = ?
    `).get(id);

    const llmUsage = db.prepare(`
      SELECT request_count, total_tokens
      FROM llm_usage_monthly
      WHERE user_id = ? AND month = ?
    `).get(id, currentMonth);

    const searchUsage = db.prepare(`
      SELECT search_count, total_cost_cents
      FROM search_usage_monthly
      WHERE user_id = ? AND month = ?
    `).get(id, currentMonth);

    const sessions = db.prepare(`
      SELECT id, created_at as createdAt, expires_at as expiresAt
      FROM sessions
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(id);

    const oauthAccounts = db.prepare(`
      SELECT provider, provider_user_id as providerUserId, created_at as createdAt
      FROM oauth_accounts
      WHERE user_id = ?
    `).all(id);

    res.json({
      user,
      subscription: subscription || { tier: 'free', status: 'none' },
      usage: {
        requestsThisMonth: llmUsage?.request_count || 0,
        tokensThisMonth: llmUsage?.total_tokens || 0,
        searchesThisMonth: searchUsage?.search_count || 0
      },
      sessions,
      oauthAccounts
    });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching user detail');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
