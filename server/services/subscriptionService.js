import { stripe, STRIPE_PRICES, getPlanFromPriceId, getBillingInterval } from '../config/stripe.js';
import db from '../db/index.js';

/**
 * Get or create a Stripe customer for a user
 */
export async function getOrCreateStripeCustomer(userId) {
  // Get user info
  const user = db.prepare('SELECT id, email, display_name, stripe_customer_id FROM users WHERE id = ?').get(userId);

  if (!user) {
    throw new Error('User not found');
  }

  // If user already has a Stripe customer ID, return it
  if (user.stripe_customer_id) {
    return user.stripe_customer_id;
  }

  // Create a new Stripe customer
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.display_name || undefined,
    metadata: {
      user_id: userId.toString(),
    },
  });

  // Save customer ID to user record
  db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customer.id, userId);

  return customer.id;
}

/**
 * Create a Stripe Checkout session for subscription
 */
export async function createCheckoutSession(userId, priceType = 'monthly', successUrl, cancelUrl) {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  const priceId = priceType === 'yearly'
    ? STRIPE_PRICES.premium_yearly
    : STRIPE_PRICES.premium_monthly;

  if (!priceId) {
    throw new Error(`Stripe price ID not configured for ${priceType} plan`);
  }

  const customerId = await getOrCreateStripeCustomer(userId);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      user_id: userId.toString(),
    },
    subscription_data: {
      metadata: {
        user_id: userId.toString(),
      },
    },
    // Allow promotion codes
    allow_promotion_codes: true,
  });

  return session;
}

/**
 * Create a Stripe Customer Portal session
 */
export async function createPortalSession(userId, returnUrl) {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }

  const user = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(userId);

  if (!user?.stripe_customer_id) {
    throw new Error('No Stripe customer found for user');
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: returnUrl,
  });

  return session;
}

/**
 * Handle subscription created/updated from Stripe webhook
 */
export function handleSubscriptionUpdate(subscription) {
  const userId = subscription.metadata?.user_id;

  if (!userId) {
    console.error('No user_id in subscription metadata:', subscription.id);
    return false;
  }

  const priceId = subscription.items?.data?.[0]?.price?.id;
  const tier = getPlanFromPriceId(priceId);
  const billingInterval = getBillingInterval(priceId);

  // Map Stripe status to our status
  let status = 'active';
  if (subscription.status === 'canceled' || subscription.status === 'unpaid') {
    status = 'cancelled';
  } else if (subscription.status === 'past_due') {
    status = 'past_due';
  } else if (subscription.status === 'trialing') {
    status = 'trialing';
  }

  const currentPeriodStart = new Date(subscription.current_period_start * 1000).toISOString();
  const currentPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();

  // Update subscription in database
  const result = db.prepare(`
    UPDATE subscriptions
    SET tier = ?,
        status = ?,
        stripe_subscription_id = ?,
        billing_interval = ?,
        current_period_start = ?,
        current_period_end = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(
    tier,
    status,
    subscription.id,
    billingInterval,
    currentPeriodStart,
    currentPeriodEnd,
    parseInt(userId)
  );

  console.log(`Updated subscription for user ${userId}: tier=${tier}, status=${status}`);

  return result.changes > 0;
}

/**
 * Handle subscription deleted (cancelled) from Stripe webhook
 */
export function handleSubscriptionDeleted(subscription) {
  const userId = subscription.metadata?.user_id;

  if (!userId) {
    console.error('No user_id in subscription metadata:', subscription.id);
    return false;
  }

  // Downgrade to free tier
  const result = db.prepare(`
    UPDATE subscriptions
    SET tier = 'free',
        status = 'cancelled',
        stripe_subscription_id = NULL,
        billing_interval = NULL,
        current_period_start = NULL,
        current_period_end = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(parseInt(userId));

  console.log(`Cancelled subscription for user ${userId}, downgraded to free`);

  return result.changes > 0;
}

/**
 * Handle successful invoice payment
 */
export function handleInvoicePaid(invoice) {
  const subscriptionId = invoice.subscription;

  if (!subscriptionId) {
    return false;
  }

  // Just log for now - subscription update webhook will handle the actual update
  console.log(`Invoice paid for subscription ${subscriptionId}`);

  return true;
}

/**
 * Handle failed invoice payment
 */
export function handleInvoicePaymentFailed(invoice) {
  const subscriptionId = invoice.subscription;
  const customerId = invoice.customer;

  // Find user by Stripe customer ID
  const user = db.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(customerId);

  if (!user) {
    console.error('No user found for Stripe customer:', customerId);
    return false;
  }

  // Update subscription status to past_due
  const result = db.prepare(`
    UPDATE subscriptions
    SET status = 'past_due',
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(user.id);

  console.log(`Payment failed for user ${user.id}, marked as past_due`);

  return result.changes > 0;
}

/**
 * Get subscription status for a user
 */
export function getSubscriptionStatus(userId) {
  const subscription = db.prepare(`
    SELECT tier, status, billing_interval, current_period_start, current_period_end, stripe_subscription_id
    FROM subscriptions
    WHERE user_id = ?
  `).get(userId);

  if (!subscription) {
    return {
      tier: 'free',
      status: 'active',
      billingInterval: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      hasStripeSubscription: false,
    };
  }

  return {
    tier: subscription.tier,
    status: subscription.status,
    billingInterval: subscription.billing_interval,
    currentPeriodStart: subscription.current_period_start,
    currentPeriodEnd: subscription.current_period_end,
    hasStripeSubscription: !!subscription.stripe_subscription_id,
  };
}

/**
 * Check if user has active premium subscription
 */
export function isPremiumUser(userId) {
  const subscription = getSubscriptionStatus(userId);
  return subscription.tier === 'premium' &&
         (subscription.status === 'active' || subscription.status === 'trialing');
}
