/**
 * GitHub Integration Service
 *
 * Creates and updates GitHub issues for error tracking.
 * Uses the GitHub REST API directly (no @octokit dependency needed).
 *
 * Configuration (environment variables):
 * - GITHUB_TOKEN: Personal access token with `repo` scope
 */

import db from '../db/index.js';
import { logger } from '../utils/logger.js';

const GITHUB_API = 'https://api.github.com';

function getToken() {
  return process.env.GITHUB_TOKEN;
}

function getHeaders() {
  const token = getToken();
  if (!token) throw new Error('GITHUB_TOKEN not configured');

  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

/**
 * Create or update a GitHub issue for an error
 *
 * @param {object} rule - The alert rule (must have github_repo set)
 * @param {object} issue - The error issue
 * @returns {Promise<boolean>} - Whether the operation succeeded
 */
export async function createOrUpdateGitHubIssue(rule, issue) {
  const repo = rule.github_repo;
  if (!repo) {
    logger.warn({ ruleId: rule.id }, 'GitHub alert rule has no github_repo configured');
    return false;
  }

  const token = getToken();
  if (!token) {
    logger.warn('GITHUB_TOKEN not configured — skipping GitHub issue creation');
    return false;
  }

  const dashboardUrl = process.env.SITE_URL
    ? `${process.env.SITE_URL}/admin/errors`
    : 'https://midlight.ai/admin/errors';

  try {
    // Check if issue already has a linked GitHub issue
    const existingUrl = issue.github_issue_url;

    if (existingUrl && issue.regressed) {
      // Regression: comment on existing issue and reopen
      return await commentAndReopen(repo, existingUrl, issue, dashboardUrl);
    }

    if (existingUrl) {
      // Already has an issue, just add a comment about new occurrences
      return await addComment(existingUrl, issue, dashboardUrl);
    }

    // Create a new GitHub issue
    return await createIssue(repo, issue, dashboardUrl);
  } catch (err) {
    logger.error({ error: err?.message || err, repo }, 'Error in GitHub integration');
    return false;
  }
}

async function createIssue(repo, issue, dashboardUrl) {
  const labels = ['bug', 'error-tracking', issue.category].filter(Boolean);

  const body = buildIssueBody(issue, dashboardUrl);
  const title = `[Error] ${issue.error_type}: ${(issue.message_pattern || '').slice(0, 80)}`;

  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ title, body, labels }),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, body: text }, 'Failed to create GitHub issue');
    return false;
  }

  const data = await res.json();

  // Store the GitHub issue URL on the error issue
  try {
    db.prepare('UPDATE error_issues SET github_issue_url = ? WHERE id = ?')
      .run(data.html_url, issue.id);
  } catch (err) {
    logger.debug({ error: err?.message }, 'Failed to store github_issue_url');
  }

  logger.info({ issueId: issue.id, githubUrl: data.html_url }, 'Created GitHub issue');
  return true;
}

async function commentAndReopen(repo, githubUrl, issue, dashboardUrl) {
  const issueNumber = extractIssueNumber(githubUrl);
  if (!issueNumber) return false;

  const comment = `## Regression Detected\n\n` +
    `This error has **regressed** in version \`${issue.last_regression_version || 'unknown'}\`.\n\n` +
    `- **Occurrences:** ${issue.occurrence_count}\n` +
    `- **Regression count:** ${issue.regression_count || 1}\n\n` +
    `[View in dashboard](${dashboardUrl})`;

  // Add comment
  const commentRes = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ body: comment }),
  });

  // Reopen issue
  const reopenRes = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify({ state: 'open' }),
  });

  return commentRes.ok && reopenRes.ok;
}

async function addComment(githubUrl, issue, dashboardUrl) {
  const issueNumber = extractIssueNumber(githubUrl);
  const repo = extractRepo(githubUrl);
  if (!issueNumber || !repo) return false;

  // Only comment if occurrence count is a milestone (10, 50, 100, 500, etc.)
  const count = issue.occurrence_count;
  const milestones = [10, 25, 50, 100, 250, 500, 1000];
  if (!milestones.includes(count)) return true; // Skip but return success

  const comment = `This error has reached **${count} occurrences**.\n\n` +
    `[View in dashboard](${dashboardUrl})`;

  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ body: comment }),
  });

  return res.ok;
}

function buildIssueBody(issue, dashboardUrl) {
  return `## Error Report\n\n` +
    `**Category:** \`${issue.category}\`\n` +
    `**Error Type:** \`${issue.error_type}\`\n` +
    `**Status:** ${issue.status}\n` +
    `**Occurrences:** ${issue.occurrence_count || 1}\n\n` +
    (issue.message_pattern ? `### Pattern\n\`\`\`\n${issue.message_pattern}\n\`\`\`\n\n` : '') +
    `### Details\n` +
    `- **First seen:** ${issue.first_seen_at || 'unknown'}\n` +
    `- **Last seen:** ${issue.last_seen_at || 'unknown'}\n` +
    `- **Fingerprint:** \`${issue.fingerprint}\`\n\n` +
    `[View in Midlight Dashboard](${dashboardUrl})\n\n` +
    `---\n_Auto-created by Midlight error monitoring_`;
}

function extractIssueNumber(url) {
  const match = url?.match(/\/issues\/(\d+)/);
  return match ? match[1] : null;
}

function extractRepo(url) {
  const match = url?.match(/github\.com\/([^/]+\/[^/]+)\/issues/);
  return match ? match[1] : null;
}

export default { createOrUpdateGitHubIssue };
