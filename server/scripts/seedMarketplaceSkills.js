/**
 * Seed script for marketplace sample skills
 * Run with: node server/scripts/seedMarketplaceSkills.js
 */

import db from '../db/index.js';
import crypto from 'crypto';

// System user for built-in skills
const SYSTEM_USER_EMAIL = 'system@midlight.ai';
const SYSTEM_USER_NAME = 'Midlight';

// Sample skills based on built-in definitions
const sampleSkills = [
  {
    name: 'Summarize Selection',
    description: 'Generate a concise summary of selected text. Perfect for quickly understanding long documents or creating TL;DR versions.',
    icon: '✂️',
    category: 'analysis',
    instructions: `Summarize the provided text according to the requested style.
Be concise and capture the main points.
If the text is very short, just rephrase it more clearly.
Do not add information not present in the original text.
Focus on the key takeaways and most important information.`,
    inputs: [
      { id: 'text', label: 'Text to summarize', type: 'selection', required: true },
      {
        id: 'style',
        label: 'Summary style',
        type: 'select',
        required: false,
        options: ['Brief (1-2 sentences)', 'Detailed (paragraph)', 'Bullet points'],
        defaultValue: 'Brief (1-2 sentences)',
      },
    ],
    outputFormat: 'text',
    supportsSelection: true,
    supportsChat: true,
    tags: ['summary', 'tldr', 'condense', 'analyze'],
    featured: true,
  },
  {
    name: 'Expand Outline',
    description: 'Turn bullet points into full prose. Great for quickly drafting content from notes or outlines.',
    icon: '📝',
    category: 'writing',
    instructions: `Expand the provided outline into well-written prose.
Each bullet point should become 2-4 sentences.
Maintain logical flow between points.
Use the requested tone consistently.
Preserve the structure and hierarchy of the original outline.
Add appropriate transitions between sections.`,
    inputs: [
      { id: 'outline', label: 'Outline to expand', type: 'selection', required: true },
      {
        id: 'tone',
        label: 'Writing tone',
        type: 'select',
        required: false,
        options: ['Professional', 'Casual', 'Academic', 'Creative'],
        defaultValue: 'Professional',
      },
    ],
    outputFormat: 'markdown',
    supportsSelection: true,
    supportsChat: true,
    tags: ['outline', 'expand', 'prose', 'write', 'draft'],
    featured: true,
  },
  {
    name: 'Extract Action Items',
    description: 'Find and list todos, tasks, and action items from any text. Ideal for processing meeting notes or emails.',
    icon: '✅',
    category: 'extraction',
    instructions: `Extract all action items, tasks, and todos from the text.
Format as a clean markdown checklist using "- [ ]" format.
Include any deadlines or assignees mentioned.
Group related items if possible.
Order by priority or chronology if evident.
Be thorough - don't miss any implied tasks.`,
    inputs: [{ id: 'text', label: 'Text to analyze', type: 'selection', required: true }],
    outputFormat: 'markdown',
    supportsSelection: true,
    supportsChat: true,
    tags: ['todo', 'tasks', 'action items', 'extract', 'meeting notes'],
    featured: true,
  },
  {
    name: 'Fix Grammar',
    description: 'Correct grammar, spelling, and punctuation errors while preserving your voice and style.',
    icon: '✏️',
    category: 'editing',
    instructions: `Fix all grammar, spelling, and punctuation errors in the text.
Maintain the original meaning, tone, and voice.
Do not change the style or rewrite unnecessarily.
Fix subject-verb agreement, tense consistency, and punctuation.
Return the corrected text only, without explanations.`,
    inputs: [{ id: 'text', label: 'Text to fix', type: 'selection', required: true }],
    outputFormat: 'replace',
    supportsSelection: true,
    supportsChat: false,
    tags: ['grammar', 'spelling', 'proofread', 'edit', 'correct'],
    featured: false,
  },
  {
    name: 'Translate Text',
    description: 'Translate text to another language while preserving tone and formatting.',
    icon: '🌐',
    category: 'utility',
    instructions: `Translate the text to the specified target language.
Maintain the tone and style of the original.
Preserve formatting if present (markdown, lists, etc).
Use natural, idiomatic expressions in the target language.
Keep proper nouns and technical terms as appropriate.`,
    inputs: [
      { id: 'text', label: 'Text to translate', type: 'selection', required: true },
      {
        id: 'language',
        label: 'Target language',
        type: 'select',
        required: true,
        options: ['Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Chinese', 'Japanese', 'Korean', 'Arabic', 'Russian'],
        defaultValue: 'Spanish',
      },
    ],
    outputFormat: 'text',
    supportsSelection: true,
    supportsChat: true,
    tags: ['translate', 'language', 'localization', 'international'],
    featured: true,
  },
  {
    name: 'Make More Formal',
    description: 'Rewrite text in a more professional, formal tone suitable for business communication.',
    icon: '👔',
    category: 'editing',
    instructions: `Rewrite the text in a more formal, professional tone.
Use proper business language and vocabulary.
Remove colloquialisms, slang, and contractions.
Maintain the core message and all key information.
Use passive voice where appropriate for formality.
Keep the text clear and readable despite the formal tone.`,
    inputs: [{ id: 'text', label: 'Text to formalize', type: 'selection', required: true }],
    outputFormat: 'replace',
    supportsSelection: true,
    supportsChat: true,
    tags: ['formal', 'professional', 'business', 'tone', 'rewrite'],
    featured: false,
  },
  {
    name: 'Simplify Language',
    description: 'Rewrite complex text in simpler, more accessible language.',
    icon: '🔤',
    category: 'editing',
    instructions: `Rewrite the text using simpler, more accessible language.
Break down complex sentences into shorter ones.
Replace jargon and technical terms with plain language.
Explain concepts clearly without oversimplifying.
Maintain all the important information.
Aim for a reading level accessible to general audiences.`,
    inputs: [
      { id: 'text', label: 'Text to simplify', type: 'selection', required: true },
      {
        id: 'level',
        label: 'Target reading level',
        type: 'select',
        required: false,
        options: ['General audience', 'Easy to read', 'Explain like I\'m 10'],
        defaultValue: 'General audience',
      },
    ],
    outputFormat: 'replace',
    supportsSelection: true,
    supportsChat: true,
    tags: ['simplify', 'plain language', 'accessible', 'clarity'],
    featured: false,
  },
  {
    name: 'Generate Meeting Agenda',
    description: 'Create a structured meeting agenda from notes or topics.',
    icon: '📋',
    category: 'generation',
    instructions: `Create a well-structured meeting agenda from the provided topics or notes.
Include time estimates for each item.
Group related topics together.
Add standard sections: Welcome, Main Topics, Action Items, Next Steps.
Format with clear headings and bullet points.
Keep the agenda focused and realistic for the meeting duration.`,
    inputs: [
      { id: 'topics', label: 'Topics or notes', type: 'textarea', required: true, placeholder: 'Enter meeting topics, one per line...' },
      {
        id: 'duration',
        label: 'Meeting duration',
        type: 'select',
        required: false,
        options: ['15 minutes', '30 minutes', '45 minutes', '60 minutes', '90 minutes'],
        defaultValue: '30 minutes',
      },
    ],
    outputFormat: 'markdown',
    supportsSelection: false,
    supportsChat: true,
    tags: ['meeting', 'agenda', 'planning', 'organize'],
    featured: false,
  },
];

/**
 * Get or create system user for built-in skills
 */
function getOrCreateSystemUser() {
  // Check if system user exists
  let user = db.prepare('SELECT id FROM users WHERE email = ?').get(SYSTEM_USER_EMAIL);

  if (!user) {
    // Create system user (no password - can't login)
    const result = db.prepare(`
      INSERT INTO users (email, display_name, email_verified, created_at, updated_at)
      VALUES (?, ?, 1, datetime('now'), datetime('now'))
    `).run(SYSTEM_USER_EMAIL, SYSTEM_USER_NAME);

    user = { id: result.lastInsertRowid };
    console.log(`Created system user with ID: ${user.id}`);
  } else {
    console.log(`Found existing system user with ID: ${user.id}`);
  }

  return user.id;
}

/**
 * Seed a single skill
 */
function seedSkill(skill, authorId) {
  const skillId = crypto.randomUUID();
  const version = '1.0.0';

  // Check if skill already exists
  const existing = db
    .prepare('SELECT id FROM marketplace_skills WHERE name = ? AND author_id = ?')
    .get(skill.name, authorId);

  if (existing) {
    console.log(`  - Skipping "${skill.name}" (already exists)`);
    return null;
  }

  // Insert skill
  db.prepare(`
    INSERT INTO marketplace_skills (
      id, name, description, icon, category,
      author_id, author_name, current_version,
      install_count, avg_rating, rating_count,
      is_featured, tags, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, ?, 'published', datetime('now'), datetime('now'))
  `).run(
    skillId,
    skill.name,
    skill.description,
    skill.icon,
    skill.category,
    authorId,
    SYSTEM_USER_NAME,
    version,
    skill.featured ? 1 : 0,
    JSON.stringify(skill.tags)
  );

  // Insert version
  db.prepare(`
    INSERT INTO skill_versions (
      skill_id, version, instructions, inputs,
      output_format, supports_selection, supports_chat,
      changelog, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Initial release', datetime('now'))
  `).run(
    skillId,
    version,
    skill.instructions,
    JSON.stringify(skill.inputs),
    skill.outputFormat,
    skill.supportsSelection ? 1 : 0,
    skill.supportsChat ? 1 : 0
  );

  console.log(`  ✓ ${skill.name} (${skillId})`);
  return skillId;
}

/**
 * Main seed function
 */
function seedMarketplace() {
  console.log('='.repeat(60));
  console.log('Seeding Marketplace Skills');
  console.log('='.repeat(60));
  console.log('');

  // Get or create system user
  const authorId = getOrCreateSystemUser();
  console.log('');

  // Seed skills in a transaction
  console.log('Adding skills:');
  const seedAll = db.transaction(() => {
    let added = 0;
    let skipped = 0;

    for (const skill of sampleSkills) {
      try {
        const result = seedSkill(skill, authorId);
        if (result) {
          added++;
        } else {
          skipped++;
        }
      } catch (err) {
        console.error(`  ✗ ${skill.name}: ${err.message}`);
      }
    }

    return { added, skipped };
  });

  const result = seedAll();

  console.log('');
  console.log('='.repeat(60));
  console.log(`Done! Added: ${result.added}, Skipped: ${result.skipped}`);
  console.log('='.repeat(60));

  // Show summary
  const stats = db
    .prepare(
      `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN is_featured = 1 THEN 1 ELSE 0 END) as featured
    FROM marketplace_skills
    WHERE status = 'published'
  `
    )
    .get();

  console.log('');
  console.log(`Marketplace now has ${stats.total} published skills (${stats.featured} featured)`);
}

// Run the seed
seedMarketplace();
