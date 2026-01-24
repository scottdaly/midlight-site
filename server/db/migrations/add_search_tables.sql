-- Migration: Add search tables for unified Tavily-based search
-- Date: 2026-01-23
-- Run: sqlite3 /var/data/midlight/midlight.db < migrations/add_search_tables.sql

-- Search cache (replaces Redis with SQLite)
-- Stores Tavily search results for 15 minutes to reduce API costs
CREATE TABLE IF NOT EXISTS search_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_hash TEXT UNIQUE NOT NULL,     -- SHA-256 of normalized query (first 32 chars)
  query TEXT NOT NULL,                  -- Original query for debugging
  results TEXT NOT NULL,                -- JSON array of search results
  answer TEXT,                          -- Tavily's AI summary (optional)
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
  query_count INTEGER NOT NULL DEFAULT 1,    -- Number of search queries executed
  cached_count INTEGER NOT NULL DEFAULT 0,   -- Number of queries served from cache
  cost_cents INTEGER NOT NULL DEFAULT 0,     -- Total cost in cents (for precision)
  provider TEXT NOT NULL DEFAULT 'tavily',   -- Search provider used
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
  month TEXT NOT NULL,                       -- '2025-12' format
  search_count INTEGER DEFAULT 0,
  cached_count INTEGER DEFAULT 0,
  total_cost_cents INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, month)
);

CREATE INDEX IF NOT EXISTS idx_search_usage_monthly_user ON search_usage_monthly(user_id, month);

-- Add search_count to existing llm_usage table (if column doesn't exist)
-- Note: SQLite doesn't support IF NOT EXISTS for ALTER TABLE, run this manually if needed
-- ALTER TABLE llm_usage ADD COLUMN search_count INTEGER DEFAULT 0;
-- ALTER TABLE llm_usage_monthly ADD COLUMN search_count INTEGER DEFAULT 0;
