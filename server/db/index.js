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

// Enable WAL mode for better concurrent read performance during SSE streaming
db.pragma('journal_mode = WAL');

// Enable foreign key enforcement (SQLite disables this by default)
// Must run before any migrations or schema setup
db.pragma('foreign_keys = ON');

// Verify foreign keys are enabled
const fkStatus = db.pragma('foreign_keys');
if (!fkStatus[0]?.foreign_keys) {
  console.error('WARNING: Failed to enable SQLite foreign keys');
} else {
  console.log('SQLite foreign keys enabled');
}

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
    // Add prompt_variant to llm_usage table (A/B testing)
    {
      name: 'add_prompt_variant_to_llm_usage',
      check: () => {
        const cols = db.prepare("PRAGMA table_info(llm_usage)").all();
        return cols.some(c => c.name === 'prompt_variant');
      },
      run: () => {
        db.exec("ALTER TABLE llm_usage ADD COLUMN prompt_variant TEXT");
        console.log('Migration: Added prompt_variant to llm_usage table');
      }
    },
    // Create sync_versions and sync_version_content tables (version/bookmark sync)
    {
      name: 'create_sync_version_tables',
      check: () => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_versions'").all();
        return tables.length > 0;
      },
      run: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS sync_versions (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            label TEXT NOT NULL,
            description TEXT,
            content_hash TEXT NOT NULL,
            sidecar_hash TEXT,
            summary TEXT,
            stats_json TEXT,
            size_bytes INTEGER DEFAULT 0,
            created_at DATETIME NOT NULL,
            uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX IF NOT EXISTS idx_sync_versions_document ON sync_versions(document_id);
          CREATE INDEX IF NOT EXISTS idx_sync_versions_user ON sync_versions(user_id);

          CREATE TABLE IF NOT EXISTS sync_version_content (
            version_id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            sidecar TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX IF NOT EXISTS idx_sync_version_content_user ON sync_version_content(user_id);
        `);
        console.log('Migration: Created sync_versions and sync_version_content tables');
      }
    },
    // Create prompt_variants and user_variant_assignments tables (A/B testing)
    {
      name: 'create_prompt_ab_tables',
      check: () => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='prompt_variants'").all();
        return tables.length > 0;
      },
      run: () => {
        db.exec(`
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
        `);
        console.log('Migration: Created prompt A/B testing tables');
      }
    },
    // Create billing_events audit table
    {
      name: 'create_billing_events',
      check: () => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='billing_events'").all();
        return tables.length > 0;
      },
      run: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS billing_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stripe_event_id TEXT UNIQUE NOT NULL,
            event_type TEXT NOT NULL,
            user_id INTEGER,
            stripe_customer_id TEXT,
            data_summary TEXT,
            processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX IF NOT EXISTS idx_billing_events_user ON billing_events(user_id);
          CREATE INDEX IF NOT EXISTS idx_billing_events_type ON billing_events(event_type);
        `);
        console.log('Migration: Created billing_events audit table');
      }
    },
    // Create archived_users table
    {
      name: 'create_archived_users',
      check: () => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='archived_users'").all();
        return tables.length > 0;
      },
      run: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS archived_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_user_id INTEGER NOT NULL,
            email_hash TEXT NOT NULL,
            tier TEXT,
            total_requests INTEGER DEFAULT 0,
            total_tokens INTEGER DEFAULT 0,
            total_cost_cents INTEGER DEFAULT 0,
            subscription_history TEXT,
            account_created_at DATETIME,
            deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `);
        console.log('Migration: Created archived_users table');
      }
    },
    // Create document sharing tables
    {
      name: 'create_document_sharing_tables',
      check: () => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_shares'").all();
        return tables.length > 0;
      },
      run: () => {
        db.exec(`
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
        `);
        console.log('Migration: Created document sharing tables (document_shares, document_access)');
      }
    },
    // Create yjs_documents table for collaborative editing
    {
      name: 'create_yjs_documents',
      check: () => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='yjs_documents'").all();
        return tables.length > 0;
      },
      run: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS yjs_documents (
            document_id TEXT PRIMARY KEY,
            state BLOB NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (document_id) REFERENCES sync_documents(id) ON DELETE CASCADE
          );
        `);
        console.log('Migration: Created yjs_documents table for collaborative editing');
      }
    },
    // Create collaboration tier 3 tables
    {
      name: 'create_collab_tier3_tables',
      check: () => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_comments'").all();
        return tables.length > 0;
      },
      run: () => {
        db.exec(`
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
        `);
        console.log('Migration: Created collaboration tier 3 tables (comments, guests, notifications, suggestions, activity, teams, branches, section locks)');
      }
    },
    // Add performance indexes for collaborative editing
    {
      name: 'add_collab_indexes',
      check: () => {
        const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_document_access_user_accepted'").all();
        return idx.length > 0;
      },
      run: () => {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_document_access_user_accepted ON document_access(user_id, accepted_at);
          CREATE INDEX IF NOT EXISTS idx_yjs_documents_updated ON yjs_documents(updated_at);
        `);
        console.log('Migration: Added collaborative editing performance indexes');
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

export { dbPath };
export default db;
