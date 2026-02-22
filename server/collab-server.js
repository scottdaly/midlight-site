import 'dotenv/config';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

import { hocuspocus } from './services/collabService.js';
import { logger } from './utils/logger.js';

const PORT = parsePort(process.env.COLLAB_PORT || '3003', 3003);
const HOST = (process.env.COLLAB_HOST || '127.0.0.1').trim();

const allowedOrigins = buildAllowedOrigins(process.env.CORS_ORIGIN);

const server = createServer((req, res) => {
  const url = req.url || '/';

  if (req.method === 'GET' && (url === '/health' || url.startsWith('/health?'))) {
    return respondJSON(res, 200, {
      status: 'ok',
      service: 'hocuspocus-collab',
      time: new Date().toISOString(),
    });
  }

  if (req.method === 'GET' && (url === '/health/ready' || url.startsWith('/health/ready?'))) {
    return respondJSON(res, 200, {
      status: 'ok',
      service: 'hocuspocus-collab',
      time: new Date().toISOString(),
    });
  }

  return respondJSON(res, 404, { error: 'Not found' });
});

const collabWss = new WebSocketServer({ noServer: true });

collabWss.on('connection', (ws, request) => {
  hocuspocus.handleConnection(ws, request);
});

server.on('upgrade', (request, socket, head) => {
  if (!request.url?.startsWith('/collab')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const origin = request.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    logger.warn({ origin }, 'WebSocket upgrade rejected: invalid origin');
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  collabWss.handleUpgrade(request, socket, head, (ws) => {
    collabWss.emit('connection', ws, request);
  });
});

server.listen(PORT, HOST, () => {
  logger.info(
    {
      host: HOST,
      port: PORT,
      allowedOrigins,
      env: process.env.NODE_ENV || 'development',
    },
    'Collab server started'
  );
});

function gracefulShutdown(signal) {
  logger.info({ signal }, 'Shutting down collab server');

  server.close();
  collabWss.close();
  hocuspocus.destroy();

  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

function buildAllowedOrigins(rawValue) {
  if (rawValue && rawValue.trim()) {
    return rawValue
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return [
    'https://midlight.ai',
    'https://www.midlight.ai',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:1420',
    'tauri://localhost',
  ];
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed;
  }
  return fallback;
}

function respondJSON(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}
