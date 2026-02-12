import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { logger } from '../utils/logger.js';
import {
  findUserById,
  updateUser,
  deleteUser,
  getUserSubscription,
  updatePassword
} from '../services/authService.js';
import { invalidateAllUserSessions } from '../services/tokenService.js';
import { requireAuth, attachSubscription } from '../middleware/auth.js';
import {
  checkPasswordRateLimit,
  recordPasswordAttempt,
  getRemainingPasswordAttempts
} from '../middleware/rateLimiters.js';
import { checkQuota, getQuotaLimit, getResetsAt } from '../services/llm/quotaManager.js';
import { CONFIG } from '../config/index.js';
import db from '../db/index.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);
router.use(attachSubscription);

// GET /api/user/me - Get current user profile
router.get('/me', (req, res) => {
  try {
    res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        displayName: req.user.display_name,
        avatarUrl: req.user.avatar_url,
        emailVerified: Boolean(req.user.email_verified),
        createdAt: req.user.created_at
      },
      subscription: {
        tier: req.subscription.tier,
        status: req.subscription.status,
        currentPeriodEnd: req.subscription.current_period_end
      }
    });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Get user error');
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

// GET /api/user/profile - Get full user profile with subscription and quota
// This is the endpoint used by the web app for auth initialization
router.get('/profile', (req, res) => {
  try {
    // Get quota info (token-based)
    const currentMonth = new Date().toISOString().slice(0, 7);
    const rollupStmt = db.prepare(`
      SELECT billable_tokens
      FROM llm_usage_monthly
      WHERE user_id = ? AND month = ?
    `);
    const rollup = rollupStmt.get(req.user.id, currentMonth);

    const limit = getQuotaLimit(req.subscription.tier);
    const used = rollup?.billable_tokens || 0;

    res.json({
      user: {
        id: req.user.id,
        email: req.user.email,
        displayName: req.user.display_name,
        avatarUrl: req.user.avatar_url,
        emailVerified: Boolean(req.user.email_verified),
        createdAt: req.user.created_at
      },
      subscription: {
        tier: req.subscription.tier,
        status: req.subscription.status,
        billingInterval: req.subscription.billing_interval || null,
        currentPeriodEnd: req.subscription.current_period_end
      },
      quota: {
        tier: req.subscription.tier,
        limit: limit === Infinity ? null : limit,
        used,
        remaining: limit === Infinity ? null : Math.max(0, limit - used),
        resetsAt: getResetsAt()
      }
    });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Get profile error');
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

// PATCH /api/user/me - Update user profile
router.patch('/me', [
  body('displayName').optional().trim().isLength({ min: 1, max: 100 }),
  body('avatarUrl').optional().isURL().withMessage('Invalid avatar URL')
], (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { displayName, avatarUrl } = req.body;
    const updates = {};

    if (displayName !== undefined) updates.displayName = displayName;
    if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const updatedUser = updateUser(req.user.id, updates);

    res.json({
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        displayName: updatedUser.display_name,
        avatarUrl: updatedUser.avatar_url
      }
    });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Update user error');
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /api/user/password - Change password
router.post('/password', [
  body('currentPassword').notEmpty().withMessage('Current password required'),
  body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Check rate limit before processing
    if (!checkPasswordRateLimit(req.user.id)) {
      const remaining = getRemainingPasswordAttempts(req.user.id);
      return res.status(429).json({
        error: 'Too many password change attempts. Please try again in 1 hour.',
        remainingAttempts: remaining
      });
    }

    const { currentPassword, newPassword } = req.body;

    // Get full user with password hash
    const stmt = db.prepare('SELECT password_hash FROM users WHERE id = ?');
    const user = stmt.get(req.user.id);

    if (!user.password_hash) {
      return res.status(400).json({
        error: 'Cannot set password for OAuth-only account. Link email first.'
      });
    }

    // Verify current password
    const { verifyPassword } = await import('../services/authService.js');
    const valid = await verifyPassword(currentPassword, user.password_hash);

    // Record the attempt (success or failure)
    recordPasswordAttempt(req.user.id, valid, req.ip);

    if (!valid) {
      const remaining = getRemainingPasswordAttempts(req.user.id);
      return res.status(401).json({
        error: 'Current password is incorrect',
        remainingAttempts: remaining
      });
    }

    // Update password
    await updatePassword(req.user.id, newPassword);

    // Invalidate all sessions (force re-login on other devices)
    invalidateAllUserSessions(req.user.id);

    res.json({ success: true, message: 'Password updated. Please log in again.' });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Password change error');
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// GET /api/user/subscription - Get subscription details
router.get('/subscription', (req, res) => {
  try {
    const subscription = getUserSubscription(req.user.id);

    res.json({
      subscription: {
        tier: subscription.tier,
        status: subscription.status,
        billingInterval: subscription.billing_interval || null,
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        createdAt: subscription.created_at
      }
    });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Get subscription error');
    res.status(500).json({ error: 'Failed to get subscription' });
  }
});

// GET /api/user/usage - Get LLM usage for current month
router.get('/usage', (req, res) => {
  try {
    const currentMonth = new Date().toISOString().slice(0, 7); // '2025-12'

    // Get monthly rollup (token-based)
    const rollupStmt = db.prepare(`
      SELECT request_count, total_tokens, billable_tokens
      FROM llm_usage_monthly
      WHERE user_id = ? AND month = ?
    `);
    const rollup = rollupStmt.get(req.user.id, currentMonth);

    // Get limit based on tier
    const limit = getQuotaLimit(req.subscription.tier);

    // Get breakdown by provider
    const breakdownStmt = db.prepare(`
      SELECT
        provider,
        COUNT(*) as request_count,
        SUM(total_tokens) as total_tokens
      FROM llm_usage
      WHERE user_id = ? AND created_at >= date('now', 'start of month')
      GROUP BY provider
    `);
    const breakdown = breakdownStmt.all(req.user.id);

    const used = rollup?.billable_tokens || 0;
    const remaining = limit === Infinity ? null : Math.max(0, limit - used);

    // Search usage for today
    const searchToday = db.prepare(`
      SELECT COALESCE(SUM(query_count), 0) as used
      FROM search_usage
      WHERE user_id = ? AND date(created_at) = date('now')
    `).get(req.user.id);

    // Search cost this month
    const searchMonthly = db.prepare(`
      SELECT COALESCE(total_cost_cents, 0) as costCents
      FROM search_usage_monthly
      WHERE user_id = ? AND month = ?
    `).get(req.user.id, currentMonth);

    const tier = req.subscription.tier;
    const searchLimits = CONFIG.search?.limits?.[tier] || CONFIG.search?.limits?.free || {};

    res.json({
      month: currentMonth,
      tier,
      quota: {
        used,
        limit: limit === Infinity ? null : limit,
        remaining,
        resetsAt: getResetsAt()
      },
      byProvider: breakdown.reduce((acc, row) => {
        acc[row.provider] = {
          requests: row.request_count,
          tokens: row.total_tokens
        };
        return acc;
      }, {}),
      search: {
        used: searchToday?.used || 0,
        dailyLimit: searchLimits.maxSearchesPerDay || 20,
        costCents: searchMonthly?.costCents || 0,
        monthlyCostLimitCents: searchLimits.maxCostPerMonthCents || 100
      }
    });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Get usage error');
    res.status(500).json({ error: 'Failed to get usage' });
  }
});

// GET /api/user/usage/daily - Daily usage breakdown for last 30 days
router.get('/usage/daily', (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);

    const dailyStmt = db.prepare(`
      SELECT
        date(created_at) as date,
        COUNT(*) as requests,
        COALESCE(SUM(total_tokens), 0) as tokens
      FROM llm_usage
      WHERE user_id = ? AND created_at > datetime('now', '-' || ? || ' days')
      GROUP BY date(created_at)
      ORDER BY date(created_at)
    `);
    const daily = dailyStmt.all(req.user.id, days);

    res.json({ daily });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Get daily usage error');
    res.status(500).json({ error: 'Failed to get daily usage' });
  }
});

// GET /api/user/quota - Get current quota status (used by web subscription client)
router.get('/quota', async (req, res) => {
  try {
    const quota = await checkQuota(req.user.id);

    res.json({
      tier: quota.tier,
      limit: quota.limit,
      used: quota.used,
      remaining: quota.remaining,
      resetsAt: quota.resetsAt,
      burnRate: quota.burnRate || undefined,
      estimatedDaysRemaining: quota.estimatedDaysRemaining ?? undefined
    });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Get user quota error');
    res.status(500).json({ error: 'Failed to get quota' });
  }
});

// GET /api/user/sessions - Get active sessions
router.get('/sessions', (req, res) => {
  try {
    // Get unique sessions by user_agent, keeping only the most recent per device
    const stmt = db.prepare(`
      SELECT id, user_agent, created_at, expires_at
      FROM sessions
      WHERE user_id = ? AND expires_at > datetime('now')
      GROUP BY user_agent
      HAVING created_at = MAX(created_at)
      ORDER BY created_at DESC
    `);
    const sessions = stmt.all(req.user.id);

    res.json({
      sessions: sessions.map(s => ({
        id: s.id,
        userAgent: s.user_agent,
        createdAt: s.created_at,
        expiresAt: s.expires_at
      }))
    });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Get sessions error');
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

// DELETE /api/user/sessions - Logout from all devices
router.delete('/sessions', (req, res) => {
  try {
    invalidateAllUserSessions(req.user.id);
    res.json({ success: true, message: 'Logged out from all devices' });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Delete sessions error');
    res.status(500).json({ error: 'Failed to logout from all devices' });
  }
});

// DELETE /api/user/me - Delete account
router.delete('/me', (req, res) => {
  try {
    // This will cascade delete oauth_accounts, subscriptions, llm_usage, sessions
    deleteUser(req.user.id);
    res.json({ success: true, message: 'Account deleted' });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Delete user error');
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

export default router;
