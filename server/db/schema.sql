-- Error Reports
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
  stack_trace TEXT,
  session_id TEXT,
  ip_hash TEXT,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  issue_id INTEGER REFERENCES error_issues(id),  -- Link to aggregated issues
  breadcrumbs TEXT                                -- JSON array of breadcrumb events
);

CREATE INDEX IF NOT EXISTS idx_error_reports_category ON error_reports(category);
CREATE INDEX IF NOT EXISTS idx_error_reports_received_at ON error_reports(received_at);
CREATE INDEX IF NOT EXISTS idx_error_reports_app_version ON error_reports(app_version);
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

-- Mobile subscription receipt verification log (StoreKit / Play Billing)
CREATE TABLE IF NOT EXISTS mobile_subscription_receipts (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,                  -- 'apple' | 'google'
  provider_transaction_id TEXT NOT NULL,   -- original_transaction_id or purchaseToken
  product_id TEXT NOT NULL,
  app_account_token TEXT,
  environment TEXT NOT NULL DEFAULT 'production',
  expires_at DATETIME,
  is_active INTEGER NOT NULL DEFAULT 0,
  raw_payload TEXT,
  validated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(provider, provider_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_mobile_receipts_user ON mobile_subscription_receipts(user_id);
CREATE INDEX IF NOT EXISTS idx_mobile_receipts_provider ON mobile_subscription_receipts(provider, provider_transaction_id);

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
  effort_lane TEXT,                      -- 'quick', 'think', 'write', 'manual', 'inline_edit', 'compaction', 'classification'
  search_count INTEGER DEFAULT 0,        -- Number of web searches executed
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
  billable_tokens INTEGER DEFAULT 0,     -- Tokens excluding classification/compaction overhead
  search_count INTEGER DEFAULT 0,        -- Monthly search count
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

-- Password Reset Tokens
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires ON password_reset_tokens(expires_at);

-- Email Verification Tokens
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_hash ON email_verification_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_expires ON email_verification_tokens(expires_at);

-- OAuth State Tokens (persisted for server restart resilience)
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  is_desktop INTEGER NOT NULL DEFAULT 0,
  dev_callback_port INTEGER,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);

-- Auth Event Audit Log
CREATE TABLE IF NOT EXISTS auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  event_type TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_events_user ON auth_events(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_events_type ON auth_events(event_type);
CREATE INDEX IF NOT EXISTS idx_auth_events_created ON auth_events(created_at);

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
CREATE INDEX IF NOT EXISTS idx_alert_history_triggered ON alert_history(triggered_at);

-- ============================================================================
-- DOCUMENT SYNC SYSTEM
-- ============================================================================

-- Sync Documents (metadata for synced documents)
CREATE TABLE IF NOT EXISTS sync_documents (
  id TEXT PRIMARY KEY,                      -- UUID
  user_id INTEGER NOT NULL,
  path TEXT NOT NULL,                       -- Document path (e.g., '/notes/hello.md')
  content_hash TEXT NOT NULL,               -- SHA-256 of document content
  sidecar_hash TEXT NOT NULL,               -- SHA-256 of sidecar JSON
  r2_content_key TEXT,                      -- R2 object key for content
  r2_sidecar_key TEXT,                      -- R2 object key for sidecar
  version INTEGER NOT NULL DEFAULT 1,       -- Incremented on each update
  size_bytes INTEGER DEFAULT 0,             -- Document size for quota tracking
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,                      -- Soft delete for sync
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, path)
);

CREATE INDEX IF NOT EXISTS idx_sync_documents_user ON sync_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_documents_user_path ON sync_documents(user_id, path);
CREATE INDEX IF NOT EXISTS idx_sync_documents_updated ON sync_documents(updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_documents_deleted ON sync_documents(deleted_at);

-- Sync Conflicts (when local and remote versions diverge)
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY,                      -- UUID
  document_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  local_version INTEGER,
  remote_version INTEGER,
  local_content_hash TEXT,
  remote_content_hash TEXT,
  local_r2_key TEXT,                        -- Preserved local version in R2
  remote_r2_key TEXT,                       -- Preserved remote version in R2
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME,
  resolution TEXT,                          -- 'local', 'remote', 'merged', 'both'
  FOREIGN KEY (document_id) REFERENCES sync_documents(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_document ON sync_conflicts(document_id);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_user ON sync_conflicts(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_unresolved ON sync_conflicts(user_id, resolved_at);

-- Sync Usage (track storage usage per user)
CREATE TABLE IF NOT EXISTS sync_usage (
  user_id INTEGER PRIMARY KEY,
  document_count INTEGER DEFAULT 0,
  total_size_bytes INTEGER DEFAULT 0,
  last_sync_at DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Sync Document Content (SQLite fallback when R2 is not configured)
-- Stores actual document content + sidecar directly in SQLite
-- No foreign keys: content is inserted before sync_documents row exists (optimistic upload pattern)
CREATE TABLE IF NOT EXISTS sync_document_content (
  document_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,                    -- Document content (markdown or JSON)
  sidecar TEXT NOT NULL,                    -- Sidecar JSON string
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (document_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_document_content_user ON sync_document_content(user_id);

-- Sync Conflict Content (SQLite fallback for conflict version preservation)
CREATE TABLE IF NOT EXISTS sync_conflict_content (
  user_id INTEGER NOT NULL,
  document_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  sidecar TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, document_id, version)
);

-- Sync Versions (synced save points / bookmarks)
CREATE TABLE IF NOT EXISTS sync_versions (
  id TEXT PRIMARY KEY,                       -- Client-generated checkpoint ID (dedup key)
  document_id TEXT NOT NULL,                 -- References sync_documents.id
  user_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  content_hash TEXT NOT NULL,
  sidecar_hash TEXT,
  summary TEXT,
  stats_json TEXT,                           -- JSON: { wordCount, charCount, changeSize }
  size_bytes INTEGER DEFAULT 0,             -- Content size for quota tracking
  created_at DATETIME NOT NULL,             -- Original client timestamp
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sync_versions_document ON sync_versions(document_id);
CREATE INDEX IF NOT EXISTS idx_sync_versions_user ON sync_versions(user_id);

-- Sync Version Content (SQLite fallback when R2 is not configured)
CREATE TABLE IF NOT EXISTS sync_version_content (
  version_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,                     -- Full document snapshot (markdown)
  sidecar TEXT,                              -- Sidecar JSON string
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sync_version_content_user ON sync_version_content(user_id);

-- Sync Operations Log (for debugging and analytics)
CREATE TABLE IF NOT EXISTS sync_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  document_id TEXT,
  operation TEXT NOT NULL,                  -- 'upload', 'download', 'delete', 'conflict'
  path TEXT,
  size_bytes INTEGER DEFAULT 0,
  success INTEGER DEFAULT 1,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_operations_user ON sync_operations(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_operations_created ON sync_operations(created_at);

-- ============================================================================
-- WEB SEARCH SYSTEM (Unified Tavily-based search)
-- ============================================================================

-- Search cache (replaces native provider search with unified Tavily)
-- Stores search results for 15 minutes to reduce API costs
CREATE TABLE IF NOT EXISTS search_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_hash TEXT UNIQUE NOT NULL,        -- SHA-256 of normalized query (first 32 chars)
  query TEXT NOT NULL,                     -- Original query for debugging
  results TEXT NOT NULL,                   -- JSON array of search results
  answer TEXT,                             -- Tavily's AI summary (optional)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_cache_hash ON search_cache(query_hash);
CREATE INDEX IF NOT EXISTS idx_search_cache_expires ON search_cache(expires_at);

-- Search usage tracking (detailed per-request records)
-- Follows same pattern as llm_usage table
CREATE TABLE IF NOT EXISTS search_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  query_count INTEGER NOT NULL DEFAULT 1,   -- Number of search queries executed
  cached_count INTEGER NOT NULL DEFAULT 0,  -- Number of queries served from cache
  cost_cents INTEGER NOT NULL DEFAULT 0,    -- Total cost in cents (for precision)
  provider TEXT NOT NULL DEFAULT 'tavily',  -- Search provider used
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_search_usage_user ON search_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_search_usage_created ON search_usage(created_at);

-- Monthly search rollup (for fast limit checks)
-- Follows same pattern as llm_usage_monthly table
CREATE TABLE IF NOT EXISTS search_usage_monthly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  month TEXT NOT NULL,                      -- '2025-12' format
  search_count INTEGER DEFAULT 0,
  cached_count INTEGER DEFAULT 0,
  total_cost_cents INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, month)
);

CREATE INDEX IF NOT EXISTS idx_search_usage_monthly_user ON search_usage_monthly(user_id, month);

-- ============================================================================
-- SKILLS MARKETPLACE SYSTEM
-- ============================================================================

-- Marketplace Skills Catalog
CREATE TABLE IF NOT EXISTS marketplace_skills (
  id TEXT PRIMARY KEY,                        -- UUID
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  icon TEXT NOT NULL,
  category TEXT NOT NULL,                     -- 'writing', 'editing', 'analysis', 'extraction', 'generation', 'utility'
  author_id INTEGER NOT NULL,
  author_name TEXT NOT NULL,
  current_version TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  install_count INTEGER DEFAULT 0,
  avg_rating REAL DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'published',            -- 'published', 'flagged', 'removed'
  is_featured INTEGER DEFAULT 0,
  tags TEXT,                                  -- JSON array
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(name, author_id)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_skills_category ON marketplace_skills(category);
CREATE INDEX IF NOT EXISTS idx_marketplace_skills_status ON marketplace_skills(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_skills_featured ON marketplace_skills(is_featured);
CREATE INDEX IF NOT EXISTS idx_marketplace_skills_author ON marketplace_skills(author_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_skills_rating ON marketplace_skills(avg_rating DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_skills_installs ON marketplace_skills(install_count DESC);

-- Skill Versions (version history for each skill)
CREATE TABLE IF NOT EXISTS skill_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  instructions TEXT NOT NULL,
  inputs TEXT NOT NULL,                       -- JSON array of SkillInput
  output_format TEXT NOT NULL,                -- 'text', 'markdown', 'json', 'replace'
  supports_selection INTEGER DEFAULT 1,
  supports_chat INTEGER DEFAULT 1,
  changelog TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (skill_id) REFERENCES marketplace_skills(id) ON DELETE CASCADE,
  UNIQUE(skill_id, version)
);

CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id);

-- Skill Ratings and Reviews
CREATE TABLE IF NOT EXISTS skill_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
  review TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (skill_id) REFERENCES marketplace_skills(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(skill_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_skill_ratings_skill ON skill_ratings(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_ratings_user ON skill_ratings(user_id);

-- Community Flags (for reporting inappropriate/broken skills)
CREATE TABLE IF NOT EXISTS skill_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  reason TEXT NOT NULL,                       -- 'spam', 'inappropriate', 'broken', 'other'
  details TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved INTEGER DEFAULT 0,
  resolved_at DATETIME,
  resolved_by INTEGER,
  resolution_notes TEXT,
  FOREIGN KEY (skill_id) REFERENCES marketplace_skills(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_flags_skill ON skill_flags(skill_id);
CREATE INDEX IF NOT EXISTS idx_skill_flags_unresolved ON skill_flags(resolved);

-- User's Installed Marketplace Skills
CREATE TABLE IF NOT EXISTS user_installed_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  skill_id TEXT NOT NULL,
  installed_version TEXT NOT NULL,
  installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (skill_id) REFERENCES marketplace_skills(id) ON DELETE CASCADE,
  UNIQUE(user_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_user_installed_skills_user ON user_installed_skills(user_id);
CREATE INDEX IF NOT EXISTS idx_user_installed_skills_skill ON user_installed_skills(skill_id);

-- User's Private Skills (synced across devices)
CREATE TABLE IF NOT EXISTS user_private_skills (
  id TEXT PRIMARY KEY,                        -- UUID
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  icon TEXT NOT NULL,
  category TEXT NOT NULL,
  instructions TEXT NOT NULL,
  inputs TEXT NOT NULL,                       -- JSON array of SkillInput
  output_format TEXT NOT NULL,
  supports_selection INTEGER DEFAULT 1,
  supports_chat INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_user_private_skills_user ON user_private_skills(user_id);

-- ============================================================================
-- RAG (Retrieval Augmented Generation) SYSTEM
-- Server-side RAG for web app users with synced documents
-- ============================================================================

-- RAG Chunks (embedded document fragments)
CREATE TABLE IF NOT EXISTS rag_chunks (
  id TEXT PRIMARY KEY,                    -- "{user_id}:{doc_id}:{chunk_index}"
  user_id INTEGER NOT NULL,
  document_id TEXT NOT NULL,
  document_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  heading TEXT,
  embedding BLOB NOT NULL,               -- Float32 little-endian bytes
  token_estimate INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_user ON rag_chunks(user_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_document ON rag_chunks(document_id);

-- FTS5 virtual table for BM25 text search
CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
  content, heading,
  content='rag_chunks', content_rowid='rowid',
  tokenize='porter unicode61'
);

-- FTS sync is handled manually by ragService.js (insertFts/deleteFts functions)
-- Do NOT add triggers here — they conflict with manual FTS management.

-- RAG Indexed Documents (tracks which docs have been indexed + their content hash)
CREATE TABLE IF NOT EXISTS rag_indexed_documents (
  user_id INTEGER NOT NULL,
  document_id TEXT NOT NULL,
  document_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,             -- Compare against sync_documents.content_hash
  chunk_count INTEGER NOT NULL DEFAULT 0,
  total_chars INTEGER NOT NULL DEFAULT 0,
  indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_rag_indexed_documents_user ON rag_indexed_documents(user_id);

-- Prompt A/B Testing Variants
CREATE TABLE IF NOT EXISTS prompt_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_name TEXT NOT NULL,
  section_name TEXT NOT NULL,
  variant_key TEXT NOT NULL,
  text TEXT NOT NULL,
  version TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 50,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(experiment_name, variant_key)
);

CREATE INDEX IF NOT EXISTS idx_prompt_variants_experiment ON prompt_variants(experiment_name, is_active);

-- Prompt A/B Testing User Assignments
CREATE TABLE IF NOT EXISTS user_variant_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  experiment_name TEXT NOT NULL,
  variant_key TEXT NOT NULL,
  assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, experiment_name)
);

CREATE INDEX IF NOT EXISTS idx_user_variant_assignments_user ON user_variant_assignments(user_id);

-- ============================================================================
-- DOCUMENT SHARING SYSTEM
-- ============================================================================

-- Document Shares (one per document, tracks link sharing settings)
CREATE TABLE IF NOT EXISTS document_shares (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  link_token TEXT UNIQUE,
  link_permission TEXT NOT NULL DEFAULT 'view',
  link_enabled INTEGER NOT NULL DEFAULT 0,
  allow_copy INTEGER NOT NULL DEFAULT 1,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES sync_documents(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_shares_document ON document_shares(document_id);
CREATE INDEX IF NOT EXISTS idx_document_shares_link_token ON document_shares(link_token) WHERE link_token IS NOT NULL;

-- Document Access (per-user invitation entries)
CREATE TABLE IF NOT EXISTS document_access (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  user_id INTEGER,
  email TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'view',
  accepted_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (share_id) REFERENCES document_shares(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(share_id, email)
);

CREATE INDEX IF NOT EXISTS idx_document_access_user ON document_access(user_id);
CREATE INDEX IF NOT EXISTS idx_document_access_share ON document_access(share_id);
CREATE INDEX IF NOT EXISTS idx_document_access_user_accepted ON document_access(user_id, accepted_at);

-- ============================================================================
-- INLINE COMMENTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS document_comments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  parent_id TEXT,
  content TEXT NOT NULL,
  anchor_from INTEGER,
  anchor_to INTEGER,
  anchor_text TEXT,
  anchor_yjs_from TEXT,
  anchor_yjs_to TEXT,
  resolved_at DATETIME,
  resolved_by INTEGER,
  edited_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME,
  FOREIGN KEY (document_id) REFERENCES sync_documents(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES document_comments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_document_comments_document ON document_comments(document_id);
CREATE INDEX IF NOT EXISTS idx_document_comments_author ON document_comments(author_id);
CREATE INDEX IF NOT EXISTS idx_document_comments_parent ON document_comments(parent_id);

-- ============================================================================
-- GUEST SESSIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS guest_sessions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT 'Guest',
  permission TEXT NOT NULL DEFAULT 'view',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  FOREIGN KEY (document_id) REFERENCES sync_documents(id) ON DELETE CASCADE,
  FOREIGN KEY (share_id) REFERENCES document_shares(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_guest_sessions_document ON guest_sessions(document_id);
CREATE INDEX IF NOT EXISTS idx_guest_sessions_expires ON guest_sessions(expires_at);

-- ============================================================================
-- NOTIFICATIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  document_id TEXT,
  comment_id TEXT,
  actor_id INTEGER,
  read_at DATETIME,
  email_sent_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id INTEGER PRIMARY KEY,
  email_comments INTEGER DEFAULT 1,
  email_mentions INTEGER DEFAULT 1,
  email_suggestions INTEGER DEFAULT 1,
  email_edits INTEGER DEFAULT 0,
  email_shares INTEGER DEFAULT 1,
  in_app_enabled INTEGER DEFAULT 1,
  digest_frequency TEXT DEFAULT 'instant',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Native push token registry
CREATE TABLE IF NOT EXISTS mobile_notification_devices (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL,                  -- 'ios' | 'android'
  device_token TEXT NOT NULL,
  push_provider TEXT DEFAULT 'native',     -- 'apns' | 'fcm'
  app_version TEXT,
  build_channel TEXT,                      -- 'debug' | 'internal' | 'beta' | 'production'
  locale TEXT,
  timezone TEXT,
  network_state TEXT,
  delivery_failures INTEGER NOT NULL DEFAULT 0,
  last_delivery_error TEXT,
  last_delivery_error_at DATETIME,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, platform, device_token)
);

CREATE INDEX IF NOT EXISTS idx_mobile_notification_devices_user ON mobile_notification_devices(user_id);

-- ============================================================================
-- SUGGESTIONS (Tracked Changes)
-- ============================================================================

CREATE TABLE IF NOT EXISTS document_suggestions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  anchor_from INTEGER NOT NULL,
  anchor_to INTEGER NOT NULL,
  original_text TEXT,
  suggested_text TEXT,
  anchor_yjs_from TEXT,
  anchor_yjs_to TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_by INTEGER,
  resolved_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES sync_documents(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_document_suggestions_document ON document_suggestions(document_id);
CREATE INDEX IF NOT EXISTS idx_document_suggestions_status ON document_suggestions(document_id, status);

-- ============================================================================
-- ACTIVITY FEED
-- ============================================================================

CREATE TABLE IF NOT EXISTS document_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES sync_documents(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_document_activity_document ON document_activity(document_id);
CREATE INDEX IF NOT EXISTS idx_document_activity_user ON document_activity(user_id);
CREATE INDEX IF NOT EXISTS idx_document_activity_created ON document_activity(created_at);

-- ============================================================================
-- TEAM WORKSPACES
-- ============================================================================

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  owner_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_id);
CREATE INDEX IF NOT EXISTS idx_teams_slug ON teams(slug);

CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(team_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

CREATE TABLE IF NOT EXISTS team_documents (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  added_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES sync_documents(id) ON DELETE CASCADE,
  UNIQUE(team_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_team_documents_team ON team_documents(team_id);
CREATE INDEX IF NOT EXISTS idx_team_documents_document ON team_documents(document_id);

-- ============================================================================
-- VERSION BRANCHES
-- ============================================================================

CREATE TABLE IF NOT EXISTS document_branches (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  name TEXT NOT NULL,
  base_version_id TEXT NOT NULL,
  base_content_hash TEXT NOT NULL,
  creator_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  merged_at DATETIME,
  merged_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES sync_documents(id) ON DELETE CASCADE,
  UNIQUE(document_id, name)
);

CREATE INDEX IF NOT EXISTS idx_document_branches_document ON document_branches(document_id);
CREATE INDEX IF NOT EXISTS idx_document_branches_status ON document_branches(document_id, status);

CREATE TABLE IF NOT EXISTS document_branch_content (
  branch_id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  sidecar TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (branch_id) REFERENCES document_branches(id) ON DELETE CASCADE
);

-- ============================================================================
-- SECTION LOCKS (Granular Permissions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS document_section_locks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  heading_text TEXT NOT NULL,
  heading_level INTEGER NOT NULL,
  heading_node_id TEXT,
  locked_by INTEGER NOT NULL,
  lock_type TEXT NOT NULL DEFAULT 'owner_only',
  allowed_user_ids TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES sync_documents(id) ON DELETE CASCADE,
  UNIQUE(document_id, heading_node_id)
);

CREATE INDEX IF NOT EXISTS idx_document_section_locks_document ON document_section_locks(document_id);

-- ============================================================================
-- COLLABORATIVE EDITING (Y.js / Hocuspocus)
-- ============================================================================

-- Y.js Document State (binary CRDT state per shared document)
CREATE TABLE IF NOT EXISTS yjs_documents (
  document_id TEXT PRIMARY KEY,
  state BLOB NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES sync_documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_yjs_documents_updated ON yjs_documents(updated_at);
