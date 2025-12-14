import db from '../../db/index.js';
import { getUserSubscription } from '../authService.js';

// Quota limits by tier
const LIMITS = {
  free: 100,      // requests per month
  premium: Infinity
};

// Rate limits by tier (requests per minute)
const RATE_LIMITS = {
  free: 10,
  premium: 30
};

export async function checkQuota(userId) {
  const subscription = getUserSubscription(userId);
  const tier = subscription?.tier || 'free';
  const limit = LIMITS[tier];

  if (limit === Infinity) {
    return {
      allowed: true,
      tier,
      limit: null,
      used: null,
      remaining: null
    };
  }

  const currentMonth = new Date().toISOString().slice(0, 7);

  // Get current usage from monthly rollup
  const stmt = db.prepare(`
    SELECT request_count
    FROM llm_usage_monthly
    WHERE user_id = ? AND month = ?
  `);
  const usage = stmt.get(userId, currentMonth);
  const used = usage?.request_count || 0;

  return {
    allowed: used < limit,
    tier,
    limit,
    used,
    remaining: Math.max(0, limit - used)
  };
}

export async function trackUsage(userId, provider, model, usage, requestType = 'chat') {
  const currentMonth = new Date().toISOString().slice(0, 7);

  // Insert detailed usage record
  const insertStmt = db.prepare(`
    INSERT INTO llm_usage (user_id, provider, model, prompt_tokens, completion_tokens, total_tokens, request_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertStmt.run(
    userId,
    provider,
    model,
    usage.promptTokens || 0,
    usage.completionTokens || 0,
    usage.totalTokens || 0,
    requestType
  );

  // Update monthly rollup (upsert)
  const upsertStmt = db.prepare(`
    INSERT INTO llm_usage_monthly (user_id, month, request_count, total_tokens, updated_at)
    VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, month) DO UPDATE SET
      request_count = request_count + 1,
      total_tokens = total_tokens + excluded.total_tokens,
      updated_at = CURRENT_TIMESTAMP
  `);
  upsertStmt.run(userId, currentMonth, usage.totalTokens || 0);
}

export function getUsageStats(userId) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const subscription = getUserSubscription(userId);
  const tier = subscription?.tier || 'free';
  const limit = LIMITS[tier];

  // Get monthly rollup
  const rollupStmt = db.prepare(`
    SELECT request_count, total_tokens
    FROM llm_usage_monthly
    WHERE user_id = ? AND month = ?
  `);
  const rollup = rollupStmt.get(userId, currentMonth);

  // Get breakdown by provider
  const breakdownStmt = db.prepare(`
    SELECT
      provider,
      model,
      COUNT(*) as request_count,
      SUM(prompt_tokens) as prompt_tokens,
      SUM(completion_tokens) as completion_tokens,
      SUM(total_tokens) as total_tokens
    FROM llm_usage
    WHERE user_id = ? AND created_at >= date('now', 'start of month')
    GROUP BY provider, model
  `);
  const breakdown = breakdownStmt.all(userId);

  // Get daily usage for the current month
  const dailyStmt = db.prepare(`
    SELECT
      date(created_at) as date,
      COUNT(*) as request_count,
      SUM(total_tokens) as total_tokens
    FROM llm_usage
    WHERE user_id = ? AND created_at >= date('now', 'start of month')
    GROUP BY date(created_at)
    ORDER BY date(created_at)
  `);
  const daily = dailyStmt.all(userId);

  return {
    month: currentMonth,
    tier,
    limit: limit === Infinity ? null : limit,
    used: rollup?.request_count || 0,
    remaining: limit === Infinity ? null : Math.max(0, limit - (rollup?.request_count || 0)),
    totalTokens: rollup?.total_tokens || 0,
    breakdown: breakdown.map(row => ({
      provider: row.provider,
      model: row.model,
      requestCount: row.request_count,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: row.total_tokens
    })),
    daily: daily.map(row => ({
      date: row.date,
      requestCount: row.request_count,
      totalTokens: row.total_tokens
    }))
  };
}

export function getRateLimit(tier = 'free') {
  return RATE_LIMITS[tier] || RATE_LIMITS.free;
}

export function getQuotaLimit(tier = 'free') {
  return LIMITS[tier] || LIMITS.free;
}
