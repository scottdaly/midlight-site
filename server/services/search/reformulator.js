// Query reformulation: Convert conversational queries to search-optimized queries
// Uses Haiku for fast, cheap reformulation (~$0.001)

import Anthropic from '@anthropic-ai/sdk';

const REFORMULATION_MODEL = 'claude-haiku-4-5-20251001';

const REFORMULATION_PROMPT = `Convert the user's question into 1-3 optimal web search queries.

Rules:
- Be specific and include relevant context
- Include year/date if the question is time-sensitive (current year is 2026)
- Remove conversational filler ("I was wondering", "can you tell me", "I need help with")
- Split complex questions into separate focused queries
- Use search-friendly terms (keywords, not natural language questions)
- Max 3 queries to control costs
- Each query should be 3-8 words

Return ONLY valid JSON: {"queries": ["query1", "query2"]}

Examples:
- "what's up with that new chatgpt thing" → {"queries": ["ChatGPT updates 2026", "OpenAI ChatGPT new features"]}
- "is the new iphone worth it" → {"queries": ["iPhone 17 review 2026", "iPhone 17 vs iPhone 16 comparison"]}
- "who won the election" → {"queries": ["US presidential election 2024 results"]}
- "best laptop for coding" → {"queries": ["best programming laptops 2026", "developer laptop recommendations"]}
- "what's happening with tesla stock" → {"queries": ["Tesla stock price today", "TSLA stock news 2026"]}
- "how's the weather in nyc" → {"queries": ["New York City weather forecast"]}`;

/**
 * Reformulate user query into search-optimized queries
 * @param {string} userMessage - User's natural language question
 * @param {string} [conversationContext] - Recent conversation for context
 * @returns {Promise<string[]>} Array of 1-3 search queries
 */
export async function reformulateQuery(userMessage, conversationContext) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[Reformulator] Anthropic not configured, using original query');
    return [userMessage];
  }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });

  const userContent = conversationContext
    ? `Previous context: ${conversationContext}\n\nCurrent question: ${userMessage}`
    : userMessage;

  try {
    const response = await client.messages.create({
      model: REFORMULATION_MODEL,
      max_tokens: 150,
      system: REFORMULATION_PROMPT,
      messages: [{ role: 'user', content: userContent }]
    });

    let text = response.content[0]?.type === 'text' ? response.content[0].text : '{}';

    // Strip markdown code blocks if present
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    try {
      const parsed = JSON.parse(text);
      const queries = parsed.queries || [userMessage];

      // Validate and limit queries
      const validQueries = queries
        .filter(q => typeof q === 'string' && q.trim().length > 0 && q.trim().length <= 100)
        .slice(0, 3)
        .map(q => q.trim());

      if (validQueries.length === 0) {
        return [userMessage];
      }

      return validQueries;
    } catch {
      console.warn('[Reformulator] Failed to parse response:', text);
      return [userMessage];
    }
  } catch (error) {
    console.error('[Reformulator] Query reformulation failed:', error.message);
    return [userMessage];
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
  return !!process.env.ANTHROPIC_API_KEY;
}
