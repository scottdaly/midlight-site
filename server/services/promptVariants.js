/**
 * Prompt Variant Assignment Service
 *
 * Manages A/B testing for prompt sections. Users are assigned to variants
 * via weighted random selection with sticky assignment (once assigned,
 * always gets the same variant for that experiment).
 */

import db from '../db/index.js';
import { getPromptSections } from './prompts.js';

/**
 * Get the assigned variant for a user in a given experiment.
 * If no assignment exists, randomly assigns one based on variant weights.
 *
 * @param {number} userId
 * @param {string} experimentName
 * @returns {{ variantKey: string, sectionName: string, text: string, version: string } | null}
 */
export function getVariantForUser(userId, experimentName) {
  // Check existing assignment
  const existing = db.prepare(
    'SELECT variant_key FROM user_variant_assignments WHERE user_id = ? AND experiment_name = ?'
  ).get(userId, experimentName);

  if (existing) {
    // Look up the variant's content
    const variant = db.prepare(
      'SELECT section_name, text, version FROM prompt_variants WHERE experiment_name = ? AND variant_key = ? AND is_active = 1'
    ).get(experimentName, existing.variant_key);

    if (variant) {
      return {
        variantKey: existing.variant_key,
        sectionName: variant.section_name,
        text: variant.text,
        version: variant.version,
      };
    }
    // Variant was deactivated — clean up stale assignment
    db.prepare(
      'DELETE FROM user_variant_assignments WHERE user_id = ? AND experiment_name = ?'
    ).run(userId, experimentName);
  }

  // Get active variants for this experiment
  const variants = db.prepare(
    'SELECT variant_key, section_name, text, version, weight FROM prompt_variants WHERE experiment_name = ? AND is_active = 1'
  ).all(experimentName);

  if (variants.length === 0) return null;

  // Weighted random selection
  const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
  let random = Math.random() * totalWeight;
  let selected = variants[0];

  for (const variant of variants) {
    random -= variant.weight;
    if (random <= 0) {
      selected = variant;
      break;
    }
  }

  // Persist assignment
  db.prepare(
    'INSERT INTO user_variant_assignments (user_id, experiment_name, variant_key) VALUES (?, ?, ?)'
  ).run(userId, experimentName, selected.variant_key);

  return {
    variantKey: selected.variant_key,
    sectionName: selected.section_name,
    text: selected.text,
    version: selected.version,
  };
}

/**
 * Get prompt sections with variant overrides for an authenticated user.
 *
 * @param {number} userId
 * @returns {{ version: string, sections: Record<string, { text: string, version: string }>, variants: Record<string, string> }}
 */
export function getPromptSectionsForUser(userId) {
  const base = getPromptSections();

  // Find all active experiments
  const experiments = db.prepare(
    'SELECT DISTINCT experiment_name FROM prompt_variants WHERE is_active = 1'
  ).all();

  if (experiments.length === 0) {
    return { ...base, variants: {} };
  }

  const variants = {};
  const sections = { ...base.sections };

  for (const { experiment_name } of experiments) {
    const assignment = getVariantForUser(userId, experiment_name);
    if (assignment) {
      variants[experiment_name] = assignment.variantKey;
      // Override the section content with the variant text
      sections[assignment.sectionName] = {
        text: assignment.text,
        version: assignment.version,
      };
    }
  }

  return {
    version: base.version,
    sections,
    variants,
  };
}
