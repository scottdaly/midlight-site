import express from 'express';
import { stripe, STRIPE_WEBHOOK_SECRET, isStripeConfigured } from '../config/stripe.js';
import {
  handleSubscriptionUpdate,
  handleSubscriptionDeleted,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
} from '../services/subscriptionService.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * POST /api/stripe-webhook
 * Handle Stripe webhook events
 * NOTE: This endpoint receives raw body, not JSON parsed
 */
router.post('/', async (req, res) => {
  if (!isStripeConfigured()) {
    return res.status(503).json({ error: 'Payment processing is not available' });
  }

  const sig = req.headers['stripe-signature'];

  if (!sig) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Webhook signature verification failed');
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        logger.info({ sessionId: session.id }, 'Checkout session completed');
        // Subscription will be handled by customer.subscription.created
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        logger.info({ eventType: event.type, subscriptionId: subscription.id }, 'Subscription event');
        handleSubscriptionUpdate(subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        logger.info({ subscriptionId: subscription.id }, 'Subscription deleted');
        handleSubscriptionDeleted(subscription);
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        logger.info({ invoiceId: invoice.id }, 'Invoice paid');
        handleInvoicePaid(invoice);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        logger.info({ invoiceId: invoice.id }, 'Invoice payment failed');
        handleInvoicePaymentFailed(invoice);
        break;
      }

      default:
        logger.info({ eventType: event.type }, 'Unhandled event type');
    }

    res.json({ received: true });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Error processing webhook');
    // Still return 200 to prevent Stripe from retrying
    // Log the error for investigation
    res.json({ received: true, error: error.message });
  }
});

export default router;
