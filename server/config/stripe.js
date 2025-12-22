import Stripe from 'stripe';

// Initialize Stripe with secret key
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey && process.env.NODE_ENV === 'production') {
  throw new Error('STRIPE_SECRET_KEY must be set in production');
}

export const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' })
  : null;

// Stripe price IDs for subscription tiers
export const STRIPE_PRICES = {
  premium_monthly: process.env.STRIPE_PRICE_MONTHLY,
  premium_yearly: process.env.STRIPE_PRICE_YEARLY,
};

// Webhook secret for verifying Stripe events
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Helper to check if Stripe is configured
export function isStripeConfigured() {
  return stripe !== null;
}

// Map Stripe price IDs to internal tier names
export function getPlanFromPriceId(priceId) {
  if (priceId === STRIPE_PRICES.premium_monthly || priceId === STRIPE_PRICES.premium_yearly) {
    return 'premium';
  }
  return 'free';
}

// Get billing interval from price ID
export function getBillingInterval(priceId) {
  if (priceId === STRIPE_PRICES.premium_yearly) {
    return 'yearly';
  }
  return 'monthly';
}
