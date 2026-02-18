import { verifyAccessToken } from '../services/tokenService.js';
import { findUserById, getUserSubscription } from '../services/authService.js';

function parseClientContext(req) {
  const client = String(req.headers['x-midlight-client'] || 'web').toLowerCase();
  const platform = String(req.headers['x-midlight-platform'] || client).toLowerCase();
  const appVersion = req.headers['x-midlight-app-version'] || null;
  const buildChannel = req.headers['x-midlight-build-channel'] || null;
  const networkState = req.headers['x-midlight-network-state'] || null;
  const isNative = ['ios', 'android', 'mobile', 'native'].includes(client)
    || ['ios', 'android'].includes(platform);

  return {
    client,
    platform,
    appVersion,
    buildChannel,
    networkState,
    isNative,
  };
}

function getBearerToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.split(' ')[1];
}

export function requireAuth(req, res, next) {
  req.authContext = parseClientContext(req);
  const token = getBearerToken(req.headers.authorization);

  if (!token) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const decoded = verifyAccessToken(token);

  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const user = findUserById(decoded.userId);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }

  req.user = user;
  next();
}

export function optionalAuth(req, res, next) {
  req.authContext = parseClientContext(req);
  const token = getBearerToken(req.headers.authorization);

  if (!token) {
    req.user = null;
    return next();
  }
  const decoded = verifyAccessToken(token);

  if (decoded) {
    const user = findUserById(decoded.userId);
    req.user = user || null;
  } else {
    req.user = null;
  }

  next();
}

export function requireSubscription(tier) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authorization required' });
    }

    const subscription = getUserSubscription(req.user.id);

    if (tier === 'premium' && subscription.tier !== 'premium') {
      return res.status(403).json({
        error: 'Premium subscription required',
        currentTier: subscription.tier
      });
    }

    if (subscription.status !== 'active') {
      return res.status(403).json({
        error: 'Active subscription required',
        status: subscription.status
      });
    }

    req.subscription = subscription;
    next();
  };
}

export function attachSubscription(req, res, next) {
  if (req.user) {
    req.subscription = getUserSubscription(req.user.id);
  }
  next();
}

/**
 * Require Pro or Premium subscription (paid tier)
 * Use for features like skill submission to marketplace
 */
export function requirePro(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const subscription = req.subscription || getUserSubscription(req.user.id);
  const isPaidTier = subscription.tier === 'pro' || subscription.tier === 'premium';
  const isActive = subscription.status === 'active' || subscription.status === 'trialing';

  if (!isPaidTier || !isActive) {
    return res.status(403).json({
      error: 'Pro subscription required',
      currentTier: subscription.tier,
      status: subscription.status,
    });
  }

  req.subscription = subscription;
  next();
}
