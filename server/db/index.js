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

console.log(`Connected to SQLite database at ${dbPath}`);

export default db;
