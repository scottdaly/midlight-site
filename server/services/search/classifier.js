// Search need classification with rule-based + LLM hybrid approach
// Follows existing provider pattern in services/llm/

import Anthropic from '@anthropic-ai/sdk';

// Haiku model for fast, cheap classification
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

// Pattern definitions for rule-based classification
const SEARCH_TRIGGERS = {
  // High confidence: temporal indicators
  temporal: /\b(latest|recent|current|today|now|this week|this month|yesterday|2024|2025|2026)\b/i,

  // High confidence: real-time data
  realtime: /\b(price|stock|weather|forecast|score|result|news|update|breaking|live)\b/i,

  // High confidence: current state questions
  currentState: /\b(who is the|what is the current|is .+ still|are .+ still|has .+ changed|did .+ happen)\b/i,

  // Medium confidence: product/shopping intent
  shopping: /\b(buy|purchase|compare|review|best|cheapest|vs|versus|alternative|recommend|top \d+)\b/i,

  // Medium confidence: research indicators
  research: /\b(how to|what happened|why did|when did|where is|statistics|data|study|report|according to)\b/i,

  // High confidence: explicit search requests
  explicit: /\b(search|look up|find out|google|check online|find information|search for|look for)\b/i,

  // Medium confidence: specific entities that change
  entities: /\b(ceo of|president of|leader of|head of|founder of|owner of)\b/i,
};

const NO_SEARCH_INDICATORS = {
  // Creative tasks
  creative: /\b(write me|create|generate|compose|draft|brainstorm|imagine|make up|invent)\b/i,

  // Code help
  coding: /\b(code|function|error|debug|implement|refactor|syntax|compile|runtime|bug|fix this)\b/i,

  // Explanations of concepts (timeless knowledge)
  explanation: /\b(explain|what is a|what are|how does .+ work|concept of|definition of|meaning of)\b/i,

  // Math/calculations
  math: /\b(calculate|solve|equation|formula|compute|math|sum|multiply|divide|percentage)\b/i,

  // Personal/conversational
  personal: /\b(feel|think|opinion|advice|help me decide|should i|what would you)\b/i,

  // Document context (user already has the info)
  documentContext: /\b(in this document|in the file|this text|the above|summarize this|based on this)\b/i,

  // Translation/language tasks
  translation: /\b(translate|in french|in spanish|in german|how do you say)\b/i,
};

/**
 * @typedef {Object} ClassifierResult
 * @property {boolean} needsSearch - Whether search is recommended
 * @property {'high'|'medium'|'low'} confidence - Confidence level
 * @property {string} [reason] - Explanation for the decision
 */

/**
 * Fast rule-based classifier (0ms, $0)
 * @param {string} message - User message to classify
 * @returns {ClassifierResult}
 */
export function classifyWithRules(message) {
  // Check explicit no-search indicators first
  for (const [category, pattern] of Object.entries(NO_SEARCH_INDICATORS)) {
    if (pattern.test(message)) {
      // Override if there's also a strong search signal
      const hasStrongSearchSignal =
        SEARCH_TRIGGERS.temporal.test(message) ||
        SEARCH_TRIGGERS.realtime.test(message) ||
        SEARCH_TRIGGERS.explicit.test(message);

      if (!hasStrongSearchSignal) {
        return { needsSearch: false, confidence: 'high', reason: `no_search:${category}` };
      }
    }
  }

  // Check search triggers
  const matchedTriggers = [];

  for (const [category, pattern] of Object.entries(SEARCH_TRIGGERS)) {
    if (pattern.test(message)) {
      matchedTriggers.push(category);
    }
  }

  // Multiple triggers = high confidence
  if (matchedTriggers.length >= 2) {
    return { needsSearch: true, confidence: 'high', reason: matchedTriggers.join(',') };
  }

  // Single high-confidence trigger
  if (matchedTriggers.length === 1) {
    const trigger = matchedTriggers[0];
    const highConfidenceTriggers = ['temporal', 'realtime', 'explicit', 'currentState'];

    if (highConfidenceTriggers.includes(trigger)) {
      return { needsSearch: true, confidence: 'high', reason: trigger };
    }

    return { needsSearch: true, confidence: 'medium', reason: trigger };
  }

  // No triggers = low confidence, default to no search
  return { needsSearch: false, confidence: 'low', reason: 'no_triggers' };
}

// LLM classifier prompt
const CLASSIFIER_PROMPT = `You are a search need classifier. Analyze the user message and determine if web search would help answer it.

Return ONLY valid JSON: {"needsSearch": boolean, "reason": "brief explanation"}

SEARCH NEEDED for:
- Current events, news, recent developments
- Real-time data (prices, weather, scores, stocks)
- Product comparisons, reviews, recommendations
- Facts that could have changed (who holds a position, current laws)
- Specific recent dates/events (2024-2026)
- Questions about things after your knowledge cutoff
- Verification of current facts

NO SEARCH for:
- General knowledge, definitions, explanations of concepts
- Creative writing, brainstorming, imagination tasks
- Code help, debugging, programming questions
- Math, calculations, formulas
- Personal advice, opinions, hypotheticals
- Timeless concepts, historical facts (before 2024)
- User already provided the information in context
- Translation or language tasks

Be conservative - only return needsSearch: true when search would genuinely improve the answer.`;

/**
 * LLM-based classifier for edge cases (~$0.001, ~200ms)
 * @param {string} message - User message
 * @param {string} [conversationContext] - Recent conversation for context
 * @returns {Promise<{needsSearch: boolean, reason: string}>}
 */
export async function classifyWithLLM(message, conversationContext) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[SearchClassifier] Anthropic not configured, falling back to rules');
    return { needsSearch: false, reason: 'no_api_key' };
  }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });

  const userContent = conversationContext
    ? `Context: ${conversationContext}\n\nUser message: ${message}`
    : message;

  try {
    const response = await client.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 100,
      system: CLASSIFIER_PROMPT,
      messages: [{ role: 'user', content: userContent }]
    }, { timeout: 1500 }); // 1.5s timeout — this is a non-critical optimization step

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '{}';

    try {
      const parsed = JSON.parse(text);
      return {
        needsSearch: !!parsed.needsSearch,
        reason: parsed.reason || 'llm_decision'
      };
    } catch {
      console.warn('[SearchClassifier] Failed to parse LLM response:', text);
      return { needsSearch: false, reason: 'parse_error' };
    }
  } catch (error) {
    console.error('[SearchClassifier] LLM classification failed:', error.message);
    return { needsSearch: false, reason: 'llm_error' };
  }
}

/**
 * Hybrid classifier: fast rules first, LLM for edge cases
 * @param {string} message - User message
 * @param {string} [conversationContext] - Recent conversation
 * @returns {Promise<ClassifierResult>}
 */
export async function classifySearchNeed(message, conversationContext) {
  // Step 1: Fast rule-based check
  const ruleResult = classifyWithRules(message);

  // High confidence either way? Trust the rules
  if (ruleResult.confidence === 'high') {
    return ruleResult;
  }

  // Medium/low confidence? Use LLM for edge cases
  const llmResult = await classifyWithLLM(message, conversationContext);

  return {
    needsSearch: llmResult.needsSearch,
    confidence: 'high', // LLM adjudicated
    reason: `llm:${llmResult.reason}`
  };
}

/**
 * Estimate tokens used by classifier (for cost tracking)
 * @returns {{promptTokens: number, completionTokens: number}}
 */
export function getClassifierUsage() {
  // Approximate tokens for Haiku classifier call
  return { promptTokens: 250, completionTokens: 30 };
}

/**
 * Check if classifier LLM is configured
 * @returns {boolean}
 */
export function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}
