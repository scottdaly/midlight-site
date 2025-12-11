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
