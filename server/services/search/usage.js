// Search usage tracking
// Follows existing quota patterns in quotaManager.js

import db from '../../db/index.js';

/**
 * Track search usage for a user
 * @param {number} userId
 * @param {Object} usage
 * @param {number} usage.queryCount - Number of search queries
 * @param {number} usage.cachedCount - Number of cached results
 * @param {number} usage.costCents - Total cost in cents
 * @param {string} [usage.provider='tavily'] - Search provider used
 */
export function trackSearchUsage(userId, usage) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const provider = usage.provider || 'tavily';

  try {
    // Insert detailed record
    const insertStmt = db.prepare(`
      INSERT INTO search_usage (user_id, query_count, cached_count, cost_cents, provider)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertStmt.run(userId, usage.queryCount, usage.cachedCount, usage.costCents, provider);

    // Update monthly rollup (upsert)
    const upsertStmt = db.prepare(`
      INSERT INTO search_usage_monthly (user_id, month, search_count, cached_count, total_cost_cents, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, month) DO UPDATE SET
        search_count = search_count + excluded.search_count,
        cached_count = cached_count + excluded.cached_count,
        total_cost_cents = total_cost_cents + excluded.total_cost_cents,
        updated_at = CURRENT_TIMESTAMP
    `);
    upsertStmt.run(userId, currentMonth, usage.queryCount, usage.cachedCount, usage.costCents);
  } catch (error) {
    console.error('[SearchUsage] Tracking failed:', error.message);
  }
}

/**
 * Get search usage stats for a user
 * @param {number} userId
 * @returns {Object} Usage statistics
 */
export function getSearchUsageStats(userId) {
  const currentMonth = new Date().toISOString().slice(0, 7);

  try {
    // Get monthly rollup
    const rollupStmt = db.prepare(`
      SELECT search_count, cached_count, total_cost_cents
      FROM search_usage_monthly
      WHERE user_id = ? AND month = ?
    `);
    const rollup = rollupStmt.get(userId, currentMonth);

    // Get daily breakdown
    const dailyStmt = db.prepare(`
      SELECT
        date(created_at) as date,
        SUM(query_count) as search_count,
        SUM(cached_count) as cached_count,
        SUM(cost_cents) as cost_cents
      FROM search_usage
      WHERE user_id = ? AND created_at >= date('now', 'start of month')
      GROUP BY date(created_at)
      ORDER BY date(created_at)
    `);
    const daily = dailyStmt.all(userId);

    const searchCount = rollup?.search_count || 0;
    const cachedCount = rollup?.cached_count || 0;
    const cacheHitRate = searchCount > 0
      ? ((cachedCount / searchCount) * 100).toFixed(1)
      : '0.0';

    return {
      month: currentMonth,
      searchCount,
      cachedCount,
      totalCostCents: rollup?.total_cost_cents || 0,
      totalCostDollars: ((rollup?.total_cost_cents || 0) / 100).toFixed(2),
      cacheHitRate: `${cacheHitRate}%`,
      daily: daily.map(row => ({
        date: row.date,
        searchCount: row.search_count,
        cachedCount: row.cached_count,
        costCents: row.cost_cents
      }))
    };
  } catch (error) {
    console.error('[SearchUsage] Stats failed:', error.message);
    return {
      month: currentMonth,
      searchCount: 0,
      cachedCount: 0,
      totalCostCents: 0,
      totalCostDollars: '0.00',
      cacheHitRate: '0.0%',
      daily: []
    };
  }
}

/**
 * Check if user is within search limits
 * @param {number} userId
 * @param {Object} limits
 * @param {number} limits.maxSearchesPerDay - Max searches per day
 * @param {number} limits.maxCostPerMonthCents - Max cost per month in cents
 * @returns {{allowed: boolean, reason?: string, usage?: Object}}
 */
export function checkSearchLimits(userId, limits) {
  const today = new Date().toISOString().split('T')[0];

  try {
    // Check daily limit
    const dailyStmt = db.prepare(`
      SELECT COALESCE(SUM(query_count), 0) as count
      FROM search_usage
      WHERE user_id = ? AND date(created_at) = ?
    `);
    const dailyUsage = dailyStmt.get(userId, today);
    const dailyCount = dailyUsage?.count || 0;

    if (dailyCount >= limits.maxSearchesPerDay) {
      return {
        allowed: false,
        reason: 'daily_limit',
        usage: { dailyCount, limit: limits.maxSearchesPerDay }
      };
    }

    // Check monthly cost limit
    const currentMonth = new Date().toISOString().slice(0, 7);
    const monthlyStmt = db.prepare(`
      SELECT total_cost_cents
      FROM search_usage_monthly
      WHERE user_id = ? AND month = ?
    `);
    const monthlyUsage = monthlyStmt.get(userId, currentMonth);
    const monthlyCost = monthlyUsage?.total_cost_cents || 0;

    if (monthlyCost >= limits.maxCostPerMonthCents) {
      return {
        allowed: false,
        reason: 'monthly_cost_limit',
        usage: { monthlyCost, limit: limits.maxCostPerMonthCents }
      };
    }

    return { allowed: true };
  } catch (error) {
    console.error('[SearchUsage] Limit check failed:', error.message);
    // Fail open - allow search if check fails
    return { allowed: true };
  }
}

/**
 * Get aggregate search stats (for admin dashboard)
 * @returns {Object} Aggregate statistics
 */
export function getAggregateStats() {
  const currentMonth = new Date().toISOString().slice(0, 7);

  try {
    const stats = db.prepare(`
      SELECT
        COUNT(DISTINCT user_id) as active_users,
        SUM(search_count) as total_searches,
        SUM(cached_count) as total_cached,
        SUM(total_cost_cents) as total_cost_cents
      FROM search_usage_monthly
      WHERE month = ?
    `).get(currentMonth);

    return {
      month: currentMonth,
      activeUsers: stats?.active_users || 0,
      totalSearches: stats?.total_searches || 0,
      totalCached: stats?.total_cached || 0,
      totalCostDollars: ((stats?.total_cost_cents || 0) / 100).toFixed(2),
      avgCacheHitRate: stats?.total_searches > 0
        ? ((stats.total_cached / stats.total_searches) * 100).toFixed(1) + '%'
        : '0.0%'
    };
  } catch (error) {
    console.error('[SearchUsage] Aggregate stats failed:', error.message);
    return {
      month: currentMonth,
      activeUsers: 0,
      totalSearches: 0,
      totalCached: 0,
      totalCostDollars: '0.00',
      avgCacheHitRate: '0.0%'
    };
  }
}
