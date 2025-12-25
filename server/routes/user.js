import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import {
  findUserById,
  updateUser,
  deleteUser,
  getUserSubscription,
  updatePassword
} from '../services/authService.js';
import { invalidateAllUserSessions } from '../services/tokenService.js';
import { requireAuth, attachSubscription } from '../middleware/auth.js';
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
    console.error('Get user error:', error);
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
    console.error('Update user error:', error);
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
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Update password
    await updatePassword(req.user.id, newPassword);

    // Invalidate all sessions (force re-login on other devices)
    invalidateAllUserSessions(req.user.id);

    res.json({ success: true, message: 'Password updated. Please log in again.' });
  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// GET /api/user/subscription - Get subscription details
router.get('/subscription', (req, res) => {
  try {
    const subscription = getUserSubscription(req.user.id);

    res.json({
      tier: subscription.tier,
      status: subscription.status,
      currentPeriodStart: subscription.current_period_start,
      currentPeriodEnd: subscription.current_period_end,
      createdAt: subscription.created_at
    });
  } catch (error) {
    console.error('Get subscription error:', error);
    res.status(500).json({ error: 'Failed to get subscription' });
  }
});

// GET /api/user/usage - Get LLM usage for current month
router.get('/usage', (req, res) => {
  try {
    const currentMonth = new Date().toISOString().slice(0, 7); // '2025-12'

    // Get monthly rollup
    const rollupStmt = db.prepare(`
      SELECT request_count, total_tokens
      FROM llm_usage_monthly
      WHERE user_id = ? AND month = ?
    `);
    const rollup = rollupStmt.get(req.user.id, currentMonth);

    // Get limit based on tier
    const limits = {
      free: 100,
      premium: Infinity
    };
    const limit = limits[req.subscription.tier] || limits.free;

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

    res.json({
      month: currentMonth,
      requestCount: rollup?.request_count || 0,
      totalTokens: rollup?.total_tokens || 0,
      limit: limit === Infinity ? null : limit,
      remaining: limit === Infinity ? null : Math.max(0, limit - (rollup?.request_count || 0)),
      tier: req.subscription.tier,
      breakdown: breakdown.reduce((acc, row) => {
        acc[row.provider] = {
          requestCount: row.request_count,
          totalTokens: row.total_tokens
        };
        return acc;
      }, {})
    });
  } catch (error) {
    console.error('Get usage error:', error);
    res.status(500).json({ error: 'Failed to get usage' });
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
    console.error('Get sessions error:', error);
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

// DELETE /api/user/sessions - Logout from all devices
router.delete('/sessions', (req, res) => {
  try {
    invalidateAllUserSessions(req.user.id);
    res.json({ success: true, message: 'Logged out from all devices' });
  } catch (error) {
    console.error('Delete sessions error:', error);
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
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

export default router;
