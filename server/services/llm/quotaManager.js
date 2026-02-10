import db from '../../db/index.js';
import { getUserSubscription } from '../authService.js';
import { CONFIG } from '../../config/index.js';

// Rate limits by tier (requests per minute)
const RATE_LIMITS = {
  free: 10,
  premium: 30,
  pro: 60
};

// Request types exempt from token billing (system overhead)
const EXEMPT_REQUEST_TYPES = new Set(['classification', 'compaction']);

/**
 * Get the ISO timestamp for when the current quota period resets (1st of next month UTC)
 */
export function getResetsAt() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toISOString();
}

export async function checkQuota(userId) {
  const subscription = getUserSubscription(userId);
  const tier = subscription?.tier || 'free';
  const limit = getQuotaLimit(tier);

  if (limit === Infinity) {
    return {
      allowed: true,
      tier,
      limit: null,
      used: null,
      remaining: null,
      resetsAt: getResetsAt()
    };
  }

  const currentMonth = new Date().toISOString().slice(0, 7);

  // Get current billable token usage from monthly rollup
  const stmt = db.prepare(`
    SELECT billable_tokens
    FROM llm_usage_monthly
    WHERE user_id = ? AND month = ?
  `);
  const usage = stmt.get(userId, currentMonth);
  const used = usage?.billable_tokens || 0;

  return {
    allowed: used < limit,
    tier,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetsAt: getResetsAt()
  };
}

export async function trackUsage(userId, provider, model, usage, requestType = 'chat', effortLane = null, promptVersion = null) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const totalTokens = usage.totalTokens || 0;
  const isBillable = !EXEMPT_REQUEST_TYPES.has(requestType);
  const billableTokens = isBillable ? totalTokens : 0;

  // Insert detailed usage record
  const insertStmt = db.prepare(`
    INSERT INTO llm_usage (user_id, provider, model, prompt_tokens, completion_tokens, total_tokens, request_type, effort_lane, prompt_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertStmt.run(
    userId,
    provider,
    model,
    usage.promptTokens || 0,
    usage.completionTokens || 0,
    totalTokens,
    requestType,
    effortLane,
    promptVersion
  );

  // Update monthly rollup (upsert)
  const upsertStmt = db.prepare(`
    INSERT INTO llm_usage_monthly (user_id, month, request_count, total_tokens, billable_tokens, updated_at)
    VALUES (?, ?, 1, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, month) DO UPDATE SET
      request_count = request_count + 1,
      total_tokens = total_tokens + excluded.total_tokens,
      billable_tokens = billable_tokens + excluded.billable_tokens,
      updated_at = CURRENT_TIMESTAMP
  `);
  upsertStmt.run(userId, currentMonth, totalTokens, billableTokens);
}

export function getUsageStats(userId) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const subscription = getUserSubscription(userId);
  const tier = subscription?.tier || 'free';
  const limit = getQuotaLimit(tier);

  // Get monthly rollup
  const rollupStmt = db.prepare(`
    SELECT request_count, total_tokens, billable_tokens
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

  const used = rollup?.billable_tokens || 0;

  return {
    month: currentMonth,
    tier,
    limit: limit === Infinity ? null : limit,
    used,
    remaining: limit === Infinity ? null : Math.max(0, limit - used),
    resetsAt: getResetsAt(),
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
  const tierConfig = CONFIG.quota[tier] || CONFIG.quota.free;
  return tierConfig.monthlyTokens;
}
