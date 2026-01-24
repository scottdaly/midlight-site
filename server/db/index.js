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
