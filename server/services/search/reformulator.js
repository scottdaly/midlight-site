// Query reformulation: Convert conversational queries to search-optimized queries
// Uses Gemini 2.5 Flash Lite for fast, cheap reformulation

import { GoogleGenerativeAI } from '@google/generative-ai';

const REFORMULATION_MODEL = 'gemini-2.5-flash-lite';

/**
 * Get the current month and year for time-sensitive queries
 */
function getCurrentDateContext() {
  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'long' });
  const year = now.getFullYear();
  return { month, year, monthYear: `${month} ${year}` };
}

/**
 * Build the reformulation prompt with current date context
 */
function buildReformulationPrompt() {
  const { month, year, monthYear } = getCurrentDateContext();

  return `Convert the user's question into 1-3 optimal web search queries.

Rules:
- Be specific and include relevant context
- For time-sensitive queries (news, latest, recent, today, current), add "${monthYear}" or "this week" to queries
- Remove conversational filler ("I was wondering", "can you tell me", "I need help with")
- Split complex questions into separate focused queries
- Use search-friendly terms (keywords, not natural language questions)
- Max 3 queries to control costs
- Each query should be 3-8 words
- Set isNewsQuery: true if the user is asking about news, current events, latest updates, or recent happenings

Return ONLY valid JSON: {"queries": ["query1", "query2"], "isNewsQuery": boolean}

Examples:
- "what's the latest tesla news" → {"queries": ["Tesla news ${monthYear}", "Tesla announcements this week"], "isNewsQuery": true}
- "what's up with that new chatgpt thing" → {"queries": ["ChatGPT updates ${monthYear}", "OpenAI ChatGPT new features"], "isNewsQuery": true}
- "is the new iphone worth it" → {"queries": ["iPhone 17 review ${year}", "iPhone 17 vs iPhone 16 comparison"], "isNewsQuery": false}
- "who won the election" → {"queries": ["US presidential election 2024 results"], "isNewsQuery": false}
- "best laptop for coding" → {"queries": ["best programming laptops ${year}", "developer laptop recommendations"], "isNewsQuery": false}
- "what's happening with tesla stock" → {"queries": ["Tesla stock price today", "TSLA stock news ${monthYear}"], "isNewsQuery": true}
- "how's the weather in nyc" → {"queries": ["New York City weather forecast"], "isNewsQuery": false}`;
}

/**
 * @typedef {Object} ReformulationResult
 * @property {string[]} queries - Array of 1-3 search queries
 * @property {boolean} isNewsQuery - Whether this is a news/current events query
 */

/**
 * Reformulate user query into search-optimized queries
 * @param {string} userMessage - User's natural language question
 * @param {string} [conversationContext] - Recent conversation for context
 * @returns {Promise<ReformulationResult>} Queries and metadata
 */
export async function reformulateQuery(userMessage, conversationContext) {
  // Detect news queries from the raw message (fallback)
  const newsKeywords = /\b(news|latest|recent|today|current|happening|update|announce)/i;
  const defaultIsNews = newsKeywords.test(userMessage);

  if (!process.env.GEMINI_API_KEY) {
    console.warn('[Reformulator] Gemini not configured, using original query');
    return { queries: [userMessage], isNewsQuery: defaultIsNews };
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  const userContent = conversationContext
    ? `Previous context: ${conversationContext}\n\nCurrent question: ${userMessage}`
    : userMessage;

  try {
    const model = genAI.getGenerativeModel({
      model: REFORMULATION_MODEL,
      systemInstruction: buildReformulationPrompt(),
      generationConfig: { maxOutputTokens: 150, temperature: 0 },
    });

    const result = await model.generateContent(userContent);
    let text = result.response.text() || '{}';

    // Strip markdown code blocks if present
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    try {
      const parsed = JSON.parse(text);
      const queries = parsed.queries || [userMessage];
      const isNewsQuery = parsed.isNewsQuery ?? defaultIsNews;

      // Validate and limit queries
      const validQueries = queries
        .filter(q => typeof q === 'string' && q.trim().length > 0 && q.trim().length <= 100)
        .slice(0, 3)
        .map(q => q.trim());

      if (validQueries.length === 0) {
        return { queries: [userMessage], isNewsQuery };
      }

      return { queries: validQueries, isNewsQuery };
    } catch {
      console.warn('[Reformulator] Failed to parse response:', text);
      return { queries: [userMessage], isNewsQuery: defaultIsNews };
    }
  } catch (error) {
    console.error('[Reformulator] Query reformulation failed:', error.message);
    return { queries: [userMessage], isNewsQuery: defaultIsNews };
  }
}

/**
 * Simple query cleanup without LLM (fallback)
 * @param {string} query - User query
 * @returns {string[]} Cleaned queries
 */
export function cleanupQuery(query) {
  // Remove common filler phrases
  let cleaned = query
    .replace(/^(can you |could you |please |i need |i want |help me |tell me |what is |what are |how do i )/gi, '')
    .replace(/\?+$/, '')
    .trim();

  // If query is too short after cleanup, use original
  if (cleaned.length < 5) {
    cleaned = query;
  }

  return [cleaned];
}

/**
 * Estimate tokens used by reformulator
 * @returns {{promptTokens: number, completionTokens: number}}
 */
export function getReformulatorUsage() {
  return { promptTokens: 300, completionTokens: 50 };
}

/**
 * Check if reformulator is configured
 * @returns {boolean}
 */
export function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}
