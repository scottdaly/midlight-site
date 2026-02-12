import rateLimit from 'express-rate-limit';

export const shareLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,
  message: { error: 'Too many share requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
