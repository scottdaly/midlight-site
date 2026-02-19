/**
 * Source Map Admin Routes
 *
 * Upload, list, and manage source maps for release symbolication.
 */

import express from 'express';
import multer from 'multer';
import { logger } from '../../utils/logger.js';
import {
  storeSourceMaps,
  listReleases,
  deleteRelease,
  cleanupOldSourceMaps
} from '../../services/sourcemapService.js';

const router = express.Router();

// Multer config for multipart upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per file
    files: 100,
  },
});

/**
 * POST /api/admin/sourcemaps/upload
 * Upload source maps for a release
 *
 * Authentication: Bearer token (SOURCEMAP_API_KEY)
 * Content-Type: multipart/form-data
 *
 * Fields:
 *   version - Release version (git short SHA)
 *   platform - Platform (web, desktop)
 *   commit_sha - Full git commit SHA
 *   files - Source map file(s)
 *   file_paths - Corresponding JS file paths (one per file, in order)
 */
router.post('/upload', (req, res, next) => {
  // Authenticate with SOURCEMAP_API_KEY
  const auth = req.headers.authorization;
  const apiKey = process.env.SOURCEMAP_API_KEY;

  if (!apiKey) {
    return res.status(503).json({ error: 'Source map upload not configured' });
  }

  if (!auth || auth !== `Bearer ${apiKey}`) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  next();
}, upload.array('files', 100), (req, res) => {
  try {
    const { version, platform, commit_sha } = req.body;
    const filePaths = req.body.file_paths;

    if (!version) {
      return res.status(400).json({ error: 'version is required' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No source map files provided' });
    }

    // file_paths can be a string (single) or array
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];

    if (paths.length !== req.files.length) {
      return res.status(400).json({
        error: `Mismatch: ${req.files.length} files but ${paths.length} file_paths`
      });
    }

    const maps = req.files.map((file, i) => ({
      filePath: paths[i],
      content: file.buffer,
    }));

    const result = storeSourceMaps(version, platform || 'web', commit_sha || '', maps);

    logger.info({
      version,
      platform,
      uploaded: result.uploaded
    }, 'Source maps uploaded');

    res.json({
      success: true,
      releaseId: result.releaseId,
      uploaded: result.uploaded,
    });

  } catch (err) {
    logger.error({ error: err?.message || err }, 'Source map upload error');
    res.status(500).json({ error: 'Upload failed' });
  }
});

/**
 * GET /api/admin/sourcemaps/releases
 * List all releases with source map counts
 */
router.get('/releases', (req, res) => {
  try {
    const releases = listReleases();
    res.json({ releases });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error listing releases');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/admin/sourcemaps/releases/:version
 * Delete a release and its source maps
 */
router.delete('/releases/:version', (req, res) => {
  try {
    const deleted = deleteRelease(req.params.version);
    if (!deleted) {
      return res.status(404).json({ error: 'Release not found' });
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error deleting release');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/admin/sourcemaps/cleanup
 * Clean up source maps older than 90 days
 */
router.post('/cleanup', (req, res) => {
  try {
    const cleaned = cleanupOldSourceMaps();
    res.json({ cleaned });
  } catch (err) {
    logger.error({ error: err?.message || err }, 'Error cleaning up source maps');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
