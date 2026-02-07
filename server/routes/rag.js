/**
 * RAG Routes
 * Handles server-side RAG (Retrieval-Augmented Generation) for the web app.
 * Provides incremental indexing, hybrid search, and index management.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, attachSubscription } from '../middleware/auth.js';
import {
  indexProject,
  search,
  getStatus,
  deleteIndex,
  getProjectTokenEstimate,
} from '../services/ragService.js';
import { logger } from '../utils/logger.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);
router.use(attachSubscription);

// Block free tier users - RAG is a premium feature
router.use((req, res, next) => {
  const tier = req.subscription?.tier || 'free';
  if (tier === 'free') {
    return res.status(403).json({
      error: 'RAG search requires a premium subscription',
      code: 'RAG_REQUIRES_PREMIUM',
      upgrade_url: '/upgrade',
    });
  }
  next();
});

// Rate limiter: 10 requests per minute per user
const ragRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => `rag:${req.user?.id || req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RAG rate limit exceeded. Please slow down.' },
});

router.use(ragRateLimiter);

// POST /api/rag/index - Trigger incremental indexing of user's synced documents
router.post('/index', async (req, res) => {
  try {
    const userId = req.user.id;
    const { force = false } = req.body || {};

    const status = await indexProject(userId, { force });

    res.json(status);
  } catch (error) {
    if (error.code === 'INDEXING_IN_PROGRESS') {
      return res.status(409).json({
        error: 'Indexing is already in progress',
        code: 'INDEXING_IN_PROGRESS',
      });
    }

    logger.error({ error: error?.message || error, userId: req.user.id }, 'RAG index error');
    res.status(500).json({ error: 'Failed to index documents' });
  }
});

// POST /api/rag/search - Hybrid search (vector + BM25)
router.post('/search', async (req, res) => {
  try {
    const userId = req.user.id;
    const { query, topK, minScore } = req.body || {};

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: 'Query is required and must be a non-empty string' });
    }

    const safeTopK = Math.min(Math.max(parseInt(topK) || 5, 1), 20);
    const safeMinScore = Math.min(Math.max(parseFloat(minScore) || 0.1, 0), 1);

    const results = await search(userId, query, { topK: safeTopK, minScore: safeMinScore });

    res.json({ results });
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'RAG search error');
    res.status(500).json({ error: 'Failed to search documents' });
  }
});

// GET /api/rag/status - Get RAG index status
router.get('/status', async (req, res) => {
  try {
    const userId = req.user.id;

    const status = await getStatus(userId);

    res.json(status);
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'RAG status error');
    res.status(500).json({ error: 'Failed to get RAG index status' });
  }
});

// DELETE /api/rag/index - Delete user's RAG index
router.delete('/index', async (req, res) => {
  try {
    const userId = req.user.id;

    await deleteIndex(userId);

    res.json({ success: true });
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'RAG delete index error');
    res.status(500).json({ error: 'Failed to delete RAG index' });
  }
});

// GET /api/rag/token-estimate - Get estimated token count for user's documents
router.get('/token-estimate', async (req, res) => {
  try {
    const userId = req.user.id;

    const tokenEstimate = await getProjectTokenEstimate(userId);

    res.json({ tokenEstimate });
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'RAG token estimate error');
    res.status(500).json({ error: 'Failed to get token estimate' });
  }
});

export default router;
