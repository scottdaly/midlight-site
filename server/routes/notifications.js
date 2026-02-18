/**
 * Notifications Routes
 *
 * In-app notifications with SSE streaming and preference management.
 */

import { Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import db from '../db/index.js';
import {
  listMobileDevicesForUser,
  registerMobileDevice,
  unregisterMobileDevice,
} from '../services/mobileDeviceService.js';
import { logger } from '../utils/logger.js';

const router = Router();

// SSE connections by user ID
const sseClients = new Map();

/**
 * GET / — List notifications (paginated, filterable)
 */
router.get('/', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = parseInt(req.query.offset) || 0;
  const unreadOnly = req.query.unread === 'true';

  try {
    const whereClause = unreadOnly
      ? 'WHERE n.user_id = ? AND n.read_at IS NULL'
      : 'WHERE n.user_id = ?';

    const rows = db.prepare(`
      SELECT n.*, a.display_name AS actor_name, a.avatar_url AS actor_avatar
      FROM notifications n
      LEFT JOIN users a ON n.actor_id = a.id
      ${whereClause}
      ORDER BY n.created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.user.id, limit, offset);

    const total = db.prepare(
      `SELECT COUNT(*) AS count FROM notifications n ${whereClause}`
    ).get(req.user.id);

    res.json({
      notifications: rows.map(formatNotification),
      total: total.count,
      limit,
      offset,
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list notifications');
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

/**
 * GET /unread-count — Get unread notification count
 */
router.get('/unread-count', requireAuth, (req, res) => {
  try {
    const result = db.prepare(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL'
    ).get(req.user.id);
    res.json({ count: result.count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

/**
 * POST /:id/read — Mark notification as read
 */
router.post('/:id/read', requireAuth, (req, res) => {
  try {
    db.prepare(
      "UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ?"
    ).run(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

/**
 * POST /read-all — Mark all notifications as read
 */
router.post('/read-all', requireAuth, (req, res) => {
  try {
    const result = db.prepare(
      "UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL"
    ).run(req.user.id);
    res.json({ marked: result.changes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

/**
 * GET /preferences — Get notification preferences
 */
router.get('/preferences', requireAuth, (req, res) => {
  try {
    let prefs = db.prepare(
      'SELECT * FROM notification_preferences WHERE user_id = ?'
    ).get(req.user.id);

    if (!prefs) {
      // Create default preferences
      db.prepare(
        'INSERT OR IGNORE INTO notification_preferences (user_id) VALUES (?)'
      ).run(req.user.id);
      prefs = db.prepare(
        'SELECT * FROM notification_preferences WHERE user_id = ?'
      ).get(req.user.id);
    }

    res.json({ preferences: formatPreferences(prefs) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load preferences' });
  }
});

/**
 * PATCH /preferences — Update notification preferences
 */
router.patch('/preferences', requireAuth, (req, res) => {
  const allowed = ['emailComments', 'emailMentions', 'emailSuggestions', 'emailEdits', 'emailShares', 'inAppEnabled', 'digestFrequency'];
  const updates = {};

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates[key] = req.body[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  try {
    // Ensure row exists
    db.prepare(
      'INSERT OR IGNORE INTO notification_preferences (user_id) VALUES (?)'
    ).run(req.user.id);

    const setClauses = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      const column = key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
      setClauses.push(`${column} = ?`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }

    values.push(req.user.id);
    db.prepare(
      `UPDATE notification_preferences SET ${setClauses.join(', ')} WHERE user_id = ?`
    ).run(...values);

    const prefs = db.prepare(
      'SELECT * FROM notification_preferences WHERE user_id = ?'
    ).get(req.user.id);

    res.json({ preferences: formatPreferences(prefs) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update preferences');
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

/**
 * GET /mobile/register-device — List native push token registrations for current user
 */
router.get('/mobile/register-device', requireAuth, (req, res) => {
  try {
    const devices = listMobileDevicesForUser({
      userId: req.user.id,
    });

    res.json({
      devices: devices.map((device) => ({
        id: device.id,
        platform: device.platform,
        pushProvider: device.pushProvider,
        appVersion: device.appVersion,
        buildChannel: device.buildChannel,
        locale: device.locale,
        timezone: device.timezone,
        networkState: device.networkState,
        deliveryFailures: device.deliveryFailures,
        lastDeliveryError: device.lastDeliveryError,
        lastDeliveryErrorAt: device.lastDeliveryErrorAt,
        lastSeenAt: device.lastSeenAt,
      })),
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list mobile devices');
    res.status(500).json({ error: 'Failed to list mobile devices' });
  }
});

/**
 * POST /mobile/register-device — Register/update native push token
 */
router.post(
  '/mobile/register-device',
  requireAuth,
  [
    body('platform').isIn(['ios', 'android']).withMessage('platform must be ios or android'),
    body('deviceToken').isString().trim().notEmpty().withMessage('deviceToken is required'),
    body('pushProvider').optional().isIn(['apns', 'fcm', 'native']),
    body('appVersion').optional().isString(),
    body('buildChannel').optional().isIn(['debug', 'internal', 'beta', 'production']),
    body('locale').optional().isString(),
    body('timezone').optional().isString(),
    body('networkState').optional().isString(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const device = registerMobileDevice({
        userId: req.user.id,
        platform: req.body.platform,
        deviceToken: req.body.deviceToken,
        pushProvider: req.body.pushProvider || null,
        appVersion: req.body.appVersion || null,
        buildChannel: req.body.buildChannel || null,
        locale: req.body.locale || null,
        timezone: req.body.timezone || null,
        networkState: req.body.networkState || null,
      });

      res.json({
        success: true,
        device: {
          id: device.id,
          platform: device.platform,
          pushProvider: device.push_provider,
          appVersion: device.app_version,
          buildChannel: device.build_channel,
          lastSeenAt: device.last_seen_at,
        },
      });
    } catch (err) {
      logger.error({ error: err.message }, 'Failed to register mobile device');
      res.status(500).json({ error: 'Failed to register mobile device' });
    }
  }
);

/**
 * DELETE /mobile/register-device/:id — Remove a native push token registration
 */
router.delete(
  '/mobile/register-device/:id',
  requireAuth,
  [param('id').isUUID().withMessage('Invalid device registration id')],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const removed = unregisterMobileDevice({
        userId: req.user.id,
        registrationId: req.params.id,
      });

      if (!removed) {
        return res.status(404).json({ error: 'Device registration not found' });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error({ error: err.message }, 'Failed to delete mobile device');
      res.status(500).json({ error: 'Failed to delete mobile device' });
    }
  }
);

/**
 * GET /stream — SSE stream for real-time notification delivery
 *
 * EventSource cannot set HTTP headers, so the client sends the token
 * as a ?token=... query parameter. The middleware below bridges it
 * to the Authorization header before requireAuth runs.
 */
router.get('/stream', (req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}, requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  res.write('data: {"type":"connected"}\n\n');

  const userId = req.user.id;
  if (!sseClients.has(userId)) {
    sseClients.set(userId, new Set());
  }
  sseClients.get(userId).add(res);

  req.on('close', () => {
    const clients = sseClients.get(userId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(userId);
    }
  });
});

/**
 * Send a notification to a user via SSE (called from other services)
 */
export function broadcastNotification(userId, notification) {
  const clients = sseClients.get(userId);
  if (!clients) return;
  const data = JSON.stringify({ type: 'notification', data: notification });
  for (const client of clients) {
    client.write(`data: ${data}\n\n`);
  }
}

function formatNotification(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body || null,
    documentId: row.document_id || null,
    commentId: row.comment_id || null,
    actorId: row.actor_id || null,
    actorName: row.actor_name || null,
    actorAvatar: row.actor_avatar || null,
    readAt: row.read_at || null,
    createdAt: row.created_at,
  };
}

function formatPreferences(row) {
  return {
    emailComments: !!row.email_comments,
    emailMentions: !!row.email_mentions,
    emailSuggestions: !!row.email_suggestions,
    emailEdits: !!row.email_edits,
    emailShares: !!row.email_shares,
    inAppEnabled: !!row.in_app_enabled,
    digestFrequency: row.digest_frequency || 'instant',
  };
}

export default router;
