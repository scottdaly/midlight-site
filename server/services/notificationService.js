/**
 * Notification Service
 *
 * Central notification creation with preference checking and SSE broadcasting.
 */

import crypto from 'crypto';
import db from '../db/index.js';
import { logger } from '../utils/logger.js';
import { broadcastNotification } from '../routes/notifications.js';

/**
 * Create a notification for a user.
 * Checks user preferences before creating.
 * Broadcasts via SSE if user has active connections.
 *
 * @param {object} params
 * @param {number} params.userId - Recipient user ID
 * @param {string} params.type - Notification type: 'comment', 'mention', 'suggestion', 'edit', 'share', 'resolve'
 * @param {string} params.title - Notification title
 * @param {string} [params.body] - Notification body text
 * @param {string} [params.documentId] - Related document ID
 * @param {string} [params.commentId] - Related comment ID
 * @param {number} [params.actorId] - User who triggered the notification
 */
export function createNotification({ userId, type, title, body, documentId, commentId, actorId }) {
  // Don't notify yourself
  if (actorId && actorId === userId) return null;

  try {
    // Check user preferences
    const prefs = db.prepare(
      'SELECT * FROM notification_preferences WHERE user_id = ?'
    ).get(userId);

    if (prefs && !prefs.in_app_enabled) return null;

    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, body, document_id, comment_id, actor_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, type, title, body || null, documentId || null, commentId || null, actorId || null);

    // Get actor info for broadcast
    let actorName = null;
    let actorAvatar = null;
    if (actorId) {
      const actor = db.prepare('SELECT display_name, avatar_url FROM users WHERE id = ?').get(actorId);
      if (actor) {
        actorName = actor.display_name;
        actorAvatar = actor.avatar_url;
      }
    }

    const notification = {
      id, type, title,
      body: body || null,
      documentId: documentId || null,
      commentId: commentId || null,
      actorId: actorId || null,
      actorName,
      actorAvatar,
      readAt: null,
      createdAt: new Date().toISOString(),
    };

    // Broadcast via SSE
    broadcastNotification(userId, notification);

    return notification;
  } catch (err) {
    logger.error({ error: err.message, userId, type }, 'Failed to create notification');
    return null;
  }
}

/**
 * Log a document activity event.
 */
export function logActivity({ documentId, userId, eventType, metadata }) {
  try {
    db.prepare(`
      INSERT INTO document_activity (document_id, user_id, event_type, metadata)
      VALUES (?, ?, ?, ?)
    `).run(documentId, userId, eventType, metadata ? JSON.stringify(metadata) : null);
  } catch (err) {
    logger.error({ error: err.message, documentId, eventType }, 'Failed to log activity');
  }
}
