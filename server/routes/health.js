/**
 * Health Check Routes
 *
 * Provides endpoints for monitoring and orchestration tools to verify
 * the server is running and its dependencies are healthy.
 *
 * Endpoints:
 * - GET /health - Basic liveness check (is the process running?)
 * - GET /health/ready - Readiness check (are all dependencies healthy?)
 */

import express from 'express';
import db from '../db/index.js';
import { getProviderStatus } from '../services/llm/index.js';
import { getGuardrailMetrics } from '../services/llm/guardrailMetrics.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * Basic liveness check
 * Returns 200 if the server is running.
 * Used by load balancers and container orchestrators.
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

/**
 * Deep readiness check
 * Verifies all critical dependencies are available.
 * Returns 503 if any dependency is unhealthy.
 */
router.get('/health/ready', async (req, res) => {
  const checks = {
    database: { status: 'unknown', latency: null },
    llmProviders: { status: 'unknown', providers: {} },
  };

  let allHealthy = true;

  // Check database connectivity
  try {
    const start = Date.now();
    db.prepare('SELECT 1').get();
    checks.database = {
      status: 'healthy',
      latency: Date.now() - start,
    };
  } catch (error) {
    checks.database = {
      status: 'unhealthy',
      error: error.message,
    };
    allHealthy = false;
    logger.error({ error: error.message }, 'Health check: Database unhealthy');
  }

  // Check LLM provider status (just config, not actual API calls)
  try {
    const providers = getProviderStatus();
    checks.llmProviders = {
      status: 'healthy',
      providers,
    };
  } catch (error) {
    checks.llmProviders = {
      status: 'degraded',
      error: error.message,
    };
    // LLM providers being unavailable is degraded, not unhealthy
    logger.warn({ error: error.message }, 'Health check: LLM providers degraded');
  }

  const statusCode = allHealthy ? 200 : 503;
  const overallStatus = allHealthy ? 'healthy' : 'unhealthy';

  res.status(statusCode).json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || 'unknown',
    node: process.version,
    checks,
  });
});

/**
 * Metrics endpoint (optional, for Prometheus-style monitoring)
 * Returns basic metrics in a simple format.
 */
router.get('/health/metrics', (req, res) => {
  const memoryUsage = process.memoryUsage();
  const llmGuardrails = getGuardrailMetrics();

  res.json({
    uptime: process.uptime(),
    memory: {
      heapUsed: memoryUsage.heapUsed,
      heapTotal: memoryUsage.heapTotal,
      rss: memoryUsage.rss,
      external: memoryUsage.external,
    },
    cpu: process.cpuUsage(),
    llmGuardrails,
    timestamp: new Date().toISOString(),
  });
});

export default router;
