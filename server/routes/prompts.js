/**
 * Prompt Sections Route
 *
 * Serves the latest system prompt sections to desktop and web clients.
 * No auth required — prompt text is not user data.
 *
 * Endpoints:
 * - GET /api/prompts/sections - Returns all current prompt sections
 */

import express from 'express';
import { getPromptSections } from '../services/prompts.js';
import { getPromptSectionsForUser } from '../services/promptVariants.js';
import { optionalAuth } from '../middleware/auth.js';

const router = express.Router();

/**
 * Get all prompt sections
 * Returns the latest versioned prompt sections for client-side assembly.
 * If authenticated, applies A/B variant overrides and returns variant metadata.
 */
router.get('/sections', optionalAuth, (req, res) => {
  if (req.user?.id) {
    // Authenticated: apply variant overrides, private cache
    const data = getPromptSectionsForUser(req.user.id);
    res.set('Cache-Control', 'private, max-age=3600');
    res.json(data);
  } else {
    // Unauthenticated: default sections, public cache
    const data = getPromptSections();
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(data);
  }
});

export default router;
