import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { requireAuth, attachSubscription } from '../middleware/auth.js';
import {
  chat,
  chatWithTools,
  getAvailableModels,
  isModelAllowed,
  getProviderStatus
} from '../services/llm/index.js';
import { checkQuota, getUsageStats, getRateLimit } from '../services/llm/quotaManager.js';

const router = Router();

// All LLM routes require authentication
router.use(requireAuth);
router.use(attachSubscription);

// Dynamic rate limiter based on subscription tier
const llmRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: (req) => getRateLimit(req.subscription?.tier || 'free'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
  keyGenerator: (req) => req.user.id.toString()
});

router.use(llmRateLimiter);

// Validation middleware
const chatValidation = [
  body('provider').isIn(['openai', 'anthropic', 'gemini']).withMessage('Invalid provider'),
  body('model').notEmpty().withMessage('Model required'),
  body('messages').isArray({ min: 1 }).withMessage('Messages array required'),
  body('messages.*.role').isIn(['system', 'user', 'assistant']).withMessage('Invalid message role'),
  body('messages.*.content').notEmpty().withMessage('Message content required'),
  body('temperature').optional().isFloat({ min: 0, max: 2 }),
  body('maxTokens').optional().isInt({ min: 1, max: 32000 }),
  body('stream').optional().isBoolean()
];

// POST /api/llm/chat - Main chat endpoint
router.post('/chat', chatValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      provider,
      model,
      messages,
      temperature = 0.7,
      maxTokens = 4096,
      stream = false,
      requestType = 'chat'
    } = req.body;

    // Check if model is allowed for user's tier
    if (!isModelAllowed(model, req.subscription.tier)) {
      return res.status(403).json({
        error: 'Model not available for your subscription tier',
        tier: req.subscription.tier
      });
    }

    if (stream) {
      // Server-Sent Events for streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

      try {
        const streamResponse = await chat({
          userId: req.user.id,
          provider,
          model,
          messages,
          temperature,
          maxTokens,
          stream: true,
          requestType
        });

        for await (const chunk of streamResponse) {
          if (chunk.type === 'chunk') {
            res.write(`data: ${JSON.stringify({ content: chunk.content })}\n\n`);
          } else if (chunk.type === 'done') {
            res.write(`data: ${JSON.stringify({
              done: true,
              usage: chunk.usage
            })}\n\n`);
          }
        }

        res.write('data: [DONE]\n\n');
        res.end();
      } catch (error) {
        if (error.code === 'QUOTA_EXCEEDED') {
          res.write(`data: ${JSON.stringify({ error: 'quota_exceeded', quota: error.quota })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        }
        res.end();
      }
    } else {
      // Non-streaming response
      const response = await chat({
        userId: req.user.id,
        provider,
        model,
        messages,
        temperature,
        maxTokens,
        stream: false,
        requestType
      });

      res.json(response);
    }
  } catch (error) {
    console.error('LLM chat error:', error);

    if (error.code === 'QUOTA_EXCEEDED') {
      return res.status(429).json({
        error: 'Monthly quota exceeded',
        quota: error.quota
      });
    }

    res.status(500).json({ error: 'Chat request failed' });
  }
});

// POST /api/llm/chat-with-tools - Chat with function calling
router.post('/chat-with-tools', [
  ...chatValidation,
  body('tools').isArray({ min: 1 }).withMessage('Tools array required'),
  body('tools.*.name').notEmpty().withMessage('Tool name required'),
  body('tools.*.description').notEmpty().withMessage('Tool description required'),
  body('tools.*.parameters').isObject().withMessage('Tool parameters required'),
  body('webSearchEnabled').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      provider,
      model,
      messages,
      tools,
      temperature = 0.7,
      maxTokens = 4096,
      webSearchEnabled = false
    } = req.body;

    // Check if model is allowed
    if (!isModelAllowed(model, req.subscription.tier)) {
      return res.status(403).json({
        error: 'Model not available for your subscription tier',
        tier: req.subscription.tier
      });
    }

    const response = await chatWithTools({
      userId: req.user.id,
      provider,
      model,
      messages,
      tools,
      temperature,
      maxTokens,
      webSearchEnabled
    });

    res.json(response);
  } catch (error) {
    console.error('LLM tools error:', error);

    if (error.code === 'QUOTA_EXCEEDED') {
      return res.status(429).json({
        error: 'Monthly quota exceeded',
        quota: error.quota
      });
    }

    res.status(500).json({ error: error.message || 'Chat with tools failed' });
  }
});

// GET /api/llm/models - Get available models
router.get('/models', (req, res) => {
  try {
    const models = getAvailableModels(req.subscription.tier);
    const status = getProviderStatus();

    res.json({
      models,
      providers: status,
      tier: req.subscription.tier
    });
  } catch (error) {
    console.error('Get models error:', error);
    res.status(500).json({ error: 'Failed to get models' });
  }
});

// GET /api/llm/quota - Get current quota status
router.get('/quota', async (req, res) => {
  try {
    const quota = await checkQuota(req.user.id);

    res.json({
      tier: quota.tier,
      limit: quota.limit,
      used: quota.used,
      remaining: quota.remaining
    });
  } catch (error) {
    console.error('Get quota error:', error);
    res.status(500).json({ error: 'Failed to get quota' });
  }
});

// GET /api/llm/usage - Get detailed usage stats
router.get('/usage', (req, res) => {
  try {
    const stats = getUsageStats(req.user.id);
    res.json(stats);
  } catch (error) {
    console.error('Get usage error:', error);
    res.status(500).json({ error: 'Failed to get usage stats' });
  }
});

// GET /api/llm/status - Check LLM service status
router.get('/status', (req, res) => {
  try {
    const providers = getProviderStatus();

    res.json({
      status: providers.openai || providers.anthropic ? 'operational' : 'degraded',
      providers
    });
  } catch (error) {
    console.error('Get status error:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

export default router;
