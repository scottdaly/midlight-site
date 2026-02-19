/**
 * Stack Parser Service
 *
 * Parses stack traces into structured frames and extracts significant
 * application frames for fingerprinting.
 */

import crypto from 'crypto';

/**
 * Parse a stack trace into structured frames
 *
 * @param {string} stackTrace - Raw stack trace string
 * @returns {Array<{file: string, line: number, col: number, function: string, isVendor: boolean}>}
 */
export function parseStack(stackTrace) {
  if (!stackTrace) return [];

  const frames = [];
  const lines = stackTrace.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Chrome/V8: "    at functionName (file:line:col)"
    let match = trimmed.match(/^\s*at\s+(?:(.+?)\s+\()?(https?:\/\/[^)]+|\/[^)]+):(\d+):(\d+)\)?/);
    if (match) {
      frames.push({
        function: match[1] || '<anonymous>',
        file: match[2],
        line: parseInt(match[3]),
        col: parseInt(match[4]),
        isVendor: isVendorFrame(match[2]),
      });
      continue;
    }

    // Firefox/Safari: "functionName@file:line:col"
    match = trimmed.match(/^([^@]*)@(.+):(\d+):(\d+)$/);
    if (match) {
      frames.push({
        function: match[1] || '<anonymous>',
        file: match[2],
        line: parseInt(match[3]),
        col: parseInt(match[4]),
        isVendor: isVendorFrame(match[2]),
      });
      continue;
    }

    // Symbolicated format: "    at fn (source.ts:line:col)"
    match = trimmed.match(/^\s*at\s+(.+?)\s+\((.+):(\d+):(\d+)\)/);
    if (match) {
      frames.push({
        function: match[1] || '<anonymous>',
        file: match[2],
        line: parseInt(match[3]),
        col: parseInt(match[4]),
        isVendor: isVendorFrame(match[2]),
      });
    }
  }

  return frames;
}

/**
 * Check if a frame is from vendor/third-party code
 */
function isVendorFrame(file) {
  if (!file) return true;

  const vendorPatterns = [
    'node_modules/',
    'node_modules\\',
    '/chunk-vendor',
    '/chunk-common',
    'polyfills',
    'webpack/',
    '__vite',
    'svelte-internal',
    'svelte/internal',
  ];

  const lower = file.toLowerCase();
  return vendorPatterns.some(p => lower.includes(p));
}

/**
 * Extract the top N significant (non-vendor) application frames
 *
 * @param {Array} frames - Parsed stack frames
 * @param {number} count - Number of frames to extract
 * @returns {Array} - Top N non-vendor frames
 */
export function extractSignificantFrames(frames, count = 3) {
  return frames
    .filter(f => !f.isVendor)
    .slice(0, count);
}

/**
 * Generate a stack-based fingerprint from significant frames
 *
 * @param {string} category - Error category
 * @param {string} errorType - Error type
 * @param {Array} frames - Significant frames
 * @returns {string} - SHA-256 fingerprint
 */
export function generateStackFingerprint(category, errorType, frames) {
  const frameStrings = frames.map(f => `${f.file}:${f.line}:${f.function}`);
  const input = `${category}:${errorType}:${frameStrings.join('+')}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

export default {
  parseStack,
  extractSignificantFrames,
  generateStackFingerprint,
};
