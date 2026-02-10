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

const router = express.Router();

/**
 * Get all prompt sections
 * Returns the latest versioned prompt sections for client-side assembly.
 */
router.get('/sections', (req, res) => {
  const data = getPromptSections();
  // Cache for 1 hour — clients also cache locally
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(data);
});

export default router;
