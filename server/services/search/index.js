// Main search service orchestrator
// Coordinates classifier, reformulator, search, and caching

import { classifySearchNeed, classifyWithRules, getClassifierUsage, isConfigured as isClassifierConfigured } from './classifier.js';
import { reformulateQuery, getReformulatorUsage, isConfigured as isReformulatorConfigured } from './reformulator.js';
import { TavilySearch, createClient as createTavilyClient, isConfigured as isTavilyConfigured } from './tavily.js';
import * as cache from './cache.js';
import { formatSearchContext, formatSourcesFooter, injectSearchContext, estimateContextTokens } from './context.js';
import { trackSearchUsage, checkSearchLimits, getSearchUsageStats } from './usage.js';

// Re-export components for direct access
export { classifySearchNeed, classifyWithRules } from './classifier.js';
export { reformulateQuery } from './reformulator.js';
export { formatSearchContext, formatSourcesFooter, injectSearchContext } from './context.js';
export { trackSearchUsage, getSearchUsageStats, checkSearchLimits } from './usage.js';
export { getCacheStats, cleanupExpired } from './cache.js';

// Default limits (can be overridden via config)
const DEFAULT_LIMITS = {
  maxSearchesPerDay: parseInt(process.env.SEARCH_MAX_PER_DAY) || 50,
  maxCostPerMonthCents: parseInt(process.env.SEARCH_MAX_COST_PER_MONTH) || 500
};

/**
 * @typedef {Object} SearchPipelineResult
 * @property {boolean} searchExecuted - Whether search was performed
 * @property {string[]} [queries] - Search queries used
 * @property {Object[]} [results] - Search results
 * @property {string} [answer] - Tavily AI summary
 * @property {Object} [formattedContext] - Context for LLM injection
 * @property {Object} cost - Cost breakdown in cents
 * @property {number} cachedCount - Number of cached results used
 * @property {string} [skipReason] - Why search was skipped (if applicable)
 */

/**
 * Execute the full search pipeline
 * @param {Object} options
 * @param {number} options.userId - User ID for tracking
 * @param {string} options.message - User message
 * @param {string} [options.conversationContext] - Recent conversation
 * @param {Object} [options.settings] - Search settings
 * @param {boolean} [options.settings.forceSearch] - Force search execution
 * @param {boolean} [options.settings.skipSearch] - Skip search entirely
 * @param {boolean} [options.settings.skipClassifier] - Skip LLM classifier (use rules only)
 * @param {boolean} [options.settings.skipLimits] - Skip limit checks
 * @param {Object} [options.limits] - Custom limits
 * @returns {Promise<SearchPipelineResult>}
 */
export async function executeSearchPipeline({
  userId,
  message,
  conversationContext,
  settings = {},
  limits = DEFAULT_LIMITS
}) {
  const cost = {
    classifierCents: 0,
    reformulatorCents: 0,
    searchCents: 0,
    totalCents: 0
  };

  // Early exit if search disabled or not configured
  if (settings.skipSearch) {
    return {
      searchExecuted: false,
      cost,
      cachedCount: 0,
      skipReason: 'disabled'
    };
  }

  if (!isTavilyConfigured()) {
    return {
      searchExecuted: false,
      cost,
      cachedCount: 0,
      skipReason: 'tavily_not_configured'
    };
  }

  // Check limits (unless skipped)
  if (!settings.skipLimits && userId) {
    const limitCheck = checkSearchLimits(userId, limits);
    if (!limitCheck.allowed) {
      console.log(`[Search] User ${userId} blocked: ${limitCheck.reason}`);
      return {
        searchExecuted: false,
        cost,
        cachedCount: 0,
        skipReason: limitCheck.reason
      };
    }
  }

  // Step 1: Determine if search is needed
  let shouldSearch = settings.forceSearch;
  let classifierReason = 'forced';

  if (!shouldSearch) {
    if (settings.skipClassifier || !isClassifierConfigured()) {
      // Fast path: rules only
      const ruleResult = classifyWithRules(message);
      shouldSearch = ruleResult.needsSearch;
      classifierReason = `rules:${ruleResult.reason}`;
    } else {
      // Full classifier (rules + LLM for edge cases)
      const classifyResult = await classifySearchNeed(message, conversationContext);
      shouldSearch = classifyResult.needsSearch;
      classifierReason = classifyResult.reason;

      // Track classifier cost if LLM was used
      if (classifyResult.reason?.startsWith('llm:')) {
        const usage = getClassifierUsage();
        // Haiku pricing: ~$0.25/M input, ~$1.25/M output
        cost.classifierCents = Math.ceil((usage.promptTokens * 0.000025) + (usage.completionTokens * 0.000125));
      }
    }
  }

  if (!shouldSearch) {
    return {
      searchExecuted: false,
      cost,
      cachedCount: 0,
      skipReason: classifierReason
    };
  }

  // Step 2: Reformulate query
  let queries;
  if (isReformulatorConfigured()) {
    queries = await reformulateQuery(message, conversationContext);
    const reformulatorUsage = getReformulatorUsage();
    cost.reformulatorCents = Math.ceil((reformulatorUsage.promptTokens * 0.000025) + (reformulatorUsage.completionTokens * 0.000125));
  } else {
    queries = [message];
  }

  // Step 3: Execute search with caching
  let tavily;
  try {
    tavily = createTavilyClient();
  } catch (error) {
    console.error('[Search] Failed to create Tavily client:', error.message);
    return {
      searchExecuted: false,
      cost,
      cachedCount: 0,
      skipReason: 'tavily_error'
    };
  }

  const allResults = [];
  let tavilyAnswer = null;
  let cachedCount = 0;
  let freshCount = 0;

  for (const query of queries) {
    try {
      const { results, answer, cached } = await cache.getOrFetch(
        query,
        async () => {
          const response = await tavily.search(query, {
            maxResults: 5,
            includeAnswer: true
          });
          return {
            results: response.results || [],
            answer: response.answer
          };
        }
      );

      if (cached) {
        cachedCount++;
      } else {
        freshCount++;
      }

      allResults.push(...results);
      if (answer && !tavilyAnswer) {
        tavilyAnswer = answer;
      }
    } catch (error) {
      console.error(`[Search] Query failed: "${query}"`, error.message);
      // Continue with other queries
    }
  }

  // No results? Return early
  if (allResults.length === 0) {
    return {
      searchExecuted: true,
      queries,
      results: [],
      cost,
      cachedCount,
      skipReason: 'no_results'
    };
  }

  // Calculate search cost (only for non-cached)
  cost.searchCents = TavilySearch.estimateCost(freshCount);
  cost.totalCents = cost.classifierCents + cost.reformulatorCents + cost.searchCents;

  // Dedupe results by URL
  const seen = new Set();
  const dedupedResults = allResults.filter(r => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  // Sort by relevance score and limit
  dedupedResults.sort((a, b) => (b.score || 0) - (a.score || 0));
  const topResults = dedupedResults.slice(0, 8);

  // Format for context injection
  const searchResults = {
    results: topResults,
    answer: tavilyAnswer,
    queries
  };

  const formattedContext = formatSearchContext(searchResults);

  // Track usage
  if (userId) {
    trackSearchUsage(userId, {
      queryCount: queries.length,
      cachedCount,
      costCents: cost.totalCents
    });
  }

  return {
    searchExecuted: true,
    queries,
    results: topResults,
    answer: tavilyAnswer,
    formattedContext,
    cost,
    cachedCount,
    contextTokens: estimateContextTokens(formattedContext)
  };
}

/**
 * Check if search service is fully configured
 * @returns {boolean}
 */
export function isConfigured() {
  return isTavilyConfigured();
}

/**
 * Check if all optional components are configured
 * @returns {Object} Configuration status
 */
export function getConfigStatus() {
  return {
    tavily: isTavilyConfigured(),
    classifier: isClassifierConfigured(),
    reformulator: isReformulatorConfigured(),
    fullyConfigured: isTavilyConfigured() && isClassifierConfigured() && isReformulatorConfigured()
  };
}

/**
 * Get default search limits
 * @returns {Object}
 */
export function getDefaultLimits() {
  return { ...DEFAULT_LIMITS };
}
