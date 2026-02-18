/**
 * Mobile Billing Service Tests
 *
 * Run: node --test server/__tests__/mobileBilling.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

let verifyAppleMobileSubscription;
let verifyGoogleMobileSubscription;

function createTestDB() {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL
    );

    CREATE TABLE subscriptions (
      user_id INTEGER PRIMARY KEY,
      tier TEXT NOT NULL DEFAULT 'free',
      status TEXT NOT NULL DEFAULT 'active',
      billing_interval TEXT,
      current_period_start DATETIME,
      current_period_end DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE mobile_subscription_receipts (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_transaction_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      app_account_token TEXT,
      environment TEXT NOT NULL DEFAULT 'production',
      expires_at DATETIME,
      is_active INTEGER NOT NULL DEFAULT 0,
      raw_payload TEXT,
      validated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, provider_transaction_id)
    );

    CREATE TABLE billing_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stripe_event_id TEXT UNIQUE NOT NULL,
      event_type TEXT NOT NULL,
      user_id INTEGER,
      stripe_customer_id TEXT,
      data_summary TEXT,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(1, 'test@example.com');
  db.prepare("INSERT INTO subscriptions (user_id, tier, status) VALUES (1, 'free', 'active')").run();

  return db;
}

describe('mobile billing verification', () => {
  let db;

  beforeEach(async () => {
    if (!verifyAppleMobileSubscription || !verifyGoogleMobileSubscription) {
      process.env.DB_PATH = ':memory:';
      const service = await import('../services/mobileBillingService.js');
      verifyAppleMobileSubscription = service.verifyAppleMobileSubscription;
      verifyGoogleMobileSubscription = service.verifyGoogleMobileSubscription;
    }
    db = createTestDB();
  });

  it('verifies Apple payload and upgrades entitlement', async () => {
    const result = await verifyAppleMobileSubscription({
      database: db,
      userId: 1,
      body: {
        productId: 'midlight_pro_monthly',
        transactionId: 'txn-apple-1',
        environment: 'sandbox',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    });

    assert.equal(result.provider, 'apple');
    assert.equal(result.tier, 'pro');
    assert.equal(result.status, 'active');

    const subscription = db.prepare('SELECT tier, status, billing_interval FROM subscriptions WHERE user_id = 1').get();
    assert.deepEqual(subscription, {
      tier: 'pro',
      status: 'active',
      billing_interval: 'monthly',
    });

    const receiptCount = db.prepare('SELECT COUNT(*) AS count FROM mobile_subscription_receipts').get();
    assert.equal(receiptCount.count, 1);
  });

  it('verifies Google payload and expires entitlement when expired date is in past', async () => {
    const result = await verifyGoogleMobileSubscription({
      database: db,
      userId: 1,
      body: {
        productId: 'midlight_premium_yearly',
        purchaseToken: 'google-token-1',
        packageName: 'ai.midlight.mobile',
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
    });

    assert.equal(result.provider, 'google');
    assert.equal(result.tier, 'free');
    assert.equal(result.status, 'expired');

    const subscription = db.prepare('SELECT tier, status, billing_interval FROM subscriptions WHERE user_id = 1').get();
    assert.deepEqual(subscription, {
      tier: 'free',
      status: 'expired',
      billing_interval: null,
    });
  });

  it('upserts existing mobile receipt by provider transaction id', async () => {
    await verifyAppleMobileSubscription({
      database: db,
      userId: 1,
      body: {
        productId: 'midlight_pro_monthly',
        transactionId: 'txn-apple-2',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    });

    await verifyAppleMobileSubscription({
      database: db,
      userId: 1,
      body: {
        productId: 'midlight_premium_yearly',
        transactionId: 'txn-apple-2',
        expiresAt: '2099-02-01T00:00:00.000Z',
      },
    });

    const receiptCount = db.prepare('SELECT COUNT(*) AS count FROM mobile_subscription_receipts').get();
    assert.equal(receiptCount.count, 1);

    const receipt = db.prepare('SELECT product_id FROM mobile_subscription_receipts').get();
    assert.equal(receipt.product_id, 'midlight_premium_yearly');
  });

  it('honors provider verifier output when strict verification is enabled', async () => {
    const result = await verifyGoogleMobileSubscription({
      database: db,
      userId: 1,
      body: {
        productId: 'midlight_premium_yearly',
        purchaseToken: 'google-token-verified',
        packageName: 'ai.midlight.mobile',
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
      options: {
        allowUnverified: false,
        googleVerifier: async () => ({
          providerTransactionId: 'order-123',
          productId: 'midlight_pro_monthly',
          expiresAt: '2099-01-01T00:00:00.000Z',
          environment: 'production',
          verificationSource: 'provider',
        }),
      },
    });

    assert.equal(result.provider, 'google');
    assert.equal(result.tier, 'pro');
    assert.equal(result.status, 'active');
    assert.equal(result.verificationSource, 'provider');

    const subscription = db.prepare('SELECT tier, status, billing_interval FROM subscriptions WHERE user_id = 1').get();
    assert.deepEqual(subscription, {
      tier: 'pro',
      status: 'active',
      billing_interval: 'monthly',
    });
  });

  it('rejects verification when strict mode is enabled and provider validation fails', async () => {
    await assert.rejects(
      verifyGoogleMobileSubscription({
        database: db,
        userId: 1,
        body: {
          productId: 'midlight_pro_monthly',
          purchaseToken: 'google-token-invalid',
          packageName: 'ai.midlight.mobile',
        },
        options: {
          allowUnverified: false,
          googleVerifier: async () => {
            throw new Error('google verification denied');
          },
        },
      }),
      /google verification denied/,
    );

    const receiptCount = db.prepare('SELECT COUNT(*) AS count FROM mobile_subscription_receipts').get();
    assert.equal(receiptCount.count, 0);
  });
});
