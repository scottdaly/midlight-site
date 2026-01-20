import db from '../db/index.js';
import crypto from 'crypto';

// ============================================================================
// SKILL BROWSING & DISCOVERY
// ============================================================================

/**
 * Get featured skills for the explore page
 */
export function getFeaturedSkills(limit = 10) {
  const skills = db.prepare(`
    SELECT
      ms.id, ms.name, ms.description, ms.icon, ms.category,
      ms.author_id, ms.author_name, ms.current_version,
      ms.install_count, ms.avg_rating, ms.rating_count,
      ms.is_featured, ms.tags, ms.created_at
    FROM marketplace_skills ms
    WHERE ms.status = 'published' AND ms.is_featured = 1
    ORDER BY ms.avg_rating DESC, ms.install_count DESC
    LIMIT ?
  `).all(limit);

  return skills.map(formatSkillForResponse);
}

/**
 * Browse skills with filtering and pagination
 */
export function browseSkills({
  category = null,
  search = null,
  sort = 'popular',
  page = 1,
  limit = 20,
} = {}) {
  const offset = (page - 1) * limit;
  const params = [];
  let whereClause = "WHERE ms.status = 'published'";

  if (category) {
    whereClause += ' AND ms.category = ?';
    params.push(category);
  }

  if (search) {
    whereClause += ' AND (ms.name LIKE ? OR ms.description LIKE ? OR ms.tags LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm);
  }

  let orderClause;
  switch (sort) {
    case 'newest':
      orderClause = 'ORDER BY ms.created_at DESC';
      break;
    case 'rating':
      orderClause = 'ORDER BY ms.avg_rating DESC, ms.rating_count DESC';
      break;
    case 'popular':
    default:
      orderClause = 'ORDER BY ms.install_count DESC, ms.avg_rating DESC';
      break;
  }

  // Get total count
  const countResult = db.prepare(`
    SELECT COUNT(*) as total
    FROM marketplace_skills ms
    ${whereClause}
  `).get(...params);

  // Get skills
  const skills = db.prepare(`
    SELECT
      ms.id, ms.name, ms.description, ms.icon, ms.category,
      ms.author_id, ms.author_name, ms.current_version,
      ms.install_count, ms.avg_rating, ms.rating_count,
      ms.is_featured, ms.tags, ms.created_at
    FROM marketplace_skills ms
    ${whereClause}
    ${orderClause}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return {
    skills: skills.map(formatSkillForResponse),
    pagination: {
      page,
      limit,
      total: countResult.total,
      totalPages: Math.ceil(countResult.total / limit),
    },
  };
}

/**
 * Get skill details including versions and rating summary
 */
export function getSkillDetails(skillId, userId = null) {
  const skill = db.prepare(`
    SELECT
      ms.id, ms.name, ms.description, ms.icon, ms.category,
      ms.author_id, ms.author_name, ms.current_version,
      ms.install_count, ms.avg_rating, ms.rating_count,
      ms.is_featured, ms.tags, ms.created_at, ms.updated_at
    FROM marketplace_skills ms
    WHERE ms.id = ? AND ms.status = 'published'
  `).get(skillId);

  if (!skill) {
    return null;
  }

  // Get current version details
  const currentVersion = db.prepare(`
    SELECT version, instructions, inputs, output_format,
           supports_selection, supports_chat, changelog, created_at
    FROM skill_versions
    WHERE skill_id = ? AND version = ?
  `).get(skillId, skill.current_version);

  // Get all versions
  const versions = db.prepare(`
    SELECT version, changelog, created_at
    FROM skill_versions
    WHERE skill_id = ?
    ORDER BY created_at DESC
  `).all(skillId);

  // Get recent reviews
  const reviews = db.prepare(`
    SELECT sr.rating, sr.review, sr.created_at, u.display_name, u.id as user_id
    FROM skill_ratings sr
    JOIN users u ON sr.user_id = u.id
    WHERE sr.skill_id = ?
    ORDER BY sr.created_at DESC
    LIMIT 10
  `).all(skillId);

  // Check if user has installed this skill
  let userInstalled = null;
  let userRating = null;
  if (userId) {
    userInstalled = db.prepare(`
      SELECT installed_version, installed_at
      FROM user_installed_skills
      WHERE user_id = ? AND skill_id = ?
    `).get(userId, skillId);

    userRating = db.prepare(`
      SELECT rating, review
      FROM skill_ratings
      WHERE user_id = ? AND skill_id = ?
    `).get(userId, skillId);
  }

  return {
    ...formatSkillForResponse(skill),
    updatedAt: skill.updated_at,
    currentVersionDetails: currentVersion ? {
      version: currentVersion.version,
      instructions: currentVersion.instructions,
      inputs: JSON.parse(currentVersion.inputs || '[]'),
      outputFormat: currentVersion.output_format,
      supportsSelection: !!currentVersion.supports_selection,
      supportsChat: !!currentVersion.supports_chat,
      changelog: currentVersion.changelog,
      createdAt: currentVersion.created_at,
    } : null,
    versions: versions.map(v => ({
      version: v.version,
      changelog: v.changelog,
      createdAt: v.created_at,
    })),
    reviews: reviews.map(r => ({
      rating: r.rating,
      review: r.review,
      createdAt: r.created_at,
      authorName: r.display_name || 'Anonymous',
    })),
    userInstalled: userInstalled ? {
      version: userInstalled.installed_version,
      installedAt: userInstalled.installed_at,
      hasUpdate: userInstalled.installed_version !== skill.current_version,
    } : null,
    userRating: userRating ? {
      rating: userRating.rating,
      review: userRating.review,
    } : null,
  };
}

// ============================================================================
// SKILL DOWNLOAD
// ============================================================================

/**
 * Download skill package data
 */
export function downloadSkill(skillId) {
  const skill = db.prepare(`
    SELECT ms.id, ms.name, ms.description, ms.icon, ms.category,
           ms.author_name, ms.current_version, ms.tags,
           sv.instructions, sv.inputs, sv.output_format,
           sv.supports_selection, sv.supports_chat
    FROM marketplace_skills ms
    JOIN skill_versions sv ON ms.id = sv.skill_id AND ms.current_version = sv.version
    WHERE ms.id = ? AND ms.status = 'published'
  `).get(skillId);

  if (!skill) {
    return null;
  }

  // Return as a SkillPackage JSON string
  const pkg = {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    icon: skill.icon,
    category: skill.category,
    version: skill.current_version,
    author: skill.author_name,
    tags: skill.tags ? JSON.parse(skill.tags) : [],
    inputs: JSON.parse(skill.inputs || '[]'),
    instructions: skill.instructions,
    outputFormat: skill.output_format,
    supportsSelection: !!skill.supports_selection,
    supportsChat: !!skill.supports_chat,
  };

  return JSON.stringify(pkg);
}

/**
 * Get a user's rating for a specific skill
 */
export function getUserRating(userId, skillId) {
  const rating = db.prepare(`
    SELECT skill_id, user_id, rating, review, created_at
    FROM skill_ratings
    WHERE user_id = ? AND skill_id = ?
  `).get(userId, skillId);

  if (!rating) {
    return null;
  }

  return {
    skill_id: rating.skill_id,
    user_id: rating.user_id,
    rating: rating.rating,
    review: rating.review,
    created_at: rating.created_at,
  };
}

// ============================================================================
// SKILL INSTALLATION
// ============================================================================

/**
 * Install a skill for a user
 */
export function installSkill(userId, skillId, version = null) {
  const skill = db.prepare(`
    SELECT id, current_version FROM marketplace_skills
    WHERE id = ? AND status = 'published'
  `).get(skillId);

  if (!skill) {
    throw new Error('Skill not found');
  }

  const targetVersion = version || skill.current_version;

  // Verify version exists
  const versionExists = db.prepare(`
    SELECT version FROM skill_versions
    WHERE skill_id = ? AND version = ?
  `).get(skillId, targetVersion);

  if (!versionExists) {
    throw new Error('Version not found');
  }

  // Install (upsert)
  db.prepare(`
    INSERT INTO user_installed_skills (user_id, skill_id, installed_version)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, skill_id) DO UPDATE SET
      installed_version = excluded.installed_version,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, skillId, targetVersion);

  // Increment install count (only on new install, not update)
  db.prepare(`
    UPDATE marketplace_skills
    SET install_count = install_count + 1
    WHERE id = ? AND NOT EXISTS (
      SELECT 1 FROM user_installed_skills
      WHERE user_id = ? AND skill_id = ?
    )
  `).run(skillId, userId, skillId);

  return { success: true, version: targetVersion };
}

/**
 * Uninstall a skill for a user
 */
export function uninstallSkill(userId, skillId) {
  const result = db.prepare(`
    DELETE FROM user_installed_skills
    WHERE user_id = ? AND skill_id = ?
  `).run(userId, skillId);

  return { success: result.changes > 0 };
}

/**
 * Get user's installed skills with full details
 */
export function getUserInstalledSkills(userId) {
  const installed = db.prepare(`
    SELECT
      uis.skill_id, uis.installed_version, uis.installed_at,
      ms.id, ms.name, ms.description, ms.icon, ms.category,
      ms.author_name, ms.current_version, ms.avg_rating, ms.rating_count,
      sv.instructions, sv.inputs, sv.output_format,
      sv.supports_selection, sv.supports_chat
    FROM user_installed_skills uis
    JOIN marketplace_skills ms ON uis.skill_id = ms.id
    JOIN skill_versions sv ON ms.id = sv.skill_id AND uis.installed_version = sv.version
    WHERE uis.user_id = ? AND ms.status = 'published'
    ORDER BY uis.installed_at DESC
  `).all(userId);

  return installed.map(row => ({
    id: row.skill_id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    category: row.category,
    authorName: row.author_name,
    installedVersion: row.installed_version,
    latestVersion: row.current_version,
    hasUpdate: row.installed_version !== row.current_version,
    avgRating: row.avg_rating,
    ratingCount: row.rating_count,
    installedAt: row.installed_at,
    // Full skill data for execution
    instructions: row.instructions,
    inputs: JSON.parse(row.inputs || '[]'),
    outputFormat: row.output_format,
    supportsSelection: !!row.supports_selection,
    supportsChat: !!row.supports_chat,
  }));
}

/**
 * Check for updates to installed skills
 */
export function checkForUpdates(userId) {
  const updates = db.prepare(`
    SELECT
      uis.skill_id, uis.installed_version,
      ms.name, ms.current_version
    FROM user_installed_skills uis
    JOIN marketplace_skills ms ON uis.skill_id = ms.id
    WHERE uis.user_id = ?
      AND ms.status = 'published'
      AND uis.installed_version != ms.current_version
  `).all(userId);

  return updates.map(row => ({
    skillId: row.skill_id,
    name: row.name,
    installedVersion: row.installed_version,
    latestVersion: row.current_version,
  }));
}

// ============================================================================
// SKILL SUBMISSION (Pro users)
// ============================================================================

/**
 * Submit a new skill to the marketplace
 */
export function submitSkill(userId, skillData) {
  const {
    name,
    description,
    icon,
    category,
    instructions,
    inputs,
    outputFormat,
    supportsSelection = true,
    supportsChat = true,
    tags = [],
  } = skillData;

  // Get author info
  const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const skillId = crypto.randomUUID();
  const version = '1.0.0';
  const authorName = user.display_name || 'Anonymous';

  // Create skill and first version in transaction
  const createSkill = db.transaction(() => {
    // Insert skill
    db.prepare(`
      INSERT INTO marketplace_skills (
        id, name, description, icon, category,
        author_id, author_name, current_version, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      skillId, name, description, icon, category,
      userId, authorName, version, JSON.stringify(tags)
    );

    // Insert version
    db.prepare(`
      INSERT INTO skill_versions (
        skill_id, version, instructions, inputs, output_format,
        supports_selection, supports_chat, changelog
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      skillId, version, instructions, JSON.stringify(inputs), outputFormat,
      supportsSelection ? 1 : 0, supportsChat ? 1 : 0, 'Initial release'
    );

    return skillId;
  });

  createSkill();

  return {
    id: skillId,
    version,
    status: 'published',
  };
}

/**
 * Update an existing skill (author only)
 */
export function updateSkill(userId, skillId, skillData) {
  // Verify ownership
  const skill = db.prepare(`
    SELECT id, author_id, current_version FROM marketplace_skills
    WHERE id = ? AND status != 'removed'
  `).get(skillId);

  if (!skill) {
    throw new Error('Skill not found');
  }

  if (skill.author_id !== userId) {
    throw new Error('Not authorized to update this skill');
  }

  const {
    name,
    description,
    icon,
    category,
    instructions,
    inputs,
    outputFormat,
    supportsSelection,
    supportsChat,
    tags,
    changelog,
  } = skillData;

  // Increment version
  const currentParts = skill.current_version.split('.').map(Number);
  currentParts[2]++; // Increment patch version
  const newVersion = currentParts.join('.');

  const update = db.transaction(() => {
    // Update skill metadata
    db.prepare(`
      UPDATE marketplace_skills
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          icon = COALESCE(?, icon),
          category = COALESCE(?, category),
          tags = COALESCE(?, tags),
          current_version = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name, description, icon, category,
      tags ? JSON.stringify(tags) : null,
      newVersion, skillId
    );

    // Insert new version
    db.prepare(`
      INSERT INTO skill_versions (
        skill_id, version, instructions, inputs, output_format,
        supports_selection, supports_chat, changelog
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      skillId, newVersion, instructions, JSON.stringify(inputs), outputFormat,
      supportsSelection ? 1 : 0, supportsChat ? 1 : 0, changelog || 'Update'
    );

    return newVersion;
  });

  update();

  return { id: skillId, version: newVersion };
}

/**
 * Delete a skill (author only, soft delete)
 */
export function deleteSkill(userId, skillId) {
  const skill = db.prepare(`
    SELECT author_id FROM marketplace_skills WHERE id = ?
  `).get(skillId);

  if (!skill) {
    throw new Error('Skill not found');
  }

  if (skill.author_id !== userId) {
    throw new Error('Not authorized to delete this skill');
  }

  db.prepare(`
    UPDATE marketplace_skills
    SET status = 'removed', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(skillId);

  return { success: true };
}

// ============================================================================
// RATINGS & FLAGS
// ============================================================================

/**
 * Rate a skill
 */
export function rateSkill(userId, skillId, rating, review = null) {
  if (rating < 1 || rating > 5) {
    throw new Error('Rating must be between 1 and 5');
  }

  // Verify skill exists
  const skill = db.prepare(`
    SELECT id FROM marketplace_skills WHERE id = ? AND status = 'published'
  `).get(skillId);

  if (!skill) {
    throw new Error('Skill not found');
  }

  // Upsert rating
  db.prepare(`
    INSERT INTO skill_ratings (skill_id, user_id, rating, review)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(skill_id, user_id) DO UPDATE SET
      rating = excluded.rating,
      review = excluded.review,
      updated_at = CURRENT_TIMESTAMP
  `).run(skillId, userId, rating, review);

  // Recalculate average rating
  const stats = db.prepare(`
    SELECT AVG(rating) as avg_rating, COUNT(*) as rating_count
    FROM skill_ratings
    WHERE skill_id = ?
  `).get(skillId);

  db.prepare(`
    UPDATE marketplace_skills
    SET avg_rating = ?, rating_count = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(stats.avg_rating, stats.rating_count, skillId);

  return { success: true, avgRating: stats.avg_rating, ratingCount: stats.rating_count };
}

/**
 * Flag a skill for review
 */
export function flagSkill(userId, skillId, reason, details = null) {
  const validReasons = ['spam', 'inappropriate', 'broken', 'other'];
  if (!validReasons.includes(reason)) {
    throw new Error('Invalid flag reason');
  }

  // Verify skill exists
  const skill = db.prepare(`
    SELECT id FROM marketplace_skills WHERE id = ? AND status = 'published'
  `).get(skillId);

  if (!skill) {
    throw new Error('Skill not found');
  }

  // Check if user already flagged this skill
  const existingFlag = db.prepare(`
    SELECT id FROM skill_flags
    WHERE skill_id = ? AND user_id = ? AND resolved = 0
  `).get(skillId, userId);

  if (existingFlag) {
    throw new Error('You have already flagged this skill');
  }

  db.prepare(`
    INSERT INTO skill_flags (skill_id, user_id, reason, details)
    VALUES (?, ?, ?, ?)
  `).run(skillId, userId, reason, details);

  // Auto-flag skill if it has 3+ unresolved flags
  const flagCount = db.prepare(`
    SELECT COUNT(*) as count FROM skill_flags
    WHERE skill_id = ? AND resolved = 0
  `).get(skillId);

  if (flagCount.count >= 3) {
    db.prepare(`
      UPDATE marketplace_skills
      SET status = 'flagged', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(skillId);
  }

  return { success: true };
}

// ============================================================================
// PRIVATE SKILLS (User-created, synced)
// ============================================================================

/**
 * Get user's private skills
 */
export function getPrivateSkills(userId) {
  const skills = db.prepare(`
    SELECT id, name, description, icon, category,
           instructions, inputs, output_format,
           supports_selection, supports_chat,
           created_at, updated_at
    FROM user_private_skills
    WHERE user_id = ?
    ORDER BY updated_at DESC
  `).all(userId);

  return skills.map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    icon: s.icon,
    category: s.category,
    instructions: s.instructions,
    inputs: JSON.parse(s.inputs || '[]'),
    outputFormat: s.output_format,
    supportsSelection: !!s.supports_selection,
    supportsChat: !!s.supports_chat,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    isPrivate: true,
  }));
}

/**
 * Create a private skill
 */
export function createPrivateSkill(userId, skillData) {
  const {
    name,
    description,
    icon,
    category,
    instructions,
    inputs,
    outputFormat,
    supportsSelection = true,
    supportsChat = true,
  } = skillData;

  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO user_private_skills (
      id, user_id, name, description, icon, category,
      instructions, inputs, output_format,
      supports_selection, supports_chat
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, userId, name, description, icon, category,
    instructions, JSON.stringify(inputs), outputFormat,
    supportsSelection ? 1 : 0, supportsChat ? 1 : 0
  );

  return { id, name };
}

/**
 * Update a private skill
 */
export function updatePrivateSkill(userId, skillId, skillData) {
  const skill = db.prepare(`
    SELECT id FROM user_private_skills WHERE id = ? AND user_id = ?
  `).get(skillId, userId);

  if (!skill) {
    throw new Error('Skill not found');
  }

  const {
    name,
    description,
    icon,
    category,
    instructions,
    inputs,
    outputFormat,
    supportsSelection,
    supportsChat,
  } = skillData;

  db.prepare(`
    UPDATE user_private_skills
    SET name = COALESCE(?, name),
        description = COALESCE(?, description),
        icon = COALESCE(?, icon),
        category = COALESCE(?, category),
        instructions = COALESCE(?, instructions),
        inputs = COALESCE(?, inputs),
        output_format = COALESCE(?, output_format),
        supports_selection = COALESCE(?, supports_selection),
        supports_chat = COALESCE(?, supports_chat),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(
    name, description, icon, category,
    instructions, inputs ? JSON.stringify(inputs) : null, outputFormat,
    supportsSelection !== undefined ? (supportsSelection ? 1 : 0) : null,
    supportsChat !== undefined ? (supportsChat ? 1 : 0) : null,
    skillId, userId
  );

  return { id: skillId };
}

/**
 * Delete a private skill
 */
export function deletePrivateSkill(userId, skillId) {
  const result = db.prepare(`
    DELETE FROM user_private_skills WHERE id = ? AND user_id = ?
  `).run(skillId, userId);

  return { success: result.changes > 0 };
}

/**
 * Publish a private skill to marketplace (Pro users)
 */
export function publishPrivateSkill(userId, skillId) {
  const skill = db.prepare(`
    SELECT * FROM user_private_skills WHERE id = ? AND user_id = ?
  `).get(skillId, userId);

  if (!skill) {
    throw new Error('Skill not found');
  }

  // Submit to marketplace
  const result = submitSkill(userId, {
    name: skill.name,
    description: skill.description,
    icon: skill.icon,
    category: skill.category,
    instructions: skill.instructions,
    inputs: JSON.parse(skill.inputs || '[]'),
    outputFormat: skill.output_format,
    supportsSelection: !!skill.supports_selection,
    supportsChat: !!skill.supports_chat,
  });

  return result;
}

// ============================================================================
// HELPERS
// ============================================================================

function formatSkillForResponse(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    icon: skill.icon,
    category: skill.category,
    authorId: skill.author_id,
    authorName: skill.author_name,
    currentVersion: skill.current_version,
    installCount: skill.install_count,
    avgRating: skill.avg_rating,
    ratingCount: skill.rating_count,
    isFeatured: !!skill.is_featured,
    tags: skill.tags ? JSON.parse(skill.tags) : [],
    createdAt: skill.created_at,
  };
}
