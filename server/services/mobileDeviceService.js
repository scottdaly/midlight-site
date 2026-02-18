import crypto from 'crypto';
import db from '../db/index.js';

const DEFAULT_FAILURE_EVICTION_THRESHOLD = 5;
const INVALID_TOKEN_REASON_PATTERNS = [
  'invalid',
  'unregistered',
  'notregistered',
  'baddevice',
  'bad_device',
  'mismatchsenderid',
  'tokenexpired',
];

export function registerMobileDevice({
  database = db,
  userId,
  platform,
  deviceToken,
  pushProvider = null,
  appVersion = null,
  buildChannel = null,
  locale = null,
  timezone = null,
  networkState = null,
}) {
  const existing = database.prepare(
    'SELECT id FROM mobile_notification_devices WHERE user_id = ? AND platform = ? AND device_token = ?'
  ).get(userId, platform, deviceToken);

  if (existing) {
    database.prepare(`
      UPDATE mobile_notification_devices
      SET push_provider = ?,
          app_version = ?,
          build_channel = ?,
          locale = ?,
          timezone = ?,
          network_state = ?,
          delivery_failures = 0,
          last_delivery_error = NULL,
          last_delivery_error_at = NULL,
          last_seen_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      pushProvider,
      appVersion,
      buildChannel,
      locale,
      timezone,
      networkState,
      existing.id,
    );

    return database.prepare(
      'SELECT * FROM mobile_notification_devices WHERE id = ?'
    ).get(existing.id);
  }

  const id = crypto.randomUUID();
  database.prepare(`
    INSERT INTO mobile_notification_devices (
      id,
      user_id,
      platform,
      device_token,
      push_provider,
      app_version,
      build_channel,
      locale,
      timezone,
      network_state,
      delivery_failures,
      last_delivery_error,
      last_delivery_error_at,
      created_at,
      updated_at,
      last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, datetime('now'), datetime('now'), datetime('now'))
  `).run(
    id,
    userId,
    platform,
    deviceToken,
    pushProvider,
    appVersion,
    buildChannel,
    locale,
    timezone,
    networkState,
  );

  return database.prepare('SELECT * FROM mobile_notification_devices WHERE id = ?').get(id);
}

export function unregisterMobileDevice({ database = db, userId, registrationId }) {
  const result = database
    .prepare('DELETE FROM mobile_notification_devices WHERE id = ? AND user_id = ?')
    .run(registrationId, userId);

  return result.changes > 0;
}

export function listMobileDevicesForUser({ database = db, userId }) {
  return database.prepare(`
    SELECT
      id,
      platform,
      push_provider AS pushProvider,
      app_version AS appVersion,
      build_channel AS buildChannel,
      locale,
      timezone,
      network_state AS networkState,
      delivery_failures AS deliveryFailures,
      last_delivery_error AS lastDeliveryError,
      last_delivery_error_at AS lastDeliveryErrorAt,
      last_seen_at AS lastSeenAt
    FROM mobile_notification_devices
    WHERE user_id = ?
    ORDER BY datetime(last_seen_at) DESC, datetime(updated_at) DESC
  `).all(userId);
}

export function markMobileDeviceDeliveryFailure({
  database = db,
  registrationId,
  reason = null,
  invalidToken = false,
  failureEvictionThreshold = DEFAULT_FAILURE_EVICTION_THRESHOLD,
}) {
  const existing = database.prepare(`
    SELECT id, delivery_failures
    FROM mobile_notification_devices
    WHERE id = ?
  `).get(registrationId);

  if (!existing) {
    return { found: false, removed: false, failures: 0 };
  }

  const normalizedReason = String(reason || '').toLowerCase();
  const isInvalidToken =
    invalidToken ||
    INVALID_TOKEN_REASON_PATTERNS.some((pattern) => normalizedReason.includes(pattern));

  const nextFailures = Number(existing.delivery_failures || 0) + 1;
  const shouldRemove = isInvalidToken || nextFailures >= failureEvictionThreshold;

  if (shouldRemove) {
    database.prepare('DELETE FROM mobile_notification_devices WHERE id = ?').run(registrationId);
    return {
      found: true,
      removed: true,
      failures: nextFailures,
      removalReason: isInvalidToken ? 'invalid_token' : 'failure_threshold',
    };
  }

  database.prepare(`
    UPDATE mobile_notification_devices
    SET delivery_failures = ?,
        last_delivery_error = ?,
        last_delivery_error_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(nextFailures, reason, registrationId);

  return {
    found: true,
    removed: false,
    failures: nextFailures,
    removalReason: null,
  };
}

export function pruneStaleMobileDevices({
  database = db,
  staleDays = 60,
}) {
  const safeDays = normalizeStaleDays(staleDays);
  const result = database.prepare(`
    DELETE FROM mobile_notification_devices
    WHERE datetime(last_seen_at) < datetime('now', ?)
  `).run(`-${safeDays} days`);

  return result.changes;
}

export function countStaleMobileDevices({
  database = db,
  staleDays = 60,
}) {
  const safeDays = normalizeStaleDays(staleDays);
  const row = database.prepare(`
    SELECT COUNT(*) AS count
    FROM mobile_notification_devices
    WHERE datetime(last_seen_at) < datetime('now', ?)
  `).get(`-${safeDays} days`);

  return Number(row?.count || 0);
}

function normalizeStaleDays(staleDays) {
  return Math.max(1, Number(staleDays) || 60);
}
