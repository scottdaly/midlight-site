import express from 'express';
import { stripe, STRIPE_WEBHOOK_SECRET, isStripeConfigured } from '../config/stripe.js';
import {
  handleSubscriptionUpdate,
  handleSubscriptionDeleted,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
} from '../services/subscriptionService.js';
import { logger } from '../utils/logger.js';
import db from '../db/index.js';

const router = express.Router();

const logBillingEventStmt = db.prepare(`
  INSERT OR IGNORE INTO billing_events (stripe_event_id, event_type, user_id, stripe_customer_id, data_summary)
  VALUES (?, ?, ?, ?, ?)
`);

function logBillingEvent(event) {
  try {
    const obj = event.data.object;
    const userId = obj.metadata?.user_id ? parseInt(obj.metadata.user_id, 10) : null;
    const customerId = obj.customer || null;
    const summary = {};

    if (obj.status) summary.status = obj.status;
    if (obj.plan?.interval) summary.interval = obj.plan.interval;
    if (obj.amount_paid != null) summary.amountPaid = obj.amount_paid;
    if (obj.amount_due != null) summary.amountDue = obj.amount_due;
    if (obj.currency) summary.currency = obj.currency;
    if (obj.items?.data?.[0]?.price?.lookup_key) summary.tier = obj.items.data[0].price.lookup_key;

    logBillingEventStmt.run(
      event.id,
      event.type,
      userId,
      customerId,
      JSON.stringify(summary)
    );
  } catch (err) {
    logger.warn({ error: err?.message, eventId: event.id }, 'Failed to log billing event');
  }
}

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

    // Log all webhook events for audit trail
    logBillingEvent(event);

    res.json({ received: true });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Error processing webhook');
    // Still return 200 to prevent Stripe from retrying
    // Error is already logged above for investigation
    res.json({ received: true });
  }
});

export default router;
