-- Error Reports (existing)
CREATE TABLE IF NOT EXISTS error_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  error_type TEXT NOT NULL,
  message TEXT,
  app_version TEXT,
  platform TEXT,
  arch TEXT,
  os_version TEXT,
  context TEXT,
  session_id TEXT,
  ip_hash TEXT,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_error_reports_category ON error_reports(category);
CREATE INDEX IF NOT EXISTS idx_error_reports_received_at ON error_reports(received_at);
CREATE INDEX IF NOT EXISTS idx_error_reports_app_version ON error_reports(app_version);

-- Link reports to aggregated issues (added via migration)
-- ALTER TABLE error_reports ADD COLUMN issue_id INTEGER REFERENCES error_issues(id);
CREATE INDEX IF NOT EXISTS idx_error_reports_issue ON error_reports(issue_id);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,                    -- NULL for OAuth-only users
  display_name TEXT,
  avatar_url TEXT,
  email_verified INTEGER DEFAULT 0,
  stripe_customer_id TEXT,               -- Stripe customer ID for billing
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- OAuth Accounts (supports multiple providers per user)
CREATE TABLE IF NOT EXISTS oauth_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,                -- 'google', 'github'
  provider_user_id TEXT NOT NULL,
  provider_email TEXT,
  provider_data TEXT,                    -- JSON string for profile info
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user ON oauth_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_provider ON oauth_accounts(provider, provider_user_id);

-- Subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',     -- 'free', 'premium'
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'cancelled', 'expired', 'past_due', 'trialing'
  stripe_subscription_id TEXT,
  billing_interval TEXT,                 -- 'monthly', 'yearly'
  current_period_start DATETIME,
  current_period_end DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_users_stripe ON users(stripe_customer_id);

-- LLM Usage Tracking
CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,                -- 'openai', 'anthropic'
  model TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  request_type TEXT,                     -- 'chat', 'inline_edit', 'agent'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_user ON llm_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_user_month ON llm_usage(user_id, created_at);

-- Monthly Usage Rollup (for faster quota checks)
CREATE TABLE IF NOT EXISTS llm_usage_monthly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  month TEXT NOT NULL,                   -- '2025-12' format
  request_count INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, month)
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_monthly_user ON llm_usage_monthly(user_id, month);

-- Sessions (for JWT refresh token management)
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  refresh_token_hash TEXT UNIQUE NOT NULL,
  user_agent TEXT,
  ip_hash TEXT,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user_expires ON sessions(user_id, expires_at);

-- OAuth Exchange Codes (one-time codes to exchange for tokens)
-- Prevents tokens from being exposed in URL query params
CREATE TABLE IF NOT EXISTS oauth_codes (
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  used INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_user ON oauth_codes(user_id);

-- Password Change Attempts (for rate limiting)
CREATE TABLE IF NOT EXISTS password_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  success INTEGER DEFAULT 0,
  ip_hash TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_password_attempts_user_time ON password_attempts(user_id, attempted_at);

-- ============================================================================
-- MIGRATIONS (for existing databases)
-- These use a pragma-based check to safely add columns that may already exist
-- ============================================================================

-- Add stripe_customer_id to users table if it doesn't exist
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we use a workaround
-- This will fail silently if column exists due to PRAGMA foreign_keys handling

-- Migration: Add billing_interval to subscriptions
-- Run this manually or via a migration script if the column doesn't exist

-- ============================================================================
-- ERROR MONITORING SYSTEM
-- ============================================================================

-- Error Issues (aggregated/grouped errors)
-- Similar errors are grouped by fingerprint for easier management
CREATE TABLE IF NOT EXISTS error_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT UNIQUE NOT NULL,      -- SHA-256 hash of category + errorType + normalized message
  category TEXT NOT NULL,
  error_type TEXT NOT NULL,
  message_pattern TEXT,                   -- Normalized message (paths/IDs removed)
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  occurrence_count INTEGER DEFAULT 1,
  status TEXT DEFAULT 'open',             -- 'open', 'resolved', 'ignored'
  resolved_at DATETIME,
  resolved_in_version TEXT,               -- App version where it was fixed
  notes TEXT                              -- Admin notes/comments
);

CREATE INDEX IF NOT EXISTS idx_error_issues_fingerprint ON error_issues(fingerprint);
CREATE INDEX IF NOT EXISTS idx_error_issues_status ON error_issues(status);
CREATE INDEX IF NOT EXISTS idx_error_issues_last_seen ON error_issues(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_error_issues_category ON error_issues(category);

-- Alert Rules (for email notifications)
CREATE TABLE IF NOT EXISTS alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL,                -- 'new_issue', 'threshold', 'spike'
  category_filter TEXT,                   -- Optional: only alert for specific category
  threshold_count INTEGER,                -- For threshold rules: trigger when > N errors
  threshold_window_minutes INTEGER,       -- For threshold rules: within M minutes
  email TEXT NOT NULL,                    -- Email address to notify
  enabled INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled);
CREATE INDEX IF NOT EXISTS idx_alert_rules_type ON alert_rules(rule_type);

-- Alert History (track sent alerts)
CREATE TABLE IF NOT EXISTS alert_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL,
  issue_id INTEGER,
  triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notification_sent INTEGER DEFAULT 0,
  error_message TEXT,                     -- If notification failed
  FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE,
  FOREIGN KEY (issue_id) REFERENCES error_issues(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_alert_history_rule ON alert_history(rule_id);
CREATE INDEX IF NOT EXISTS idx_alert_history_triggered ON alert_history(triggered_at)
