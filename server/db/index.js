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

// Initialize Schema
const schemaPath = path.join(__dirname, 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');
db.exec(schema);

// Run migrations for existing databases
// These safely add columns that may not exist
function runMigrations() {
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
  ];

  for (const migration of migrations) {
    if (!migration.check()) {
      migration.run();
    }
  }
}

runMigrations();

console.log(`Connected to SQLite database at ${dbPath}`);

export default db;
