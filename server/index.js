import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import reportsRouter from './routes/reports.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy (required for correct IP behind Nginx/Caddy)
app.set('trust proxy', 1); 

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "https://static.cloudflareinsights.com"],
      "connect-src": ["'self'", "https://cloudflareinsights.com"],
    },
  },
}));
app.use(cors()); // Configure origin in production if needed
app.use(express.json());

// Rate Limiter for Submission Endpoint
const submissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100, // Limit each IP to 100 requests per `window` (here, per hour)
  standardHeaders: true,
  legacyHeaders: false,
});

// Basic Auth Middleware for Admin
const basicAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic');
    return res.status(401).send('Authentication required');
  }

  const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  const user = auth[0];
  const pass = auth[1];

  // TODO: Use environment variables for credentials in production
  const ADMIN_USER = process.env.ADMIN_USER || 'admin';
  const ADMIN_PASS = process.env.ADMIN_PASS || 'midlight_secret';

  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic');
    return res.status(401).send('Invalid credentials');
  }
};

// API Routes
// Apply rate limiter specifically to the submission endpoint
app.use('/api', (req, res, next) => {
  if (req.path === '/error-report' && req.method === 'POST') {
    submissionLimiter(req, res, next);
  } else {
    next();
  }
});

// Admin protection
app.use('/api/admin', basicAuth);

app.use('/api', reportsRouter);

// Serve static files from frontend in production (optional, if not using Nginx for static)
// Since the prompt mentions Nginx will proxy /api -> localhost:3001, we might not need to serve static here.
// But it's good practice for a standalone test.

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
