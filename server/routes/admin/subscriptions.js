import express from 'express';
import db from '../../db/index.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/**
 * GET /api/admin/subscriptions/overview
 * Subscription distribution, MRR estimate, recent changes
 */
router.get('/overview', (req, res) => {
  try {
    // Count by tier (include users with no subscription as free)
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const subscribedByTier = db.prepare(`
      SELECT tier, COUNT(*) as count
      FROM subscriptions
      GROUP BY tier
    `).all();

    const tierMap = { free: 0, premium: 0, pro: 0 };
    for (const row of subscribedByTier) {
      tierMap[row.tier] = row.count;
    }
    // Users without a subscription row are free
    const subscribedTotal = Object.values(tierMap).reduce((a, b) => a + b, 0);
    tierMap.free = totalUsers - subscribedTotal + tierMap.free;

    // Count by status
    const byStatus = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM subscriptions
      GROUP BY status
    `).all();
    const statusMap = {};
    for (const row of byStatus) {
      statusMap[row.status] = row.count;
    }

    // Count by billing interval
    const byInterval = db.prepare(`
      SELECT COALESCE(billing_interval, 'none') as interval, COUNT(*) as count
      FROM subscriptions
      GROUP BY COALESCE(billing_interval, 'none')
    `).all();
    const intervalMap = {};
    for (const row of byInterval) {
      intervalMap[row.interval] = row.count;
    }

    // MRR estimate (premium=$10/mo, pro=$25/mo — active only)
    const premiumActive = db.prepare(`
      SELECT COUNT(*) as count FROM subscriptions
      WHERE tier = 'premium' AND status = 'active'
    `).get().count;
    const proActive = db.prepare(`
      SELECT COUNT(*) as count FROM subscriptions
      WHERE tier = 'pro' AND status = 'active'
    `).get().count;

    const premiumMonthly = db.prepare(`
      SELECT COUNT(*) as count FROM subscriptions
      WHERE tier = 'premium' AND status = 'active' AND billing_interval = 'month'
    `).get().count;
    const premiumYearly = db.prepare(`
      SELECT COUNT(*) as count FROM subscriptions
      WHERE tier = 'premium' AND status = 'active' AND billing_interval = 'year'
    `).get().count;
    const proMonthly = db.prepare(`
      SELECT COUNT(*) as count FROM subscriptions
      WHERE tier = 'pro' AND status = 'active' AND billing_interval = 'month'
    `).get().count;
    const proYearly = db.prepare(`
      SELECT COUNT(*) as count FROM subscriptions
      WHERE tier = 'pro' AND status = 'active' AND billing_interval = 'year'
    `).get().count;

    // MRR: monthly subs at full price, yearly subs at monthly equivalent
    const mrrCents =
      (premiumMonthly * 1000) + (premiumYearly * 800) +
      (proMonthly * 2500) + (proYearly * 2000);

    // Recent subscription changes
    const recentChanges = db.prepare(`
      SELECT
        s.user_id as userId,
        u.email,
        s.tier,
        s.status,
        s.updated_at as updatedAt
      FROM subscriptions s
      JOIN users u ON s.user_id = u.id
      ORDER BY s.updated_at DESC
      LIMIT 20
    `).all();

    res.json({
      byTier: tierMap,
      byStatus: statusMap,
      byInterval: intervalMap,
      mrr: {
        estimateCents: mrrCents,
        estimateDollars: (mrrCents / 100).toFixed(2),
        premiumCount: premiumActive,
        proCount: proActive
      },
      recentChanges
    });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching subscription overview');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
