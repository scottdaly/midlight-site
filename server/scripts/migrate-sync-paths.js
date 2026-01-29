/**
 * Migration Script: Normalize Sync Document Paths
 *
 * This script fixes documents that were synced with absolute paths instead of
 * relative paths. It converts paths like:
 *
 *   /Users/scott/workspace/folder/doc.md  →  folder/doc.md
 *   /folder/doc.md                        →  folder/doc.md
 *   folder/doc.md                         →  folder/doc.md (no change)
 *
 * Run with: node server/scripts/migrate-sync-paths.js [--dry-run]
 *
 * Options:
 *   --dry-run    Show what would be changed without making changes
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// Connect to database
const dbPath = process.env.DB_PATH || path.join(__dirname, '../db/midlight_errors.db');
console.log(`Connecting to database: ${dbPath}`);
console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE'}\n`);

const db = new Database(dbPath);

/**
 * Normalize a path to sync format (relative, no leading slash)
 */
function normalizeSyncPath(inputPath) {
  if (!inputPath) return inputPath;

  let normalized = inputPath;

  // Common workspace root patterns to strip
  const workspacePatterns = [
    /^\/Users\/[^/]+\/[^/]+\//, // macOS: /Users/username/folder/
    /^\/home\/[^/]+\/[^/]+\//,  // Linux: /home/username/folder/
    /^[A-Za-z]:[/\\][^/\\]+[/\\][^/\\]+[/\\]/, // Windows: C:\Users\username\folder\
  ];

  // Try to strip known workspace patterns
  for (const pattern of workspacePatterns) {
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, '');
      break;
    }
  }

  // Normalize slashes
  normalized = normalized.replace(/\\/g, '/');

  // Remove leading slashes
  while (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }

  // Remove trailing slashes
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * Check if a path needs migration
 */
function needsMigration(currentPath) {
  if (!currentPath) return false;

  // Needs migration if:
  // 1. Starts with / (absolute Unix path)
  // 2. Starts with drive letter (Windows absolute)
  // 3. Contains common absolute path patterns

  if (currentPath.startsWith('/')) return true;
  if (/^[A-Za-z]:/.test(currentPath)) return true;

  return false;
}

// Main migration logic
console.log('Scanning sync_documents table for paths that need migration...\n');

// Get all documents
const documents = db.prepare(`
  SELECT id, user_id, path, updated_at
  FROM sync_documents
  ORDER BY user_id, path
`).all();

console.log(`Found ${documents.length} total documents\n`);

// Group by what needs migration
const toMigrate = [];
const alreadyOk = [];
const conflicts = new Map(); // Map of normalized path -> list of docs with that path

for (const doc of documents) {
  if (needsMigration(doc.path)) {
    const normalizedPath = normalizeSyncPath(doc.path);
    toMigrate.push({
      ...doc,
      newPath: normalizedPath,
    });

    // Track potential conflicts (multiple docs with same normalized path for same user)
    const key = `${doc.user_id}:${normalizedPath}`;
    if (!conflicts.has(key)) {
      conflicts.set(key, []);
    }
    conflicts.get(key).push(doc);
  } else {
    alreadyOk.push(doc);

    // Also track already-normalized docs for conflict detection
    const key = `${doc.user_id}:${doc.path}`;
    if (!conflicts.has(key)) {
      conflicts.set(key, []);
    }
    conflicts.get(key).push(doc);
  }
}

console.log(`Documents already in correct format: ${alreadyOk.length}`);
console.log(`Documents needing migration: ${toMigrate.length}\n`);

// Check for conflicts
const conflictGroups = [];
for (const [key, docs] of conflicts.entries()) {
  if (docs.length > 1) {
    conflictGroups.push({ key, docs });
  }
}

if (conflictGroups.length > 0) {
  console.log('='.repeat(60));
  console.log('CONFLICTS DETECTED');
  console.log('The following paths would have multiple documents after migration:');
  console.log('='.repeat(60));

  for (const { key, docs } of conflictGroups) {
    const [userId, path] = key.split(':');
    console.log(`\nUser ${userId}, Path: "${path}"`);
    for (const doc of docs) {
      console.log(`  - ID: ${doc.id}`);
      console.log(`    Current path: ${doc.path}`);
      console.log(`    Updated: ${doc.updated_at}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('MANUAL RESOLUTION REQUIRED');
  console.log('Please resolve conflicts before running migration.');
  console.log('Options:');
  console.log('  1. Delete duplicate documents (keep most recent)');
  console.log('  2. Rename one of the documents');
  console.log('='.repeat(60) + '\n');

  if (!dryRun) {
    console.log('Migration aborted due to conflicts.');
    process.exit(1);
  }
}

// Show migration plan
if (toMigrate.length > 0) {
  console.log('='.repeat(60));
  console.log('MIGRATION PLAN');
  console.log('='.repeat(60));

  // Group by user for cleaner output
  const byUser = new Map();
  for (const doc of toMigrate) {
    if (!byUser.has(doc.user_id)) {
      byUser.set(doc.user_id, []);
    }
    byUser.get(doc.user_id).push(doc);
  }

  for (const [userId, docs] of byUser.entries()) {
    console.log(`\nUser ${userId} (${docs.length} documents):`);
    for (const doc of docs) {
      console.log(`  "${doc.path}"`);
      console.log(`    → "${doc.newPath}"`);
    }
  }

  console.log('\n' + '='.repeat(60));
}

// Execute migration
if (!dryRun && toMigrate.length > 0 && conflictGroups.length === 0) {
  console.log('\nExecuting migration...\n');

  const updateStmt = db.prepare(`
    UPDATE sync_documents
    SET path = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  let success = 0;
  let failed = 0;

  const transaction = db.transaction(() => {
    for (const doc of toMigrate) {
      try {
        updateStmt.run(doc.newPath, doc.id);
        success++;
        console.log(`  ✓ Migrated: ${doc.path} → ${doc.newPath}`);
      } catch (error) {
        failed++;
        console.log(`  ✗ Failed: ${doc.path} - ${error.message}`);
      }
    }
  });

  try {
    transaction();
    console.log(`\nMigration complete!`);
    console.log(`  Success: ${success}`);
    console.log(`  Failed: ${failed}`);
  } catch (error) {
    console.error(`\nMigration failed: ${error.message}`);
    console.error('All changes have been rolled back.');
    process.exit(1);
  }
} else if (dryRun) {
  console.log('\n[DRY RUN] No changes were made.');
  console.log('Run without --dry-run to execute the migration.');
}

db.close();
