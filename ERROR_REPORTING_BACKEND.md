# Task: Add Error Reporting Backend to Midlight Marketing Site

## Context

We have a Midlight desktop app (Electron) that now sends anonymous error reports to help us diagnose issues. We need to add a backend endpoint and database to receive and store these reports. Currently the marketing site is a frontend-only Vite React site hosted on a Digital Ocean droplet.

## Requirements

### 1. Backend API

Create a simple backend server (Node.js with Express or Hono) with the following endpoint:

**POST `/api/error-report`**

Accepts JSON body:
```typescript
interface ErrorReport {
  // Error identification
  category: 'update' | 'import' | 'file_system' | 'crash' | 'uncaught';
  errorType: string;
  message: string;

  // Context (no PII)
  appVersion: string;
  platform: 'darwin' | 'win32' | 'linux';
  arch: string;
  osVersion: string;

  // Optional additional context
  context?: Record<string, string | number | boolean>;

  // Timestamp
  timestamp: string;

  // Anonymous session ID
  sessionId: string;
}
```

Requirements:
- Validate the JSON structure (reject malformed requests)
- Store in database
- Return 200 OK on success (client is fire-and-forget)
- Rate limit by IP (e.g., max 100 requests/hour) to prevent abuse
- CORS: Allow requests from desktop app (no origin header) and potentially from web

### 2. Database

Set up a simple database (SQLite for simplicity, or PostgreSQL if preferred) with a table:

```sql
CREATE TABLE error_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  error_type TEXT NOT NULL,
  message TEXT,
  app_version TEXT,
  platform TEXT,
  arch TEXT,
  os_version TEXT,
  context TEXT,  -- JSON string
  session_id TEXT,
  ip_hash TEXT,  -- Hashed IP for rate limiting, not stored raw
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for querying
CREATE INDEX idx_error_reports_category ON error_reports(category);
CREATE INDEX idx_error_reports_received_at ON error_reports(received_at);
CREATE INDEX idx_error_reports_app_version ON error_reports(app_version);
```

### 3. Admin Dashboard (Optional but Recommended)

A simple password-protected page at `/admin/errors` that shows:
- Recent error reports (last 24h, 7d, 30d)
- Grouped by category and errorType
- Filterable by app version, platform
- Basic stats: error count over time, most common errors

### 4. Deployment

- Run the backend on the same Digital Ocean droplet
- Use a process manager (PM2) to keep it running
- Proxy requests from nginx to the backend (e.g., `/api/*` → `localhost:3001`)
- Database file stored in a persistent location (e.g., `/var/data/midlight/errors.db`)

## Current Setup

- Frontend: Vite React site
- Hosting: Digital Ocean droplet
- Web server: Likely nginx serving static files
- Domain: midlight.ai

## Suggested Tech Stack

- **Backend**: Node.js with Hono (lightweight) or Express
- **Database**: SQLite (simple, no separate server needed) with better-sqlite3
- **Process Manager**: PM2
- **Auth for Admin**: Simple password auth or basic HTTP auth

## File Structure Suggestion

```
marketing-site/
├── src/                    # Existing frontend
├── server/                 # NEW: Backend
│   ├── index.ts           # Server entry point
│   ├── routes/
│   │   └── errorReport.ts # Error report endpoint
│   ├── db/
│   │   ├── schema.sql
│   │   └── index.ts       # Database connection
│   └── middleware/
│       └── rateLimit.ts
├── package.json           # Add server dependencies
└── ...
```

## Security Considerations

1. **No raw IPs stored** - Hash IPs for rate limiting, don't log them
2. **Rate limiting** - Prevent abuse/DoS
3. **Input validation** - Sanitize all inputs before storing
4. **Admin auth** - Protect the dashboard with authentication
5. **Message sanitization** - The desktop app already sanitizes, but double-check server-side

## Error Types Reference

The desktop app sends the following error categories and types:

```typescript
// All error categories and types
type ErrorCategory = 'update' | 'import' | 'file_system' | 'crash' | 'uncaught';

// Update errors (from auto-updater)
type UpdateErrorType = 'checksum' | 'network' | 'download' | 'install' | 'unknown';
// Context fields: targetVersion?, currentVersion?, filename?

// Import errors (from Obsidian/Notion imports)
type ImportErrorType =
  | 'path_traversal'  // Security: malicious path detected
  | 'file_read'       // Failed to read source file
  | 'file_write'      // Failed to write destination file
  | 'parse'           // Failed to parse file content
  | 'disk_space'      // Insufficient disk space
  | 'checksum'        // File copy verification failed
  | 'rollback'        // Transaction rollback failed
  | 'cancelled'       // User cancelled import
  | 'unknown';
// Context fields: sourceType? ('obsidian'|'notion'|'generic'), fileCount?, phase?, errorCount?

// Crash errors (process termination)
type CrashErrorType =
  | 'uncaught_exception'    // Main process uncaught exception
  | 'renderer_crash'        // Renderer process crashed
  | 'renderer_unresponsive'; // Renderer became unresponsive
// Context fields: stack?, exitCode?

// Uncaught errors (handled but unexpected)
type UncaughtErrorType =
  | 'unhandled_rejection'     // Main process unhandled promise
  | 'renderer_react_error'    // React component error
  | 'renderer_window_error'   // window.onerror in renderer
  | 'renderer_unhandled_promise'; // Renderer unhandled promise
// Context fields: stack?, componentStack?
```

## Success Criteria

1. `POST https://midlight.ai/api/error-report` accepts valid reports and returns 200
2. Reports are stored in database and queryable
3. Server stays running via PM2
4. (Bonus) Admin can view reports at `/admin/errors`
