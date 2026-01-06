/**
 * Structured Logger using Pino
 *
 * Provides consistent, structured logging across the application.
 * - JSON format in production for log aggregation
 * - Pretty format in development for readability
 * - Contextual logging with child loggers
 */

import pino from 'pino';
import { randomBytes } from 'crypto';

const isProduction = process.env.NODE_ENV === 'production';

// Base logger configuration
const baseConfig = {
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  base: {
    pid: process.pid,
    env: process.env.NODE_ENV || 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

// In development, use pretty printing
const devTransport = {
  target: 'pino-pretty',
  options: {
    colorize: true,
    translateTime: 'SYS:standard',
    ignore: 'pid,hostname',
  },
};

// Create the logger
export const logger = pino(
  baseConfig,
  isProduction ? undefined : pino.transport(devTransport)
);

/**
 * Create a child logger with additional context
 * Usage: const log = createLogger({ module: 'auth' });
 */
export function createLogger(context) {
  return logger.child(context);
}

/**
 * Request logging middleware
 * Logs incoming requests and their responses
 */
export function requestLogger(req, res, next) {
  const start = Date.now();
  const requestId = req.headers['x-request-id'] || generateRequestId();

  // Attach request ID to request object for use in other middleware
  req.requestId = requestId;

  // Create child logger with request context
  req.log = logger.child({
    requestId,
    method: req.method,
    path: req.path,
  });

  // Log request start
  req.log.info({ query: req.query }, 'Request started');

  // Log response on finish
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      statusCode: res.statusCode,
      duration,
      userId: req.user?.id,
    };

    if (res.statusCode >= 500) {
      req.log.error(logData, 'Request failed');
    } else if (res.statusCode >= 400) {
      req.log.warn(logData, 'Request error');
    } else {
      req.log.info(logData, 'Request completed');
    }
  });

  next();
}

/**
 * Generate a secure request ID
 */
function generateRequestId() {
  return `req-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/**
 * Log levels available:
 * - logger.fatal() - Application is crashing
 * - logger.error() - Error that needs attention
 * - logger.warn()  - Warning, but recoverable
 * - logger.info()  - General information
 * - logger.debug() - Debug information (dev only)
 * - logger.trace() - Very detailed tracing (rarely used)
 */

export default logger;
