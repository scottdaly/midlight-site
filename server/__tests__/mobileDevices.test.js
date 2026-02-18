/**
 * Mobile Device Registration Service Tests
 *
 * Run: node --test server/__tests__/mobileDevices.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

let registerMobileDevice;
let unregisterMobileDevice;
let listMobileDevicesForUser;
let markMobileDeviceDeliveryFailure;
let countStaleMobileDevices;
let pruneStaleMobileDevices;

function createTestDB() {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL
    );

    CREATE TABLE mobile_notification_devices (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      device_token TEXT NOT NULL,
      push_provider TEXT,
      app_version TEXT,
      build_channel TEXT,
      locale TEXT,
      timezone TEXT,
      network_state TEXT,
      delivery_failures INTEGER NOT NULL DEFAULT 0,
      last_delivery_error TEXT,
      last_delivery_error_at DATETIME,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, platform, device_token)
    );
  `);

  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(1, 'test@example.com');

  return db;
}

describe('mobile push registration', () => {
  let db;

  beforeEach(async () => {
    if (!registerMobileDevice || !unregisterMobileDevice || !listMobileDevicesForUser || !markMobileDeviceDeliveryFailure || !countStaleMobileDevices || !pruneStaleMobileDevices) {
      process.env.DB_PATH = ':memory:';
      const service = await import('../services/mobileDeviceService.js');
      registerMobileDevice = service.registerMobileDevice;
      unregisterMobileDevice = service.unregisterMobileDevice;
      listMobileDevicesForUser = service.listMobileDevicesForUser;
      markMobileDeviceDeliveryFailure = service.markMobileDeviceDeliveryFailure;
      countStaleMobileDevices = service.countStaleMobileDevices;
      pruneStaleMobileDevices = service.pruneStaleMobileDevices;
    }
    db = createTestDB();
  });

  it('creates a new device registration', () => {
    const device = registerMobileDevice({
      database: db,
      userId: 1,
      platform: 'ios',
      deviceToken: 'token-1',
      pushProvider: 'apns',
      appVersion: '1.0.0',
      buildChannel: 'beta',
    });

    assert.equal(device.platform, 'ios');
    assert.equal(device.push_provider, 'apns');

    const count = db.prepare('SELECT COUNT(*) AS count FROM mobile_notification_devices').get();
    assert.equal(count.count, 1);
  });

  it('upserts an existing registration for same user/platform/token', () => {
    const first = registerMobileDevice({
      database: db,
      userId: 1,
      platform: 'android',
      deviceToken: 'token-2',
      pushProvider: 'fcm',
      appVersion: '1.0.0',
      buildChannel: 'internal',
    });

    const second = registerMobileDevice({
      database: db,
      userId: 1,
      platform: 'android',
      deviceToken: 'token-2',
      pushProvider: 'fcm',
      appVersion: '1.1.0',
      buildChannel: 'production',
    });

    assert.equal(first.id, second.id);

    const row = db.prepare('SELECT app_version, build_channel FROM mobile_notification_devices WHERE id = ?').get(first.id);
    assert.deepEqual(row, {
      app_version: '1.1.0',
      build_channel: 'production',
    });
  });

  it('deletes only matching user registration', () => {
    const device = registerMobileDevice({
      database: db,
      userId: 1,
      platform: 'ios',
      deviceToken: 'token-3',
    });

    const removed = unregisterMobileDevice({ database: db, userId: 1, registrationId: device.id });
    assert.equal(removed, true);

    const missing = unregisterMobileDevice({ database: db, userId: 1, registrationId: device.id });
    assert.equal(missing, false);
  });

  it('lists device registrations for a user ordered by recency', () => {
    const first = registerMobileDevice({
      database: db,
      userId: 1,
      platform: 'ios',
      deviceToken: 'token-list-1',
      appVersion: '1.0.0',
    });

    db.prepare("UPDATE mobile_notification_devices SET last_seen_at = datetime('now', '-2 days') WHERE id = ?").run(first.id);

    registerMobileDevice({
      database: db,
      userId: 1,
      platform: 'android',
      deviceToken: 'token-list-2',
      appVersion: '1.1.0',
    });

    const devices = listMobileDevicesForUser({ database: db, userId: 1 });
    assert.equal(devices.length, 2);
    assert.equal(devices[0].platform, 'android');
    assert.equal(devices[1].platform, 'ios');
  });

  it('removes invalid token registrations on delivery failure', () => {
    const device = registerMobileDevice({
      database: db,
      userId: 1,
      platform: 'ios',
      deviceToken: 'token-invalid',
      pushProvider: 'apns',
    });

    const result = markMobileDeviceDeliveryFailure({
      database: db,
      registrationId: device.id,
      reason: 'Unregistered device token',
    });

    assert.equal(result.found, true);
    assert.equal(result.removed, true);
    assert.equal(result.removalReason, 'invalid_token');

    const count = db.prepare('SELECT COUNT(*) AS count FROM mobile_notification_devices WHERE id = ?').get(device.id);
    assert.equal(count.count, 0);
  });

  it('evicts registrations after repeated delivery failures', () => {
    const device = registerMobileDevice({
      database: db,
      userId: 1,
      platform: 'android',
      deviceToken: 'token-failures',
      pushProvider: 'fcm',
    });

    const first = markMobileDeviceDeliveryFailure({
      database: db,
      registrationId: device.id,
      reason: 'Temporary provider outage',
      failureEvictionThreshold: 3,
    });

    assert.equal(first.removed, false);
    assert.equal(first.failures, 1);

    markMobileDeviceDeliveryFailure({
      database: db,
      registrationId: device.id,
      reason: 'Temporary provider outage',
      failureEvictionThreshold: 3,
    });

    const finalAttempt = markMobileDeviceDeliveryFailure({
      database: db,
      registrationId: device.id,
      reason: 'Temporary provider outage',
      failureEvictionThreshold: 3,
    });

    assert.equal(finalAttempt.removed, true);
    assert.equal(finalAttempt.removalReason, 'failure_threshold');
  });

  it('prunes stale device registrations', () => {
    const stale = registerMobileDevice({
      database: db,
      userId: 1,
      platform: 'ios',
      deviceToken: 'token-stale',
    });
    const fresh = registerMobileDevice({
      database: db,
      userId: 1,
      platform: 'android',
      deviceToken: 'token-fresh',
    });

    db.prepare("UPDATE mobile_notification_devices SET last_seen_at = datetime('now', '-95 days') WHERE id = ?").run(stale.id);
    db.prepare("UPDATE mobile_notification_devices SET last_seen_at = datetime('now', '-5 days') WHERE id = ?").run(fresh.id);

    const staleCount = countStaleMobileDevices({ database: db, staleDays: 60 });
    assert.equal(staleCount, 1);

    const deleted = pruneStaleMobileDevices({ database: db, staleDays: 60 });
    assert.equal(deleted, 1);

    const remaining = listMobileDevicesForUser({ database: db, userId: 1 });
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, fresh.id);
  });
});
