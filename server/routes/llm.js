import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { requireAuth, attachSubscription } from '../middleware/auth.js';
import {
  chat,
  chatWithTools,
  chatWithToolsStream,
  embed,
  getAvailableModels,
  isModelAllowed,
  getProviderStatus
} from '../services/llm/index.js';
import { checkQuota, getUsageStats, getRateLimit } from '../services/llm/quotaManager.js';
import { logger } from '../utils/logger.js';

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
  body('provider').isIn(['openai', 'anthropic', 'gemini', 'kimi']).withMessage('Invalid provider'),
  body('model').notEmpty().withMessage('Model required'),
  body('messages').isArray({ min: 1 }).withMessage('Messages array required'),
  body('messages.*.role').isIn(['system', 'user', 'assistant', 'tool']).withMessage('Invalid message role'),
  // Content can be a string or array (for multimodal/vision messages)
  body('messages.*.content').custom((value) => {
    if (typeof value === 'string' || Array.isArray(value) || value === null) return true;
    throw new Error('Content must be string, array, or null');
  }),
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
      requestType = 'chat',
      webSearchEnabled = false,
      effortLane = null,
      promptVersion = null,
      promptVariant = null
    } = req.body;

    // Check if model is allowed for user's tier
    const userTier = req.subscription?.tier || 'free';
    if (!isModelAllowed(model, userTier)) {
      logger.warn({ model, userTier, userId: req.user.id }, 'Model not allowed for tier');
      return res.status(403).json({
        code: 'MODEL_NOT_ALLOWED',
        error: 'Model not available for your subscription tier',
        tier: userTier,
        requestedModel: model
      });
    }

    if (stream) {
      // Server-Sent Events for streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      res.flushHeaders();

      try {
        const streamResponse = await chat({
          userId: req.user.id,
          provider,
          model,
          messages,
          temperature,
          maxTokens,
          stream: true,
          requestType,
          webSearchEnabled,
          userTier,
          effortLane,
          promptVersion,
          promptVariant
        });

        for await (const chunk of streamResponse) {
          if (chunk.type === 'chunk') {
            res.write(`data: ${JSON.stringify({ content: chunk.content })}\n\n`);
          } else if (chunk.type === 'thinking') {
            res.write(`data: ${JSON.stringify({ type: 'thinking', thinking: chunk.thinking })}\n\n`);
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
        requestType,
        webSearchEnabled,
        userTier,
        effortLane,
        promptVersion,
        promptVariant
      });

      res.json(response);
    }
  } catch (error) {
    logger.error({ error: error?.message || error }, 'LLM chat error');

    if (error.code === 'QUOTA_EXCEEDED') {
      return res.status(429).json({
        error: 'Monthly quota exceeded',
        quota: error.quota
      });
    }

    res.status(500).json({ error: 'Chat request failed' });
  }
});

// POST /api/llm/chat-with-tools - Chat with function calling (streaming and non-streaming)
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
      stream = false,
      webSearchEnabled = false,
      effortLane = null,
      promptVersion = null,
      promptVariant = null
    } = req.body;

    // Check if model is allowed
    const userTier = req.subscription?.tier || 'free';
    if (!isModelAllowed(model, userTier)) {
      logger.warn({ model, userTier, userId: req.user.id }, 'Model not allowed for tier');
      return res.status(403).json({
        code: 'MODEL_NOT_ALLOWED',
        error: 'Model not available for your subscription tier',
        tier: userTier,
        requestedModel: model
      });
    }

    if (stream) {
      // Streaming SSE response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      try {
        const reqStart = Date.now();
        console.log(`[LLM Route] chat-with-tools stream request: provider=${provider}, model=${model}`);
        const streamResult = await chatWithToolsStream({
          userId: req.user.id,
          provider,
          model,
          messages,
          tools,
          temperature,
          maxTokens,
          webSearchEnabled,
          userTier,
          effortLane,
          promptVersion,
          promptVariant
        });
        console.log(`[LLM Route] Stream setup complete: ${Date.now() - reqStart}ms`);

        let firstChunkSent = false;
        for await (const chunk of streamResult.stream) {
          if (!firstChunkSent) {
            console.log(`[LLM Route] First chunk to client: ${Date.now() - reqStart}ms (type: ${chunk.type})`);
            firstChunkSent = true;
          }
          if (chunk.type === 'content') {
            res.write(`data: ${JSON.stringify({ type: 'content', content: chunk.content })}\n\n`);
          } else if (chunk.type === 'thinking') {
            res.write(`data: ${JSON.stringify({ type: 'thinking', thinking: chunk.thinking })}\n\n`);
          } else if (chunk.type === 'tool_call') {
            res.write(`data: ${JSON.stringify({ type: 'tool_call', toolCall: chunk.toolCall })}\n\n`);
          } else if (chunk.type === 'done') {
            // Send sources if available
            if (streamResult.sources && streamResult.sources.length > 0) {
              res.write(`data: ${JSON.stringify({ type: 'sources', sources: streamResult.sources })}\n\n`);
            }
            res.write(`data: ${JSON.stringify({
              type: 'done',
              finishReason: chunk.finishReason,
              usage: chunk.usage
            })}\n\n`);
          }
        }

        res.write('data: [DONE]\n\n');
        res.end();
      } catch (error) {
        if (error.code === 'QUOTA_EXCEEDED') {
          res.write(`data: ${JSON.stringify({ type: 'error', error: 'quota_exceeded', quota: error.quota })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
        }
        res.end();
      }
    } else {
      // Non-streaming response
      const response = await chatWithTools({
        userId: req.user.id,
        provider,
        model,
        messages,
        tools,
        temperature,
        maxTokens,
        webSearchEnabled,
        userTier,
        effortLane,
        promptVersion,
        promptVariant
      });

      res.json(response);
    }
  } catch (error) {
    logger.error({ error: error?.message || error }, 'LLM tools error');

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
    logger.error({ error: error?.message || error }, 'Get models error');
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
      remaining: quota.remaining,
      resetsAt: quota.resetsAt
    });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Get quota error');
    res.status(500).json({ error: 'Failed to get quota' });
  }
});

// GET /api/llm/usage - Get detailed usage stats
router.get('/usage', (req, res) => {
  try {
    const stats = getUsageStats(req.user.id);
    res.json(stats);
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Get usage error');
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
    logger.error({ error: error?.message || error }, 'Get status error');
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// POST /api/llm/embed - Generate embeddings for text
const embedValidation = [
  body('texts').isArray({ min: 1, max: 100 }).withMessage('Texts array required (1-100 items)'),
  body('texts.*').isString().isLength({ min: 1, max: 32000 }).withMessage('Each text must be 1-32000 chars')
];

router.post('/embed', embedValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { texts } = req.body;

    const result = await embed({
      userId: req.user.id,
      texts
    });

    res.json(result);
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Embed error');

    if (error.code === 'QUOTA_EXCEEDED') {
      return res.status(429).json({
        error: 'Monthly quota exceeded',
        quota: error.quota
      });
    }

    res.status(500).json({ error: 'Embedding request failed' });
  }
});

// Page fetch cache (in-memory, 15 min TTL)
const pageCache = new Map();
const PAGE_CACHE_TTL_MS = 15 * 60 * 1000;

function getCachedPage(url) {
  const entry = pageCache.get(url);
  if (entry && Date.now() - entry.timestamp < PAGE_CACHE_TTL_MS) {
    return entry.data;
  }
  if (entry) pageCache.delete(url);
  return null;
}

function setCachedPage(url, data) {
  pageCache.set(url, { data, timestamp: Date.now() });
  // Evict old entries if cache grows too large
  if (pageCache.size > 200) {
    const now = Date.now();
    for (const [key, val] of pageCache) {
      if (now - val.timestamp > PAGE_CACHE_TTL_MS) pageCache.delete(key);
    }
  }
}

// POST /api/llm/fetch-page - Fetch and extract readable content from a URL
const fetchPageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many page fetch requests. Max 10 per minute.' },
  keyGenerator: (req) => req.user.id.toString()
});

function isBlockedUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    // Strip brackets from IPv6 hostnames (URL parser keeps them)
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    // Block non-http(s) schemes
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;

    // Block localhost variants
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1') return true;

    // Block .local and .internal domains
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;

    // Block cloud metadata endpoints
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') return true;

    // Block private IPv4 ranges (10.x, 172.16-31.x, 192.168.x)
    const parts = hostname.split('.').map(Number);
    if (parts.length === 4 && parts.every(p => !isNaN(p))) {
      if (parts[0] === 10) return true;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      if (parts[0] === 192 && parts[1] === 168) return true;
    }

    // Block IPv6 link-local (fe80::/10)
    if (hostname.startsWith('fe80:') || hostname.startsWith('fe80')) return true;

    // Block IPv6 unique-local (fc00::/7 — fc and fd prefixes)
    if (hostname.startsWith('fc') || hostname.startsWith('fd')) return true;

    // Block IPv4-mapped IPv6 (::ffff:x.x.x.x) with private IPv4
    if (hostname.startsWith('::ffff:')) {
      const mappedIp = hostname.slice(7); // strip "::ffff:"
      const mappedParts = mappedIp.split('.').map(Number);
      if (mappedParts.length === 4 && mappedParts.every(p => !isNaN(p))) {
        if (mappedParts[0] === 127) return true;
        if (mappedParts[0] === 10) return true;
        if (mappedParts[0] === 172 && mappedParts[1] >= 16 && mappedParts[1] <= 31) return true;
        if (mappedParts[0] === 192 && mappedParts[1] === 168) return true;
        if (mappedParts[0] === 169 && mappedParts[1] === 254) return true;
        if (mappedParts[0] === 0) return true;
      }
    }

    return false;
  } catch { return true; }
}

router.post('/fetch-page', [
  body('url').isURL().withMessage('Valid URL required')
], fetchPageLimiter, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { url } = req.body;

    if (isBlockedUrl(url)) {
      return res.status(400).json({ error: 'URL not allowed: internal or private addresses are blocked' });
    }

    // Check cache first
    const cached = getCachedPage(url);
    if (cached) {
      return res.json(cached);
    }

    // Fetch the URL with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'Midlight/1.0 (Document Editor; +https://midlight.ai)',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });
      clearTimeout(timeout);

      // Handle redirects: validate the Location header before following
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return res.status(502).json({ error: 'Redirect with no Location header' });
        }
        const redirectUrl = new URL(location, url).href;
        if (isBlockedUrl(redirectUrl)) {
          return res.status(400).json({ error: 'Redirect target is a blocked URL' });
        }
        return res.status(400).json({ error: 'Redirects are not followed. Target: ' + redirectUrl });
      }

      if (!response.ok) {
        return res.status(502).json({ error: `Failed to fetch URL: ${response.status} ${response.statusText}` });
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) {
        return res.status(413).json({ error: 'Page too large (>5MB)' });
      }

      const html = await response.text();
      if (html.length > 5 * 1024 * 1024) {
        return res.status(413).json({ error: 'Page content too large (>5MB)' });
      }

      // Use JSDOM + Readability to extract content
      const { JSDOM } = await import('jsdom');
      const { Readability } = await import('@mozilla/readability');

      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (!article) {
        return res.status(422).json({ error: 'Could not extract readable content from the page' });
      }

      // Convert to plain text (strip HTML tags from article.content)
      const textContent = article.textContent || '';
      const wordCount = textContent.split(/\s+/).filter(Boolean).length;

      const result = {
        url,
        title: article.title || '',
        content: textContent.substring(0, 100000), // Cap at 100k chars
        wordCount,
      };
      setCachedPage(url, result);
      res.json(result);
    } catch (fetchError) {
      clearTimeout(timeout);
      if (fetchError.name === 'AbortError') {
        return res.status(504).json({ error: 'URL fetch timed out (10s limit)' });
      }
      throw fetchError;
    }
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Fetch page error');
    res.status(500).json({ error: 'Failed to fetch page' });
  }
});

export default router;
