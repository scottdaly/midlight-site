import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure data directory exists (for production persistence)
// In dev we can just put it in the server directory or a .data directory
const dbPath = process.env.DB_PATH || path.join(__dirname, 'midlight_errors.db');

const db = new Database(dbPath); // verbose: console.log

// Run migrations for existing databases FIRST
// These safely add columns that may not exist before schema indexes reference them
function runMigrations() {
  // Check if users table exists (if not, skip migrations - fresh install)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").all();
  if (tables.length === 0) {
    return; // Fresh install, schema.sql will create everything
  }

  const migrations = [
    // Add stripe_customer_id to users table
    {
      name: 'add_stripe_customer_id_to_users',
      check: () => {
        const cols = db.prepare("PRAGMA table_info(users)").all();
        return cols.some(c => c.name === 'stripe_customer_id');
      },
      run: () => {
        db.exec("ALTER TABLE users ADD COLUMN stripe_customer_id TEXT");
        console.log('Migration: Added stripe_customer_id to users table');
      }
    },
    // Add billing_interval to subscriptions table
    {
      name: 'add_billing_interval_to_subscriptions',
      check: () => {
        const cols = db.prepare("PRAGMA table_info(subscriptions)").all();
        return cols.some(c => c.name === 'billing_interval');
      },
      run: () => {
        db.exec("ALTER TABLE subscriptions ADD COLUMN billing_interval TEXT");
        console.log('Migration: Added billing_interval to subscriptions table');
      }
    },
    // Add issue_id to error_reports for linking to aggregated issues
    {
      name: 'add_issue_id_to_error_reports',
      check: () => {
        const cols = db.prepare("PRAGMA table_info(error_reports)").all();
        return cols.some(c => c.name === 'issue_id');
      },
      run: () => {
        db.exec("ALTER TABLE error_reports ADD COLUMN issue_id INTEGER REFERENCES error_issues(id)");
        console.log('Migration: Added issue_id to error_reports table');
      }
    },
    // Add search_count to llm_usage table
    {
      name: 'add_search_count_to_llm_usage',
      check: () => {
        const cols = db.prepare("PRAGMA table_info(llm_usage)").all();
        return cols.some(c => c.name === 'search_count');
      },
      run: () => {
        db.exec("ALTER TABLE llm_usage ADD COLUMN search_count INTEGER DEFAULT 0");
        console.log('Migration: Added search_count to llm_usage table');
      }
    },
    // Add search_count to llm_usage_monthly table
    {
      name: 'add_search_count_to_llm_usage_monthly',
      check: () => {
        const cols = db.prepare("PRAGMA table_info(llm_usage_monthly)").all();
        return cols.some(c => c.name === 'search_count');
      },
      run: () => {
        db.exec("ALTER TABLE llm_usage_monthly ADD COLUMN search_count INTEGER DEFAULT 0");
        console.log('Migration: Added search_count to llm_usage_monthly table');
      }
    },
    // Add stack_trace to error_reports table
    {
      name: 'add_stack_trace_to_error_reports',
      check: () => {
        const cols = db.prepare("PRAGMA table_info(error_reports)").all();
        return cols.some(c => c.name === 'stack_trace');
      },
      run: () => {
        db.exec("ALTER TABLE error_reports ADD COLUMN stack_trace TEXT");
        console.log('Migration: Added stack_trace to error_reports table');
      }
    },
    // Create sync_document_content table (SQLite fallback for R2 storage)
    {
      name: 'create_sync_document_content',
      check: () => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_document_content'").all();
        return tables.length > 0;
      },
      run: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS sync_document_content (
            document_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            sidecar TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (document_id, user_id)
          );

          CREATE INDEX IF NOT EXISTS idx_sync_document_content_user ON sync_document_content(user_id);

          CREATE TABLE IF NOT EXISTS sync_conflict_content (
            user_id INTEGER NOT NULL,
            document_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            content TEXT NOT NULL,
            sidecar TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, document_id, version)
          );
        `);
        console.log('Migration: Created sync_document_content and sync_conflict_content tables');
      }
    },
    // Recreate sync content tables without foreign keys (fixes FOREIGN KEY constraint failed on upload)
    {
      name: 'recreate_sync_content_no_fk',
      check: () => {
        // Check if the table has foreign keys by looking at the CREATE statement
        const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_document_content'").get();
        // If table doesn't exist or doesn't have FOREIGN KEY, skip
        return !tableInfo || !tableInfo.sql.includes('FOREIGN KEY');
      },
      run: () => {
        db.exec(`
          DROP TABLE IF EXISTS sync_document_content;
          DROP TABLE IF EXISTS sync_conflict_content;

          CREATE TABLE sync_document_content (
            document_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            sidecar TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (document_id, user_id)
          );

          CREATE INDEX IF NOT EXISTS idx_sync_document_content_user ON sync_document_content(user_id);

          CREATE TABLE sync_conflict_content (
            user_id INTEGER NOT NULL,
            document_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            content TEXT NOT NULL,
            sidecar TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, document_id, version)
          );
        `);
        console.log('Migration: Recreated sync content tables without foreign keys');
      }
    },
    // Add billable_tokens column to llm_usage_monthly
    {
      name: 'add_billable_tokens_to_llm_usage_monthly',
      check: () => {
        const cols = db.prepare("PRAGMA table_info(llm_usage_monthly)").all();
        return cols.some(c => c.name === 'billable_tokens');
      },
      run: () => {
        db.exec("ALTER TABLE llm_usage_monthly ADD COLUMN billable_tokens INTEGER DEFAULT 0");
        // Backfill from detail table — exclude classification/compaction overhead
        db.exec(`UPDATE llm_usage_monthly SET billable_tokens = (
          SELECT COALESCE(SUM(total_tokens), 0)
          FROM llm_usage
          WHERE llm_usage.user_id = llm_usage_monthly.user_id
            AND strftime('%Y-%m', llm_usage.created_at) = llm_usage_monthly.month
            AND (llm_usage.request_type IS NULL OR llm_usage.request_type NOT IN ('classification', 'compaction'))
        )`);
        console.log('Migration: Added billable_tokens to llm_usage_monthly table');
      }
    },
    // Create email_verification_tokens table
    {
      name: 'create_email_verification_tokens',
      check: () => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='email_verification_tokens'").all();
        return tables.length > 0;
      },
      run: () => {
        db.exec(`
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
        `);
        console.log('Migration: Created email_verification_tokens table');
      }
    },
    // Create oauth_states table
    {
      name: 'create_oauth_states',
      check: () => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_states'").all();
        return tables.length > 0;
      },
      run: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS oauth_states (
            state_hash TEXT PRIMARY KEY,
            is_desktop INTEGER NOT NULL DEFAULT 0,
            dev_callback_port INTEGER,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
        `);
        console.log('Migration: Created oauth_states table');
      }
    },
    // Create auth_events audit log table
    {
      name: 'create_auth_events',
      check: () => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_events'").all();
        return tables.length > 0;
      },
      run: () => {
        db.exec(`
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
        `);
        console.log('Migration: Created auth_events table');
      }
    },
    // Add effort_lane to llm_usage table
    {
      name: 'add_effort_lane_to_llm_usage',
      check: () => {
        const cols = db.prepare("PRAGMA table_info(llm_usage)").all();
        return cols.some(c => c.name === 'effort_lane');
      },
      run: () => {
        db.exec("ALTER TABLE llm_usage ADD COLUMN effort_lane TEXT");
        console.log('Migration: Added effort_lane to llm_usage table');
      }
    },
    // Add prompt_version to llm_usage table
    {
      name: 'add_prompt_version_to_llm_usage',
      check: () => {
        const cols = db.prepare("PRAGMA table_info(llm_usage)").all();
        return cols.some(c => c.name === 'prompt_version');
      },
      run: () => {
        db.exec("ALTER TABLE llm_usage ADD COLUMN prompt_version TEXT");
        console.log('Migration: Added prompt_version to llm_usage table');
      }
    },
    // Create RAG tables for web semantic search
    {
      name: 'create_rag_tables',
      check: () => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rag_chunks'").all();
        return tables.length > 0;
      },
      run: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS rag_chunks (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            document_id TEXT NOT NULL,
            document_path TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            heading TEXT,
            embedding BLOB NOT NULL,
            token_estimate INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(document_id, chunk_index)
          );

          CREATE INDEX IF NOT EXISTS idx_rag_chunks_user ON rag_chunks(user_id);
          CREATE INDEX IF NOT EXISTS idx_rag_chunks_document ON rag_chunks(document_id);

          CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
            content, heading,
            content='rag_chunks', content_rowid='rowid',
            tokenize='porter unicode61'
          );

          CREATE TABLE IF NOT EXISTS rag_indexed_documents (
            user_id INTEGER NOT NULL,
            document_id TEXT NOT NULL,
            document_path TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            chunk_count INTEGER NOT NULL DEFAULT 0,
            total_chars INTEGER NOT NULL DEFAULT 0,
            indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, document_id)
          );
        `);
        console.log('Migration: Created RAG tables (rag_chunks, rag_chunks_fts, rag_indexed_documents)');
      }
    },
  ];

  for (const migration of migrations) {
    if (!migration.check()) {
      migration.run();
    }
  }
}

// Run migrations first (for existing databases)
runMigrations();

// Initialize Schema (CREATE TABLE IF NOT EXISTS won't modify existing tables)
const schemaPath = path.join(__dirname, 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');
db.exec(schema);

console.log(`Connected to SQLite database at ${dbPath}`);

export default db;
