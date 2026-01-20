import { Router } from 'express';
import { body, query, param, validationResult } from 'express-validator';
import { logger } from '../utils/logger.js';
import { requireAuth, optionalAuth, attachSubscription, requirePro } from '../middleware/auth.js';
import * as marketplaceService from '../services/marketplaceService.js';

const router = Router();

// ============================================================================
// PUBLIC ROUTES (no auth required, but optional auth for personalization)
// ============================================================================

// GET /api/marketplace/featured - Get featured skills
router.get('/featured', optionalAuth, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const skills = marketplaceService.getFeaturedSkills(Math.min(limit, 50));

    res.json({ skills });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Get featured skills error');
    res.status(500).json({ error: 'Failed to get featured skills' });
  }
});

// GET /api/marketplace/skills - Browse skills
router.get('/skills', [
  query('category').optional().isIn(['writing', 'editing', 'analysis', 'extraction', 'generation', 'utility']),
  query('search').optional().trim().isLength({ max: 100 }),
  query('sort').optional().isIn(['popular', 'newest', 'rating']),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 }),
], optionalAuth, (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const result = marketplaceService.browseSkills({
      category: req.query.category || null,
      search: req.query.search || null,
      sort: req.query.sort || 'popular',
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 20,
    });

    res.json(result);
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Browse skills error');
    res.status(500).json({ error: 'Failed to browse skills' });
  }
});

// GET /api/marketplace/skills/:id - Get skill details
router.get('/skills/:id', [
  param('id').isUUID(),
], optionalAuth, (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.user?.id || null;
    const skill = marketplaceService.getSkillDetails(req.params.id, userId);

    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    res.json(skill);
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Get skill details error');
    res.status(500).json({ error: 'Failed to get skill details' });
  }
});

// GET /api/marketplace/skills/:id/download - Download skill package
router.get('/skills/:id/download', [
  param('id').isUUID(),
], requireAuth, (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const pkg = marketplaceService.downloadSkill(req.params.id);

    if (!pkg) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    res.json({ package: pkg });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Download skill error');
    res.status(500).json({ error: 'Failed to download skill' });
  }
});

// GET /api/marketplace/skills/:id/my-rating - Get user's rating for a skill
router.get('/skills/:id/my-rating', [
  param('id').isUUID(),
], requireAuth, (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const rating = marketplaceService.getUserRating(req.user.id, req.params.id);
    res.json({ rating });
  } catch (error) {
    logger.error({ error: error?.message || error }, 'Get user rating error');
    res.status(500).json({ error: 'Failed to get rating' });
  }
});

// ============================================================================
// AUTHENTICATED ROUTES
// ============================================================================

// POST /api/marketplace/skills/:id/install - Install a skill
router.post('/skills/:id/install', [
  param('id').isUUID(),
  body('version').optional().matches(/^\d+\.\d+\.\d+$/),
], requireAuth, attachSubscription, (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const result = marketplaceService.installSkill(
      req.user.id,
      req.params.id,
      req.body.version || null
    );

    res.json(result);
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Install skill error');

    if (error.message === 'Skill not found' || error.message === 'Version not found') {
      return res.status(404).json({ error: error.message });
    }

    res.status(500).json({ error: 'Failed to install skill' });
  }
});

// DELETE /api/marketplace/skills/:id/install - Uninstall a skill
router.delete('/skills/:id/install', [
  param('id').isUUID(),
], requireAuth, (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const result = marketplaceService.uninstallSkill(req.user.id, req.params.id);

    if (!result.success) {
      return res.status(404).json({ error: 'Skill not installed' });
    }

    res.json(result);
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Uninstall skill error');
    res.status(500).json({ error: 'Failed to uninstall skill' });
  }
});

// GET /api/marketplace/installed - Get user's installed skills
router.get('/installed', requireAuth, (req, res) => {
  try {
    const skills = marketplaceService.getUserInstalledSkills(req.user.id);
    res.json({ skills });
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Get installed skills error');
    res.status(500).json({ error: 'Failed to get installed skills' });
  }
});

// GET /api/marketplace/updates - Check for skill updates
router.get('/updates', requireAuth, (req, res) => {
  try {
    const updates = marketplaceService.checkForUpdates(req.user.id);
    res.json({ updates, hasUpdates: updates.length > 0 });
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Check updates error');
    res.status(500).json({ error: 'Failed to check for updates' });
  }
});

// POST /api/marketplace/skills/:id/rate - Rate a skill
router.post('/skills/:id/rate', [
  param('id').isUUID(),
  body('rating').isInt({ min: 1, max: 5 }),
  body('review').optional().trim().isLength({ max: 1000 }),
], requireAuth, (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const result = marketplaceService.rateSkill(
      req.user.id,
      req.params.id,
      req.body.rating,
      req.body.review || null
    );

    res.json(result);
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Rate skill error');

    if (error.message === 'Skill not found') {
      return res.status(404).json({ error: error.message });
    }

    res.status(500).json({ error: 'Failed to rate skill' });
  }
});

// POST /api/marketplace/skills/:id/flag - Flag a skill
router.post('/skills/:id/flag', [
  param('id').isUUID(),
  body('reason').isIn(['spam', 'inappropriate', 'broken', 'other']),
  body('details').optional().trim().isLength({ max: 500 }),
], requireAuth, (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const result = marketplaceService.flagSkill(
      req.user.id,
      req.params.id,
      req.body.reason,
      req.body.details || null
    );

    res.json(result);
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Flag skill error');

    if (error.message === 'Skill not found') {
      return res.status(404).json({ error: error.message });
    }
    if (error.message === 'You have already flagged this skill') {
      return res.status(409).json({ error: error.message });
    }

    res.status(500).json({ error: 'Failed to flag skill' });
  }
});

// ============================================================================
// PRO USER ROUTES (skill submission)
// ============================================================================

// POST /api/marketplace/submit - Submit a new skill (Pro users only)
router.post('/submit', [
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Name is required (max 100 chars)'),
  body('description').trim().isLength({ min: 1, max: 500 }).withMessage('Description is required (max 500 chars)'),
  body('icon').trim().isLength({ min: 1, max: 10 }).withMessage('Icon is required'),
  body('category').isIn(['writing', 'editing', 'analysis', 'extraction', 'generation', 'utility']),
  body('instructions').trim().isLength({ min: 10, max: 5000 }).withMessage('Instructions required (10-5000 chars)'),
  body('inputs').isArray().withMessage('Inputs must be an array'),
  body('inputs.*.id').trim().isLength({ min: 1, max: 50 }),
  body('inputs.*.label').trim().isLength({ min: 1, max: 100 }),
  body('inputs.*.type').isIn(['text', 'textarea', 'select', 'selection']),
  body('inputs.*.required').isBoolean(),
  body('outputFormat').isIn(['text', 'markdown', 'json', 'replace']),
  body('supportsSelection').optional().isBoolean(),
  body('supportsChat').optional().isBoolean(),
  body('tags').optional().isArray({ max: 10 }),
  body('tags.*').optional().trim().isLength({ max: 30 }),
], requireAuth, attachSubscription, requirePro, (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const result = marketplaceService.submitSkill(req.user.id, {
      name: req.body.name,
      description: req.body.description,
      icon: req.body.icon,
      category: req.body.category,
      instructions: req.body.instructions,
      inputs: req.body.inputs,
      outputFormat: req.body.outputFormat,
      supportsSelection: req.body.supportsSelection ?? true,
      supportsChat: req.body.supportsChat ?? true,
      tags: req.body.tags || [],
    });

    res.status(201).json(result);
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Submit skill error');

    if (error.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'You already have a skill with this name' });
    }

    res.status(500).json({ error: 'Failed to submit skill' });
  }
});

// PUT /api/marketplace/skills/:id - Update a skill (author only)
router.put('/skills/:id', [
  param('id').isUUID(),
  body('name').optional().trim().isLength({ min: 1, max: 100 }),
  body('description').optional().trim().isLength({ min: 1, max: 500 }),
  body('icon').optional().trim().isLength({ min: 1, max: 10 }),
  body('category').optional().isIn(['writing', 'editing', 'analysis', 'extraction', 'generation', 'utility']),
  body('instructions').trim().isLength({ min: 10, max: 5000 }),
  body('inputs').isArray(),
  body('outputFormat').isIn(['text', 'markdown', 'json', 'replace']),
  body('supportsSelection').optional().isBoolean(),
  body('supportsChat').optional().isBoolean(),
  body('tags').optional().isArray({ max: 10 }),
  body('changelog').optional().trim().isLength({ max: 500 }),
], requireAuth, attachSubscription, requirePro, (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const result = marketplaceService.updateSkill(req.user.id, req.params.id, req.body);

    res.json(result);
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Update skill error');

    if (error.message === 'Skill not found') {
      return res.status(404).json({ error: error.message });
    }
    if (error.message === 'Not authorized to update this skill') {
      return res.status(403).json({ error: error.message });
    }

    res.status(500).json({ error: 'Failed to update skill' });
  }
});

// DELETE /api/marketplace/skills/:id - Delete a skill (author only)
router.delete('/skills/:id', [
  param('id').isUUID(),
], requireAuth, attachSubscription, requirePro, (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const result = marketplaceService.deleteSkill(req.user.id, req.params.id);

    res.json(result);
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Delete skill error');

    if (error.message === 'Skill not found') {
      return res.status(404).json({ error: error.message });
    }
    if (error.message === 'Not authorized to delete this skill') {
      return res.status(403).json({ error: error.message });
    }

    res.status(500).json({ error: 'Failed to delete skill' });
  }
});

// ============================================================================
// PRIVATE SKILLS ROUTES (synced across devices)
// ============================================================================

// GET /api/marketplace/private - Get user's private skills
router.get('/private', requireAuth, (req, res) => {
  try {
    const skills = marketplaceService.getPrivateSkills(req.user.id);
    res.json({ skills });
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Get private skills error');
    res.status(500).json({ error: 'Failed to get private skills' });
  }
});

// POST /api/marketplace/private - Create a private skill
router.post('/private', [
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Name is required'),
  body('description').trim().isLength({ min: 1, max: 500 }).withMessage('Description is required'),
  body('icon').trim().isLength({ min: 1, max: 10 }).withMessage('Icon is required'),
  body('category').isIn(['writing', 'editing', 'analysis', 'extraction', 'generation', 'utility']),
  body('instructions').trim().isLength({ min: 10, max: 5000 }).withMessage('Instructions required'),
  body('inputs').isArray(),
  body('outputFormat').isIn(['text', 'markdown', 'json', 'replace']),
  body('supportsSelection').optional().isBoolean(),
  body('supportsChat').optional().isBoolean(),
], requireAuth, (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const result = marketplaceService.createPrivateSkill(req.user.id, {
      name: req.body.name,
      description: req.body.description,
      icon: req.body.icon,
      category: req.body.category,
      instructions: req.body.instructions,
      inputs: req.body.inputs,
      outputFormat: req.body.outputFormat,
      supportsSelection: req.body.supportsSelection ?? true,
      supportsChat: req.body.supportsChat ?? true,
    });

    res.status(201).json(result);
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Create private skill error');

    if (error.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'You already have a skill with this name' });
    }

    res.status(500).json({ error: 'Failed to create private skill' });
  }
});

// PUT /api/marketplace/private/:id - Update a private skill
router.put('/private/:id', [
  param('id').isUUID(),
  body('name').optional().trim().isLength({ min: 1, max: 100 }),
  body('description').optional().trim().isLength({ min: 1, max: 500 }),
  body('icon').optional().trim().isLength({ min: 1, max: 10 }),
  body('category').optional().isIn(['writing', 'editing', 'analysis', 'extraction', 'generation', 'utility']),
  body('instructions').optional().trim().isLength({ min: 10, max: 5000 }),
  body('inputs').optional().isArray(),
  body('outputFormat').optional().isIn(['text', 'markdown', 'json', 'replace']),
  body('supportsSelection').optional().isBoolean(),
  body('supportsChat').optional().isBoolean(),
], requireAuth, (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const result = marketplaceService.updatePrivateSkill(req.user.id, req.params.id, req.body);

    res.json(result);
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Update private skill error');

    if (error.message === 'Skill not found') {
      return res.status(404).json({ error: error.message });
    }

    res.status(500).json({ error: 'Failed to update private skill' });
  }
});

// DELETE /api/marketplace/private/:id - Delete a private skill
router.delete('/private/:id', [
  param('id').isUUID(),
], requireAuth, (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const result = marketplaceService.deletePrivateSkill(req.user.id, req.params.id);

    if (!result.success) {
      return res.status(404).json({ error: 'Skill not found' });
    }

    res.json(result);
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Delete private skill error');
    res.status(500).json({ error: 'Failed to delete private skill' });
  }
});

// POST /api/marketplace/private/:id/publish - Publish private skill to marketplace (Pro only)
router.post('/private/:id/publish', [
  param('id').isUUID(),
], requireAuth, attachSubscription, requirePro, (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const result = marketplaceService.publishPrivateSkill(req.user.id, req.params.id);

    res.status(201).json(result);
  } catch (error) {
    logger.error({ error: error?.message || error, userId: req.user.id }, 'Publish private skill error');

    if (error.message === 'Skill not found') {
      return res.status(404).json({ error: error.message });
    }

    res.status(500).json({ error: 'Failed to publish skill' });
  }
});

export default router;
