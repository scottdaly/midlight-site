import express from 'express';
import db from '../../db/index.js';
import { logger } from '../../utils/logger.js';
import { computeCostCents } from '../../config/llmPricing.js';

const router = express.Router();

/**
 * GET /api/admin/usage/overview
 * Monthly usage overview with provider, model, and tier breakdowns + cost estimates
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

    // By provider + model (detailed, for cost computation)
    const byModel = db.prepare(`
      SELECT
        provider, model,
        COUNT(*) as requests,
        COALESCE(SUM(prompt_tokens), 0) as promptTokens,
        COALESCE(SUM(completion_tokens), 0) as completionTokens,
        COALESCE(SUM(total_tokens), 0) as tokens
      FROM llm_usage
      WHERE created_at >= date('now', 'start of month')
      GROUP BY provider, model
      ORDER BY requests DESC
    `).all().map(row => ({
      ...row,
      costCents: computeCostCents(row.provider, row.model, row.promptTokens, row.completionTokens)
    }));

    // Aggregate by provider from byModel
    const providerMap = {};
    for (const row of byModel) {
      if (!providerMap[row.provider]) {
        providerMap[row.provider] = { provider: row.provider, requests: 0, tokens: 0, costCents: 0 };
      }
      providerMap[row.provider].requests += row.requests;
      providerMap[row.provider].tokens += row.tokens;
      providerMap[row.provider].costCents += row.costCents;
    }
    const byProvider = Object.values(providerMap).sort((a, b) => b.requests - a.requests);

    // By tier (join with subscriptions) — need per-model detail for cost
    const byTierRaw = db.prepare(`
      SELECT
        COALESCE(s.tier, 'free') as tier,
        u.provider, u.model,
        COUNT(*) as requests,
        COALESCE(SUM(u.prompt_tokens), 0) as promptTokens,
        COALESCE(SUM(u.completion_tokens), 0) as completionTokens,
        COALESCE(SUM(u.total_tokens), 0) as tokens,
        COUNT(DISTINCT u.user_id) as users
      FROM llm_usage u
      LEFT JOIN subscriptions s ON u.user_id = s.user_id
      WHERE u.created_at >= date('now', 'start of month')
      GROUP BY COALESCE(s.tier, 'free'), u.provider, u.model
    `).all();

    // Aggregate by tier
    const tierMap = {};
    for (const row of byTierRaw) {
      if (!tierMap[row.tier]) {
        tierMap[row.tier] = { tier: row.tier, requests: 0, tokens: 0, users: new Set(), costCents: 0 };
      }
      tierMap[row.tier].requests += row.requests;
      tierMap[row.tier].tokens += row.tokens;
      tierMap[row.tier].costCents += computeCostCents(row.provider, row.model, row.promptTokens, row.completionTokens);
      // users is approximate since we can't dedupe across provider/model groups easily
    }
    // Get accurate user counts per tier
    const tierUserCounts = db.prepare(`
      SELECT
        COALESCE(s.tier, 'free') as tier,
        COUNT(DISTINCT u.user_id) as users
      FROM llm_usage u
      LEFT JOIN subscriptions s ON u.user_id = s.user_id
      WHERE u.created_at >= date('now', 'start of month')
      GROUP BY COALESCE(s.tier, 'free')
    `).all();
    for (const tc of tierUserCounts) {
      if (tierMap[tc.tier]) tierMap[tc.tier].users = tc.users;
    }
    const byTier = Object.values(tierMap)
      .map(t => ({ tier: t.tier, requests: t.requests, tokens: t.tokens, users: typeof t.users === 'number' ? t.users : 0, costCents: Math.round(t.costCents * 100) / 100 }))
      .sort((a, b) => b.requests - a.requests);

    // Round cost values
    for (const row of byProvider) {
      row.costCents = Math.round(row.costCents * 100) / 100;
    }

    const totalCostCents = byModel.reduce((sum, r) => sum + r.costCents, 0);

    // By effort lane
    const byLane = db.prepare(`
      SELECT
        COALESCE(effort_lane, 'unknown') as lane,
        COUNT(*) as requests,
        COALESCE(SUM(total_tokens), 0) as tokens
      FROM llm_usage
      WHERE created_at >= date('now', 'start of month')
      GROUP BY COALESCE(effort_lane, 'unknown')
      ORDER BY requests DESC
    `).all();

    res.json({
      month: currentMonth,
      totalRequests: totals.totalRequests,
      totalTokens: totals.totalTokens,
      totalCostCents: Math.round(totalCostCents * 100) / 100,
      totalCostDollars: (totalCostCents / 100).toFixed(2),
      byProvider,
      byModel,
      byTier,
      byLane
    });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching usage overview');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/usage/daily?days=30
 * Daily usage trend with cost estimates
 */
router.get('/daily', (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);

    // Get daily data grouped by date + provider + model for cost computation
    const dailyRaw = db.prepare(`
      SELECT
        date(created_at) as date,
        provider, model,
        COUNT(*) as requests,
        COALESCE(SUM(prompt_tokens), 0) as promptTokens,
        COALESCE(SUM(completion_tokens), 0) as completionTokens,
        COALESCE(SUM(total_tokens), 0) as tokens
      FROM llm_usage
      WHERE created_at > datetime('now', '-' || ? || ' days')
      GROUP BY date(created_at), provider, model
      ORDER BY date ASC
    `).all(days);

    // Aggregate by date
    const dateMap = {};
    for (const row of dailyRaw) {
      if (!dateMap[row.date]) {
        dateMap[row.date] = { date: row.date, requests: 0, tokens: 0, costCents: 0 };
      }
      dateMap[row.date].requests += row.requests;
      dateMap[row.date].tokens += row.tokens;
      dateMap[row.date].costCents += computeCostCents(row.provider, row.model, row.promptTokens, row.completionTokens);
    }

    const daily = Object.values(dateMap)
      .map(d => ({ ...d, costCents: Math.round(d.costCents * 100) / 100 }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({ daily });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching daily usage');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/admin/usage/users?limit=50&offset=0&sort=requests&order=desc
 * Top users by usage with cost estimates
 */
router.get('/users', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const currentMonth = new Date().toISOString().slice(0, 7);

    const validSorts = ['requests', 'tokens', 'email', 'cost'];
    const sortMap = { requests: 'm.request_count', tokens: 'm.total_tokens', email: 'u.email' };
    const sortByCost = req.query.sort === 'cost';
    const sort = sortByCost ? 'm.request_count' : (validSorts.includes(req.query.sort) ? sortMap[req.query.sort] : 'm.request_count');
    const order = req.query.order?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const { total } = db.prepare(`
      SELECT COUNT(*) as total
      FROM llm_usage_monthly m
      WHERE m.month = ?
    `).get(currentMonth);

    let users;
    if (sortByCost) {
      // For cost sorting, we need to fetch all users, compute cost, then paginate
      const allUsers = db.prepare(`
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
        ORDER BY m.request_count DESC
      `).all(currentMonth);

      // Get cost data for all users
      const userIds = allUsers.map(u => u.userId);
      if (userIds.length > 0) {
        const placeholders = userIds.map(() => '?').join(',');
        const costRows = db.prepare(`
          SELECT user_id, provider, model,
            COALESCE(SUM(prompt_tokens), 0) as promptTokens,
            COALESCE(SUM(completion_tokens), 0) as completionTokens
          FROM llm_usage
          WHERE created_at >= date('now', 'start of month') AND user_id IN (${placeholders})
          GROUP BY user_id, provider, model
        `).all(...userIds);

        const userCostMap = {};
        for (const row of costRows) {
          userCostMap[row.user_id] = (userCostMap[row.user_id] || 0) +
            computeCostCents(row.provider, row.model, row.promptTokens, row.completionTokens);
        }
        for (const u of allUsers) {
          u.costCents = Math.round((userCostMap[u.userId] || 0) * 100) / 100;
        }
      }

      allUsers.sort((a, b) => order === 'DESC' ? b.costCents - a.costCents : a.costCents - b.costCents);
      users = allUsers.slice(offset, offset + limit);
    } else {
      users = db.prepare(`
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

      // Get cost data for these users
      const userIds = users.map(u => u.userId);
      if (userIds.length > 0) {
        const placeholders = userIds.map(() => '?').join(',');
        const costRows = db.prepare(`
          SELECT user_id, provider, model,
            COALESCE(SUM(prompt_tokens), 0) as promptTokens,
            COALESCE(SUM(completion_tokens), 0) as completionTokens
          FROM llm_usage
          WHERE created_at >= date('now', 'start of month') AND user_id IN (${placeholders})
          GROUP BY user_id, provider, model
        `).all(...userIds);

        const userCostMap = {};
        for (const row of costRows) {
          userCostMap[row.user_id] = (userCostMap[row.user_id] || 0) +
            computeCostCents(row.provider, row.model, row.promptTokens, row.completionTokens);
        }
        for (const u of users) {
          u.costCents = Math.round((userCostMap[u.userId] || 0) * 100) / 100;
        }
      }
    }

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
 * Detailed usage for a specific user with cost estimates
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
        COALESCE(SUM(prompt_tokens), 0) as promptTokens,
        COALESCE(SUM(completion_tokens), 0) as completionTokens,
        COALESCE(SUM(total_tokens), 0) as tokens
      FROM llm_usage
      WHERE user_id = ? AND created_at >= date('now', 'start of month')
      GROUP BY provider, model
      ORDER BY requests DESC
    `).all(userId).map(row => ({
      ...row,
      costCents: computeCostCents(row.provider, row.model, row.promptTokens, row.completionTokens)
    }));

    // Daily with cost
    const dailyRaw = db.prepare(`
      SELECT
        date(created_at) as date,
        provider, model,
        COUNT(*) as requests,
        COALESCE(SUM(prompt_tokens), 0) as promptTokens,
        COALESCE(SUM(completion_tokens), 0) as completionTokens,
        COALESCE(SUM(total_tokens), 0) as tokens
      FROM llm_usage
      WHERE user_id = ? AND created_at >= date('now', 'start of month')
      GROUP BY date(created_at), provider, model
      ORDER BY date ASC
    `).all(userId);

    const dateMap = {};
    for (const row of dailyRaw) {
      if (!dateMap[row.date]) {
        dateMap[row.date] = { date: row.date, requests: 0, tokens: 0, costCents: 0 };
      }
      dateMap[row.date].requests += row.requests;
      dateMap[row.date].tokens += row.tokens;
      dateMap[row.date].costCents += computeCostCents(row.provider, row.model, row.promptTokens, row.completionTokens);
    }
    const daily = Object.values(dateMap)
      .map(d => ({ ...d, costCents: Math.round(d.costCents * 100) / 100 }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const totalCostCents = breakdown.reduce((sum, r) => sum + r.costCents, 0);

    res.json({
      user,
      month: currentMonth,
      requests: monthly?.requests || 0,
      tokens: monthly?.tokens || 0,
      totalCostCents: Math.round(totalCostCents * 100) / 100,
      totalCostDollars: (totalCostCents / 100).toFixed(2),
      breakdown,
      daily
    });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching user usage');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
