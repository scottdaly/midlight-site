import argon2 from 'argon2';
import crypto from 'crypto';
import db from '../db/index.js';

export async function hashPassword(password) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4
  });
}

export async function verifyPassword(password, hash) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function hashIP(ip) {
  return crypto.createHash('sha256').update(ip || 'unknown').digest('hex');
}

export function findUserByEmail(email) {
  const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
  return stmt.get(email.toLowerCase());
}

export function findUserById(id) {
  const stmt = db.prepare('SELECT id, email, display_name, avatar_url, email_verified, created_at FROM users WHERE id = ?');
  return stmt.get(id);
}

// Transaction wrapper for creating user with subscription
const createUserTransaction = db.transaction((email, passwordHash, displayName, avatarUrl) => {
  const stmt = db.prepare(`
    INSERT INTO users (email, password_hash, display_name, avatar_url)
    VALUES (?, ?, ?, ?)
  `);

  const result = stmt.run(
    email.toLowerCase(),
    passwordHash,
    displayName || null,
    avatarUrl || null
  );

  // Create default free subscription
  const subStmt = db.prepare(`
    INSERT INTO subscriptions (user_id, tier, status)
    VALUES (?, 'free', 'active')
  `);
  subStmt.run(result.lastInsertRowid);

  return result.lastInsertRowid;
});

export async function createUser({ email, password, displayName, avatarUrl }) {
  const passwordHash = password ? await hashPassword(password) : null;
  const userId = createUserTransaction(email, passwordHash, displayName, avatarUrl);
  return findUserById(userId);
}

// Explicit field mapping for user updates (prevents SQL injection via field names)
const USER_FIELD_MAP = {
  displayName: 'display_name',
  avatarUrl: 'avatar_url',
  emailVerified: 'email_verified',
  // Also allow snake_case input for flexibility
  display_name: 'display_name',
  avatar_url: 'avatar_url',
  email_verified: 'email_verified',
};

export function updateUser(userId, updates) {
  const setClauses = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    const dbField = USER_FIELD_MAP[key];
    if (dbField && value !== undefined) {
      setClauses.push(`${dbField} = ?`);
      values.push(value);
    }
  }

  if (setClauses.length === 0) return null;

  setClauses.push('updated_at = CURRENT_TIMESTAMP');
  values.push(userId);

  const stmt = db.prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`);
  stmt.run(...values);

  return findUserById(userId);
}

export async function updatePassword(userId, newPassword) {
  const passwordHash = await hashPassword(newPassword);
  const stmt = db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  stmt.run(passwordHash, userId);
}

export function deleteUser(userId) {
  const stmt = db.prepare('DELETE FROM users WHERE id = ?');
  return stmt.run(userId);
}

// Transaction wrapper for creating new OAuth user with subscription
const createOAuthUserTransaction = db.transaction((email, displayName, avatarUrl, provider, providerUserId, providerData) => {
  // Create new user
  const userStmt = db.prepare(`
    INSERT INTO users (email, display_name, avatar_url, email_verified)
    VALUES (?, ?, ?, 1)
  `);
  const userResult = userStmt.run(email.toLowerCase(), displayName, avatarUrl);
  const userId = userResult.lastInsertRowid;

  // Create OAuth account link
  const oauthInsertStmt = db.prepare(`
    INSERT INTO oauth_accounts (user_id, provider, provider_user_id, provider_email, provider_data)
    VALUES (?, ?, ?, ?, ?)
  `);
  oauthInsertStmt.run(
    userId,
    provider,
    providerUserId,
    email,
    JSON.stringify(providerData || {})
  );

  // Create default free subscription
  const subStmt = db.prepare(`
    INSERT INTO subscriptions (user_id, tier, status)
    VALUES (?, 'free', 'active')
  `);
  subStmt.run(userId);

  return { userId, email: email.toLowerCase(), displayName, avatarUrl };
});

export function findOrCreateOAuthUser({ provider, providerUserId, email, displayName, avatarUrl, providerData }) {
  // Check if OAuth account exists
  const oauthStmt = db.prepare(`
    SELECT oa.*, u.id as user_id, u.email, u.display_name, u.avatar_url
    FROM oauth_accounts oa
    JOIN users u ON oa.user_id = u.id
    WHERE oa.provider = ? AND oa.provider_user_id = ?
  `);
  const existingOAuth = oauthStmt.get(provider, providerUserId);

  if (existingOAuth) {
    return {
      id: existingOAuth.user_id,
      email: existingOAuth.email,
      displayName: existingOAuth.display_name,
      avatarUrl: existingOAuth.avatar_url
    };
  }

  // Check if user with email exists
  const existingUser = findUserByEmail(email);

  if (existingUser) {
    // If existing user has a password, do NOT auto-link — require them to log in with password first
    if (existingUser.password_hash) {
      return { needsLinking: true, email, provider };
    }

    // OAuth-only user — safe to link additional providers
    const linkStmt = db.prepare(`
      INSERT INTO oauth_accounts (user_id, provider, provider_user_id, provider_email, provider_data)
      VALUES (?, ?, ?, ?, ?)
    `);
    linkStmt.run(
      existingUser.id,
      provider,
      providerUserId,
      email,
      JSON.stringify(providerData || {})
    );

    return {
      id: existingUser.id,
      email: existingUser.email,
      displayName: existingUser.display_name,
      avatarUrl: existingUser.avatar_url
    };
  }

  // Create new user with OAuth account (atomic transaction)
  const result = createOAuthUserTransaction(email, displayName, avatarUrl, provider, providerUserId, providerData);
  return {
    id: result.userId,
    email: result.email,
    displayName: result.displayName,
    avatarUrl: result.avatarUrl
  };
}

export function getUserSubscription(userId) {
  const stmt = db.prepare(`
    SELECT tier, status, billing_interval, current_period_start, current_period_end, created_at
    FROM subscriptions
    WHERE user_id = ?
  `);
  return stmt.get(userId) || { tier: 'free', status: 'active', billing_interval: null };
}

// Explicit field mapping for subscription updates (prevents SQL injection via field names)
const SUBSCRIPTION_FIELD_MAP = {
  tier: 'tier',
  status: 'status',
  stripeCustomerId: 'stripe_customer_id',
  stripeSubscriptionId: 'stripe_subscription_id',
  billingInterval: 'billing_interval',
  currentPeriodStart: 'current_period_start',
  currentPeriodEnd: 'current_period_end',
  // Also allow snake_case input for flexibility
  stripe_customer_id: 'stripe_customer_id',
  stripe_subscription_id: 'stripe_subscription_id',
  billing_interval: 'billing_interval',
  current_period_start: 'current_period_start',
  current_period_end: 'current_period_end',
};

export function updateSubscription(userId, updates) {
  const setClauses = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    const dbField = SUBSCRIPTION_FIELD_MAP[key];
    if (dbField && value !== undefined) {
      setClauses.push(`${dbField} = ?`);
      values.push(value);
    }
  }

  if (setClauses.length === 0) return null;

  setClauses.push('updated_at = CURRENT_TIMESTAMP');
  values.push(userId);

  const stmt = db.prepare(`UPDATE subscriptions SET ${setClauses.join(', ')} WHERE user_id = ?`);
  return stmt.run(...values);
}
