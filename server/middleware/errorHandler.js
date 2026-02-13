/**
 * Global Error Handler Middleware
 *
 * Provides centralized error handling for the Express application.
 * - Logs errors with context
 * - Returns appropriate error responses
 * - Hides internal details in production
 */

import { logger } from '../utils/logger.js';

/**
 * Custom application error class for operational errors
 * (errors we anticipate and handle gracefully)
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;

    // Capture stack trace
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Common error factory functions
 */
export const Errors = {
  badRequest: (message = 'Bad request', code = 'BAD_REQUEST') =>
    new AppError(message, 400, code),

  unauthorized: (message = 'Unauthorized', code = 'UNAUTHORIZED') =>
    new AppError(message, 401, code),

  forbidden: (message = 'Forbidden', code = 'FORBIDDEN') =>
    new AppError(message, 403, code),

  notFound: (message = 'Not found', code = 'NOT_FOUND') =>
    new AppError(message, 404, code),

  conflict: (message = 'Conflict', code = 'CONFLICT') =>
    new AppError(message, 409, code),

  tooManyRequests: (message = 'Too many requests', code = 'RATE_LIMITED') =>
    new AppError(message, 429, code),

  internal: (message = 'Internal server error', code = 'INTERNAL_ERROR') =>
    new AppError(message, 500, code),

  serviceUnavailable: (message = 'Service unavailable', code = 'SERVICE_UNAVAILABLE') =>
    new AppError(message, 503, code),
};

/**
 * 404 Not Found handler
 * Must be registered after all routes
 */
export function notFoundHandler(req, res, next) {
  const error = Errors.notFound(`Cannot ${req.method} ${req.path}`);
  next(error);
}

/**
 * Global error handler middleware
 * Must be registered last (after all routes and other middleware)
 */
export function errorHandler(err, req, res, next) {
  // Default values
  let statusCode = err.statusCode || 500;
  let code = err.code || 'INTERNAL_ERROR';
  let message = err.message || 'Something went wrong';

  // Body parser size errors are expected operational errors (e.g. large image attachments).
  if (err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413) {
    statusCode = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request payload too large. Try fewer images or smaller files.';
    err.isOperational = true;
  }

  // Log error with context
  const errorLog = {
    error: message,
    code,
    statusCode,
    path: req.path,
    method: req.method,
    userId: req.user?.id,
    requestId: req.requestId,
  };

  // Include stack trace for non-operational errors
  if (!err.isOperational) {
    errorLog.stack = err.stack;
    logger.error(errorLog, 'Unexpected error');
  } else {
    // Operational errors are expected, log at warn level
    logger.warn(errorLog, 'Operational error');
  }

  // Don't leak error details in production for unexpected errors
  if (process.env.NODE_ENV === 'production' && !err.isOperational) {
    message = 'Something went wrong';
    code = 'INTERNAL_ERROR';
  }

  // Send error response
  res.status(statusCode).json({
    status: 'error',
    code,
    message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
}

/**
 * Async handler wrapper to catch async errors
 * Usage: router.get('/path', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Process-level error handlers for uncaught exceptions and rejections
 * Call this once during app initialization
 */
export function setupProcessErrorHandlers() {
  process.on('unhandledRejection', (reason, promise) => {
    logger.fatal({
      type: 'unhandledRejection',
      reason: reason instanceof Error ? reason.message : reason,
      stack: reason instanceof Error ? reason.stack : undefined,
    }, 'Unhandled Promise Rejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({
      type: 'uncaughtException',
      error: error.message,
      stack: error.stack,
    }, 'Uncaught Exception - shutting down');

    // Give time for logging, then exit
    // PM2 will restart the process
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  });
}
