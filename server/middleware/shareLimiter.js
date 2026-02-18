import rateLimit from 'express-rate-limit';

export const shareLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // 300 requests per 15 minutes (supports E2E test runs)
  message: { error: 'Too many share requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
