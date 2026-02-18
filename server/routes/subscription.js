import express from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { isStripeConfigured } from '../config/stripe.js';
import {
  createCheckoutSession,
  createPortalSession,
  getSubscriptionStatus,
} from '../services/subscriptionService.js';
import {
  verifyAppleMobileSubscription,
  verifyGoogleMobileSubscription,
} from '../services/mobileBillingService.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Allowed redirect URL origins to prevent open redirect attacks
const ALLOWED_REDIRECT_ORIGINS = [
  process.env.FRONTEND_URL,
  'https://midlight.ai',
  'https://www.midlight.ai',
  // Allow localhost for development
  ...(process.env.NODE_ENV !== 'production'
    ? ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173']
    : []),
].filter(Boolean);

/**
 * Validates that a redirect URL is from an allowed origin
 * Prevents open redirect attacks via Stripe checkout
 */
function validateRedirectUrl(url) {
  try {
    const parsed = new URL(url);
    return ALLOWED_REDIRECT_ORIGINS.some((origin) => {
      if (origin === parsed.origin) return true;
      // Support wildcard subdomains if needed
      if (origin.startsWith('*.')) {
        const domain = origin.slice(2);
        return parsed.hostname.endsWith(domain);
      }
      return false;
    });
  } catch {
    return false;
  }
}

// Custom validator for redirect URLs
const isAllowedRedirectUrl = (value) => {
  if (!validateRedirectUrl(value)) {
    throw new Error('Redirect URL origin not allowed');
  }
  return true;
};

/**
 * GET /api/subscription/status
 * Get current user's subscription status
 */
router.get('/status', requireAuth, async (req, res) => {
  try {
    const status = getSubscriptionStatus(req.user.id);
    res.json(status);
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Error getting subscription status');
    res.status(500).json({ error: 'Failed to get subscription status' });
  }
});

/**
 * POST /api/subscription/checkout
 * Create a Stripe Checkout session for upgrading to premium
 */
router.post(
  '/checkout',
  requireAuth,
  [
    body('priceType').isIn(['monthly', 'yearly', 'premium_monthly', 'premium_yearly', 'pro_monthly', 'pro_yearly']).withMessage('Invalid price type'),
    body('successUrl').isURL().withMessage('Invalid success URL').custom(isAllowedRedirectUrl),
    body('cancelUrl').isURL().withMessage('Invalid cancel URL').custom(isAllowedRedirectUrl),
  ],
  async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ error: 'Payment processing is not available' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { priceType, successUrl, cancelUrl } = req.body;

      const session = await createCheckoutSession(
        req.user.id,
        priceType,
        successUrl,
        cancelUrl
      );

      res.json({ url: session.url, sessionId: session.id });
    } catch (error) {
      logger.error({ error: error?.message || error }, 'Error creating checkout session');
      res.status(500).json({ error: 'Failed to create checkout session' });
    }
  }
);

/**
 * POST /api/subscription/portal
 * Create a Stripe Customer Portal session for managing subscription
 */
router.post(
  '/portal',
  requireAuth,
  [
    body('returnUrl').isURL().withMessage('Invalid return URL').custom(isAllowedRedirectUrl),
  ],
  async (req, res) => {
    if (!isStripeConfigured()) {
      return res.status(503).json({ error: 'Payment processing is not available' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { returnUrl } = req.body;
      const session = await createPortalSession(req.user.id, returnUrl);

      res.json({ url: session.url });
    } catch (error) {
      logger.error({ error: error?.message || error }, 'Error creating portal session');

      if (error.message === 'No Stripe customer found for user') {
        return res.status(400).json({ error: 'No active subscription found' });
      }

      res.status(500).json({ error: 'Failed to create portal session' });
    }
  }
);

const mobileAppleValidation = [
  body('productId').isString().trim().notEmpty().withMessage('productId is required'),
  body('transactionId').optional().isString(),
  body('originalTransactionId').optional().isString(),
  body('appAccountToken').optional().isString(),
  body('environment').optional().isIn(['sandbox', 'production']),
  body('expiresAt').optional().isISO8601().withMessage('expiresAt must be an ISO date'),
  body().custom((value) => {
    if (!value.transactionId && !value.originalTransactionId) {
      throw new Error('transactionId or originalTransactionId is required');
    }
    return true;
  }),
];

const mobileGoogleValidation = [
  body('productId').isString().trim().notEmpty().withMessage('productId is required'),
  body('purchaseToken').isString().trim().notEmpty().withMessage('purchaseToken is required'),
  body('packageName').isString().trim().notEmpty().withMessage('packageName is required'),
  body('appAccountToken').optional().isString(),
  body('environment').optional().isIn(['sandbox', 'production']),
  body('expiresAt').optional().isISO8601().withMessage('expiresAt must be an ISO date'),
];

/**
 * POST /api/subscription/mobile/apple/verify
 * Verify StoreKit transaction payload and update entitlement.
 */
router.post('/mobile/apple/verify', requireAuth, mobileAppleValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const result = await verifyAppleMobileSubscription({
      userId: req.user.id,
      body: req.body,
    });
    res.json({ success: true, entitlement: result });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Error verifying Apple mobile subscription');
    const status = Number(error?.status) || 500;
    res.status(status).json({ error: error?.message || 'Failed to verify Apple subscription' });
  }
});

/**
 * POST /api/subscription/mobile/google/verify
 * Verify Play Billing token payload and update entitlement.
 */
router.post('/mobile/google/verify', requireAuth, mobileGoogleValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const result = await verifyGoogleMobileSubscription({
      userId: req.user.id,
      body: req.body,
    });
    res.json({ success: true, entitlement: result });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Error verifying Google mobile subscription');
    const status = Number(error?.status) || 500;
    res.status(status).json({ error: error?.message || 'Failed to verify Google subscription' });
  }
});

/**
 * GET /api/subscription/prices
 * Get available subscription prices (public endpoint)
 */
router.get('/prices', (req, res) => {
  res.json({
    monthly: {
      amount: 2000, // $20.00 in cents
      currency: 'usd',
      interval: 'month',
    },
    yearly: {
      amount: 18000, // $180.00 in cents
      currency: 'usd',
      interval: 'year',
      savings: '25%',
    },
  });
});

export default router;
