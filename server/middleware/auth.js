import { verifyAccessToken } from '../services/tokenService.js';
import { findUserById, getUserSubscription } from '../services/authService.js';

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const token = authHeader.split(' ')[1];
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
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];
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
