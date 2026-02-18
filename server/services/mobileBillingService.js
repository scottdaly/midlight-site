import crypto from 'crypto';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import db from '../db/index.js';

const MOBILE_PROVIDER = {
  APPLE: 'apple',
  GOOGLE: 'google',
};

const GOOGLE_ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const GOOGLE_OAUTH_AUDIENCE = 'https://oauth2.googleapis.com/token';
const APPLE_API_PRODUCTION = 'https://api.storekit.itunes.apple.com';
const APPLE_API_SANDBOX = 'https://api.storekit-sandbox.itunes.apple.com';

let googleAccessTokenCache = {
  token: null,
  expiresAtMs: 0,
};

class MobileBillingVerificationError extends Error {
  constructor(message, status = 400, code = 'mobile_billing_verification_failed') {
    super(message);
    this.name = 'MobileBillingVerificationError';
    this.status = status;
    this.code = code;
  }
}

function normalizeDate(input) {
  if (!input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeProviderDate(input) {
  if (input == null) return null;

  if (typeof input === 'number') {
    return normalizeDate(new Date(input).toISOString());
  }

  if (typeof input === 'string') {
    const numeric = Number(input);
    if (!Number.isNaN(numeric) && input.trim() !== '') {
      return normalizeDate(new Date(numeric).toISOString());
    }
    return normalizeDate(input);
  }

  return null;
}

function deriveTier(productId = '') {
  const normalized = productId.toLowerCase();
  if (normalized.includes('premium')) return 'premium';
  if (normalized.includes('pro')) return 'pro';
  return 'free';
}

function deriveBillingInterval(productId = '') {
  const normalized = productId.toLowerCase();
  if (normalized.includes('year')) return 'yearly';
  return 'monthly';
}

function computeEntitlement(productId, expiresAt) {
  const tier = deriveTier(productId);
  if (tier === 'free') {
    return { tier: 'free', status: 'active', billingInterval: null };
  }

  if (expiresAt && new Date(expiresAt) <= new Date()) {
    return { tier: 'free', status: 'expired', billingInterval: null };
  }

  return {
    tier,
    status: 'active',
    billingInterval: deriveBillingInterval(productId),
  };
}

function updateSubscriptionForMobile(database, userId, entitlement, expiresAt) {
  const existing = database
    .prepare('SELECT user_id FROM subscriptions WHERE user_id = ?')
    .get(userId);

  if (!existing) {
    database
      .prepare(`
        INSERT INTO subscriptions (
          user_id,
          tier,
          status,
          billing_interval,
          current_period_start,
          current_period_end,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, datetime('now'), ?, datetime('now'), datetime('now'))
      `)
      .run(userId, entitlement.tier, entitlement.status, entitlement.billingInterval, expiresAt);
    return;
  }

  database
    .prepare(`
      UPDATE subscriptions
      SET tier = ?,
          status = ?,
          billing_interval = ?,
          current_period_end = ?,
          updated_at = datetime('now')
      WHERE user_id = ?
    `)
    .run(entitlement.tier, entitlement.status, entitlement.billingInterval, expiresAt, userId);
}

function upsertMobileReceipt(database, payload) {
  const existing = database.prepare(
    'SELECT id FROM mobile_subscription_receipts WHERE provider = ? AND provider_transaction_id = ?'
  ).get(payload.provider, payload.providerTransactionId);

  const receiptPayload = JSON.stringify(payload.rawPayload || {});

  if (existing) {
    database.prepare(`
      UPDATE mobile_subscription_receipts
      SET user_id = ?,
          product_id = ?,
          app_account_token = ?,
          environment = ?,
          expires_at = ?,
          is_active = ?,
          raw_payload = ?,
          updated_at = datetime('now'),
          validated_at = datetime('now')
      WHERE id = ?
    `).run(
      payload.userId,
      payload.productId,
      payload.appAccountToken,
      payload.environment,
      payload.expiresAt,
      payload.isActive ? 1 : 0,
      receiptPayload,
      existing.id,
    );

    return existing.id;
  }

  const id = crypto.randomUUID();
  database.prepare(`
    INSERT INTO mobile_subscription_receipts (
      id,
      user_id,
      provider,
      provider_transaction_id,
      product_id,
      app_account_token,
      environment,
      expires_at,
      is_active,
      raw_payload,
      created_at,
      updated_at,
      validated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
  `).run(
    id,
    payload.userId,
    payload.provider,
    payload.providerTransactionId,
    payload.productId,
    payload.appAccountToken,
    payload.environment,
    payload.expiresAt,
    payload.isActive ? 1 : 0,
    receiptPayload,
  );

  return id;
}

function writeBillingEvent(database, eventType, userId, summary) {
  database.prepare(`
    INSERT INTO billing_events (
      stripe_event_id,
      event_type,
      user_id,
      stripe_customer_id,
      data_summary,
      processed_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(
    `mobile_${eventType}_${crypto.randomUUID()}`,
    eventType,
    userId,
    null,
    summary,
  );
}

function allowUnverifiedFallback(options = {}) {
  if (typeof options.allowUnverified === 'boolean') {
    return options.allowUnverified;
  }

  if (process.env.MOBILE_BILLING_ALLOW_UNVERIFIED != null) {
    return process.env.MOBILE_BILLING_ALLOW_UNVERIFIED === 'true';
  }

  return process.env.NODE_ENV !== 'production';
}

function decodeJWSPayload(signedPayload) {
  const parts = String(signedPayload || '').split('.');
  if (parts.length < 2) {
    throw new MobileBillingVerificationError('Invalid signed payload from provider', 502, 'invalid_provider_payload');
  }

  const decoded = Buffer.from(parts[1], 'base64url').toString('utf8');
  return JSON.parse(decoded);
}

function resolveApplePrivateKey() {
  if (process.env.APPLE_APP_STORE_PRIVATE_KEY) {
    return process.env.APPLE_APP_STORE_PRIVATE_KEY.replace(/\\n/g, '\n');
  }

  if (process.env.APPLE_APP_STORE_PRIVATE_KEY_PATH) {
    return fs.readFileSync(process.env.APPLE_APP_STORE_PRIVATE_KEY_PATH, 'utf8');
  }

  return null;
}

function buildAppleJwt() {
  const issuerId = process.env.APPLE_APP_STORE_ISSUER_ID;
  const keyId = process.env.APPLE_APP_STORE_KEY_ID;
  const privateKey = resolveApplePrivateKey();

  if (!issuerId || !keyId || !privateKey) {
    throw new MobileBillingVerificationError(
      'Apple App Store credentials are not configured',
      503,
      'apple_credentials_missing'
    );
  }

  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: issuerId,
      iat: now,
      exp: now + 60 * 5,
      aud: 'appstoreconnect-v1',
    },
    privateKey,
    {
      algorithm: 'ES256',
      header: {
        alg: 'ES256',
        kid: keyId,
        typ: 'JWT',
      },
    },
  );
}

function resolveAppleEnvironments(preferred = 'production') {
  if (preferred === 'sandbox') {
    return ['sandbox', 'production'];
  }
  return ['production', 'sandbox'];
}

async function fetchAppleTransactionFromApi({ body, fetchFn = fetch }) {
  const providedTransactionId = body.transactionId || body.originalTransactionId;
  if (!providedTransactionId) {
    throw new MobileBillingVerificationError('transactionId or originalTransactionId is required', 400, 'missing_transaction_id');
  }

  const authToken = buildAppleJwt();
  const environments = resolveAppleEnvironments(body.environment || 'production');

  let lastError = null;

  for (const environment of environments) {
    const baseUrl = environment === 'sandbox' ? APPLE_API_SANDBOX : APPLE_API_PRODUCTION;
    const url = `${baseUrl}/inApps/v1/transactions/${encodeURIComponent(providedTransactionId)}`;

    try {
      const response = await fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: 'application/json',
        },
      });

      if (response.status === 404) {
        lastError = new MobileBillingVerificationError('Apple transaction not found', 400, 'apple_transaction_not_found');
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new MobileBillingVerificationError(
          `Apple verification failed (${response.status}): ${text || 'unknown error'}`,
          response.status >= 500 ? 502 : 400,
          'apple_verification_failed'
        );
      }

      const payload = await response.json();
      const signedTransactionInfo = payload.signedTransactionInfo;
      if (!signedTransactionInfo) {
        throw new MobileBillingVerificationError('Apple verification payload missing signedTransactionInfo', 502, 'apple_payload_missing_fields');
      }

      const transaction = decodeJWSPayload(signedTransactionInfo);
      const productId = transaction.productId || body.productId;

      if (!productId) {
        throw new MobileBillingVerificationError('Apple transaction did not include productId', 502, 'apple_missing_product_id');
      }

      if (body.productId && body.productId !== productId) {
        throw new MobileBillingVerificationError('Apple transaction product mismatch', 400, 'apple_product_mismatch');
      }

      const expectedBundleId = process.env.APPLE_APP_BUNDLE_ID;
      if (expectedBundleId && transaction.bundleId && transaction.bundleId !== expectedBundleId) {
        throw new MobileBillingVerificationError('Apple bundleId mismatch', 400, 'apple_bundle_id_mismatch');
      }

      const providerTransactionId = String(transaction.originalTransactionId || transaction.transactionId || providedTransactionId);
      const expiresAt = normalizeProviderDate(transaction.expiresDate || transaction.expiresAt);

      return {
        providerTransactionId,
        productId,
        expiresAt,
        environment,
        verificationSource: 'provider',
        providerPayload: {
          signedTransactionInfo,
          transaction,
        },
      };
    } catch (error) {
      if (error instanceof MobileBillingVerificationError) {
        lastError = error;
        continue;
      }

      lastError = new MobileBillingVerificationError(
        `Apple verification request failed: ${error?.message || String(error)}`,
        502,
        'apple_verification_request_failed'
      );
    }
  }

  throw lastError || new MobileBillingVerificationError('Apple verification failed', 502, 'apple_verification_failed');
}

function resolveGoogleServiceAccount() {
  if (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
  }

  if (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH) {
    const raw = fs.readFileSync(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_PATH, 'utf8');
    return JSON.parse(raw);
  }

  throw new MobileBillingVerificationError(
    'Google Play service account credentials are not configured',
    503,
    'google_credentials_missing'
  );
}

async function fetchGoogleAccessToken(fetchFn = fetch) {
  if (googleAccessTokenCache.token && Date.now() < googleAccessTokenCache.expiresAtMs - 60_000) {
    return googleAccessTokenCache.token;
  }

  const serviceAccount = resolveGoogleServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const privateKey = String(serviceAccount.private_key || '').replace(/\\n/g, '\n');

  if (!serviceAccount.client_email || !privateKey) {
    throw new MobileBillingVerificationError(
      'Google Play credentials are missing client_email/private_key',
      503,
      'google_credentials_invalid'
    );
  }

  const assertion = jwt.sign(
    {
      iss: serviceAccount.client_email,
      scope: GOOGLE_ANDROID_PUBLISHER_SCOPE,
      aud: GOOGLE_OAUTH_AUDIENCE,
      iat: now,
      exp: now + 60 * 60,
    },
    privateKey,
    { algorithm: 'RS256' },
  );

  const response = await fetchFn(GOOGLE_OAUTH_AUDIENCE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new MobileBillingVerificationError(
      `Google OAuth token request failed (${response.status}): ${text || 'unknown error'}`,
      502,
      'google_oauth_failed'
    );
  }

  const tokenPayload = await response.json();
  const accessToken = tokenPayload.access_token;
  const expiresIn = Number(tokenPayload.expires_in || 3600);

  if (!accessToken) {
    throw new MobileBillingVerificationError('Google OAuth response missing access_token', 502, 'google_oauth_missing_token');
  }

  googleAccessTokenCache = {
    token: accessToken,
    expiresAtMs: Date.now() + expiresIn * 1000,
  };

  return accessToken;
}

function deriveGoogleSubscriptionStatus(state = '') {
  const normalized = String(state || '').toUpperCase();
  if (normalized === 'SUBSCRIPTION_STATE_ACTIVE') return 'active';
  if (normalized === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD') return 'active';
  if (normalized === 'SUBSCRIPTION_STATE_ON_HOLD') return 'active';
  if (normalized === 'SUBSCRIPTION_STATE_PAUSED') return 'expired';
  if (normalized === 'SUBSCRIPTION_STATE_EXPIRED') return 'expired';
  if (normalized === 'SUBSCRIPTION_STATE_CANCELED') return 'expired';
  return 'active';
}

async function fetchGoogleSubscriptionFromApi({ body, fetchFn = fetch }) {
  if (!body.purchaseToken || !body.packageName || !body.productId) {
    throw new MobileBillingVerificationError(
      'Google verification requires purchaseToken, packageName, and productId',
      400,
      'google_missing_fields'
    );
  }

  const expectedPackageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;
  if (expectedPackageName && body.packageName !== expectedPackageName) {
    throw new MobileBillingVerificationError('Google packageName mismatch', 400, 'google_package_name_mismatch');
  }

  const accessToken = await fetchGoogleAccessToken(fetchFn);
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(body.packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(body.purchaseToken)}`;
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (response.status === 404) {
    throw new MobileBillingVerificationError('Google purchase token not found', 400, 'google_purchase_not_found');
  }

  if (!response.ok) {
    const text = await response.text();
    throw new MobileBillingVerificationError(
      `Google verification failed (${response.status}): ${text || 'unknown error'}`,
      response.status >= 500 ? 502 : 400,
      'google_verification_failed'
    );
  }

  const purchase = await response.json();
  const lineItems = Array.isArray(purchase.lineItems) ? purchase.lineItems : [];
  const matchedLineItem = lineItems.find((item) => item.productId === body.productId) || lineItems[0];

  if (!matchedLineItem) {
    throw new MobileBillingVerificationError('Google purchase payload missing lineItems', 502, 'google_payload_missing_line_items');
  }

  if (matchedLineItem.productId !== body.productId) {
    throw new MobileBillingVerificationError('Google purchase product mismatch', 400, 'google_product_mismatch');
  }

  const expiresAt = normalizeProviderDate(matchedLineItem.expiryTime);
  const status = deriveGoogleSubscriptionStatus(purchase.subscriptionState);

  return {
    providerTransactionId: String(purchase.latestOrderId || body.purchaseToken),
    productId: matchedLineItem.productId,
    expiresAt,
    environment: body.environment || 'production',
    verificationSource: 'provider',
    providerStatus: status,
    providerPayload: purchase,
  };
}

function fallbackVerification(provider, body, reason = null) {
  const providerTransactionId = provider === MOBILE_PROVIDER.APPLE
    ? (body.originalTransactionId || body.transactionId)
    : body.purchaseToken;

  return {
    providerTransactionId,
    productId: body.productId,
    expiresAt: normalizeDate(body.expiresAt),
    environment: body.environment || 'production',
    verificationSource: 'client_payload',
    fallbackReason: reason,
    providerPayload: null,
  };
}

function ensureFallbackFields(provider, body, fallback) {
  if (!fallback.providerTransactionId) {
    throw new MobileBillingVerificationError(
      provider === MOBILE_PROVIDER.APPLE
        ? 'transactionId or originalTransactionId is required'
        : 'purchaseToken is required',
      400,
      'mobile_billing_missing_transaction'
    );
  }

  if (!fallback.productId) {
    throw new MobileBillingVerificationError('productId is required', 400, 'mobile_billing_missing_product');
  }

  return fallback;
}

async function resolveVerification(provider, body, options = {}) {
  if (provider === MOBILE_PROVIDER.APPLE) {
    if (options.appleVerifier) {
      return options.appleVerifier({ body });
    }
    return fetchAppleTransactionFromApi({ body, fetchFn: options.fetchFn || fetch });
  }

  if (options.googleVerifier) {
    return options.googleVerifier({ body });
  }
  return fetchGoogleSubscriptionFromApi({ body, fetchFn: options.fetchFn || fetch });
}

async function verifyMobilePurchase({ database = db, provider, userId, body, options = {} }) {
  const useFallback = allowUnverifiedFallback(options);

  let verification;
  try {
    verification = await resolveVerification(provider, body, options);
  } catch (error) {
    if (!useFallback) {
      if (error instanceof MobileBillingVerificationError) {
        throw error;
      }
      throw new MobileBillingVerificationError(
        error?.message || 'Provider verification failed',
        502,
        'provider_verification_failed'
      );
    }

    verification = ensureFallbackFields(
      provider,
      body,
      fallbackVerification(provider, body, error?.message || String(error)),
    );
  }

  const normalized = ensureFallbackFields(provider, body, {
    ...verification,
    providerTransactionId: verification.providerTransactionId,
    productId: verification.productId,
    expiresAt: normalizeDate(verification.expiresAt),
    environment: verification.environment || body.environment || 'production',
    verificationSource: verification.verificationSource || 'provider',
  });

  const entitlement = computeEntitlement(normalized.productId, normalized.expiresAt);
  if (normalized.providerStatus === 'expired') {
    entitlement.tier = 'free';
    entitlement.status = 'expired';
    entitlement.billingInterval = null;
  }

  const receiptId = database.transaction(() => {
    const id = upsertMobileReceipt(database, {
      provider,
      providerTransactionId: normalized.providerTransactionId,
      productId: normalized.productId,
      appAccountToken: body.appAccountToken || null,
      userId,
      environment: normalized.environment,
      expiresAt: normalized.expiresAt,
      isActive: entitlement.status === 'active',
      rawPayload: {
        verificationSource: normalized.verificationSource,
        fallbackReason: normalized.fallbackReason || null,
        clientPayload: body,
        providerPayload: normalized.providerPayload,
      },
    });

    updateSubscriptionForMobile(database, userId, entitlement, normalized.expiresAt);

    writeBillingEvent(
      database,
      `mobile_${provider}_verify`,
      userId,
      JSON.stringify({
        provider,
        providerTransactionId: normalized.providerTransactionId,
        productId: normalized.productId,
        status: entitlement.status,
        verificationSource: normalized.verificationSource,
      }),
    );

    return id;
  })();

  return {
    receiptId,
    provider,
    tier: entitlement.tier,
    status: entitlement.status,
    billingInterval: entitlement.billingInterval,
    expiresAt: normalized.expiresAt,
    environment: normalized.environment,
    verificationSource: normalized.verificationSource,
  };
}

export async function verifyAppleMobileSubscription({ database = db, userId, body, options = {} }) {
  return verifyMobilePurchase({
    database,
    provider: MOBILE_PROVIDER.APPLE,
    userId,
    body,
    options,
  });
}

export async function verifyGoogleMobileSubscription({ database = db, userId, body, options = {} }) {
  return verifyMobilePurchase({
    database,
    provider: MOBILE_PROVIDER.GOOGLE,
    userId,
    body,
    options,
  });
}

export const __private = {
  MobileBillingVerificationError,
  normalizeDate,
  normalizeProviderDate,
  deriveTier,
  deriveBillingInterval,
  computeEntitlement,
  deriveGoogleSubscriptionStatus,
};
