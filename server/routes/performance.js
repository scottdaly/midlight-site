import express from 'express';
import db from '../db/index.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// POST /api/perf-report
router.post('/', (req, res) => {
  try {
    const { eventType, metricName, value, rating, appVersion, platform, userHash, sessionId, context } = req.body;

    if (!eventType || !metricName || value == null) {
      return res.status(400).json({ error: 'Missing required fields: eventType, metricName, value' });
    }

    if (typeof value !== 'number' || !isFinite(value)) {
      return res.status(400).json({ error: 'value must be a finite number' });
    }

    const contextStr = context ? JSON.stringify(context) : null;

    db.prepare(`
      INSERT INTO performance_events (event_type, metric_name, value, rating, app_version, platform, user_hash, session_id, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventType,
      metricName,
      value,
      rating || null,
      appVersion || '',
      platform || '',
      userHash || null,
      sessionId || null,
      contextStr
    );

    res.status(200).json({ success: true });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error storing perf report');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/perf-report/batch
router.post('/batch', (req, res) => {
  try {
    const { events } = req.body;

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events must be a non-empty array' });
    }

    if (events.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 events per batch' });
    }

    const stmt = db.prepare(`
      INSERT INTO performance_events (event_type, metric_name, value, rating, app_version, platform, user_hash, session_id, context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let processed = 0;
    let failed = 0;

    for (const event of events) {
      try {
        const { eventType, metricName, value, rating, appVersion, platform, userHash, sessionId, context } = event;

        if (!eventType || !metricName || value == null || typeof value !== 'number' || !isFinite(value)) {
          failed++;
          continue;
        }

        const contextStr = context ? JSON.stringify(context) : null;

        stmt.run(
          eventType,
          metricName,
          value,
          rating || null,
          appVersion || '',
          platform || '',
          userHash || null,
          sessionId || null,
          contextStr
        );

        processed++;
      } catch {
        failed++;
      }
    }

    res.status(200).json({ processed, failed });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error storing perf batch');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/admin/performance/stats
router.get('/stats', (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 30);

    // Web Vitals percentiles
    const webVitals = db.prepare(`
      SELECT metric_name,
        COUNT(*) as count,
        ROUND(AVG(value), 2) as avg,
        MIN(value) as min,
        MAX(value) as max
      FROM performance_events
      WHERE event_type = 'web_vital'
        AND received_at > datetime('now', '-' || ? || ' days')
      GROUP BY metric_name
      ORDER BY metric_name
    `).all(days);

    // Calculate percentiles for each metric
    const metrics = {};
    for (const vital of webVitals) {
      const values = db.prepare(`
        SELECT value FROM performance_events
        WHERE event_type = 'web_vital' AND metric_name = ?
          AND received_at > datetime('now', '-' || ? || ' days')
        ORDER BY value
      `).all(vital.metric_name, days).map(r => r.value);

      const p50 = percentile(values, 50);
      const p75 = percentile(values, 75);
      const p95 = percentile(values, 95);

      metrics[vital.metric_name] = {
        count: vital.count,
        avg: vital.avg,
        min: vital.min,
        max: vital.max,
        p50,
        p75,
        p95,
      };
    }

    // Rating distribution
    const ratings = db.prepare(`
      SELECT metric_name, rating, COUNT(*) as count
      FROM performance_events
      WHERE event_type = 'web_vital' AND rating IS NOT NULL
        AND received_at > datetime('now', '-' || ? || ' days')
      GROUP BY metric_name, rating
      ORDER BY metric_name, rating
    `).all(days);

    // Slowest Tauri commands
    const slowCommands = db.prepare(`
      SELECT metric_name as command,
        COUNT(*) as count,
        ROUND(AVG(value)) as avg_ms,
        MAX(value) as max_ms
      FROM performance_events
      WHERE event_type = 'tauri_command'
        AND received_at > datetime('now', '-' || ? || ' days')
      GROUP BY metric_name
      ORDER BY avg_ms DESC
      LIMIT 20
    `).all(days);

    // Daily trend
    const dailyTrend = db.prepare(`
      SELECT DATE(received_at) as date,
        event_type,
        COUNT(*) as count,
        ROUND(AVG(value), 2) as avg_value
      FROM performance_events
      WHERE received_at > datetime('now', '-' || ? || ' days')
      GROUP BY DATE(received_at), event_type
      ORDER BY date
    `).all(days);

    // Web vitals by release
    const byRelease = db.prepare(`
      SELECT app_version, metric_name,
        COUNT(*) as count,
        ROUND(AVG(value), 2) as avg
      FROM performance_events
      WHERE event_type = 'web_vital'
        AND received_at > datetime('now', '-' || ? || ' days')
        AND app_version != ''
      GROUP BY app_version, metric_name
      ORDER BY app_version DESC, metric_name
      LIMIT 50
    `).all(days);

    res.json({
      metrics,
      ratings,
      slowCommands,
      dailyTrend,
      byRelease,
      period: `${days} days`,
    });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error fetching perf stats');
    res.status(500).json({ error: 'Internal server error' });
  }
});

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, index)];
}

export default router;
