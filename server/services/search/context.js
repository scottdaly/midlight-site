// Format search results for LLM consumption with citation support
// Follows existing message formatting patterns

/**
 * @typedef {Object} FormattedContext
 * @property {string} systemPromptAddition - Text to append to system prompt
 * @property {Array<{index: number, url: string, title: string}>} sources - Source metadata
 */

/**
 * Format search results for injection into LLM context
 * @param {Object} searchResults - Search results from Tavily
 * @param {Object[]} searchResults.results - Array of search results
 * @param {string} [searchResults.answer] - AI summary from Tavily
 * @param {string[]} [searchResults.queries] - Original search queries
 * @returns {FormattedContext}
 */
export function formatSearchContext(searchResults) {
  const results = searchResults.results || [];

  const sources = results.map((r, i) => ({
    index: i + 1,
    url: r.url,
    title: r.title || 'Untitled',
  }));

  let context = `<search_results>\n`;

  // Include search queries for transparency
  if (searchResults.queries && searchResults.queries.length > 0) {
    context += `<queries>\n${searchResults.queries.join('\n')}\n</queries>\n\n`;
  }

  // Include Tavily's AI summary if available
  if (searchResults.answer) {
    context += `<summary>\n${searchResults.answer}\n</summary>\n\n`;
  }

  // Format individual results
  for (const [i, result] of results.entries()) {
    context += `<source index="${i + 1}">\n`;
    context += `Title: ${result.title || 'Untitled'}\n`;
    context += `URL: ${result.url}\n`;
    if (result.publishedDate) {
      context += `Date: ${result.publishedDate}\n`;
    }
    // Limit content length to avoid bloating context
    const content = result.content || '';
    const truncatedContent = content.length > 500
      ? content.substring(0, 500) + '...'
      : content;
    context += `Content: ${truncatedContent}\n`;
    context += `</source>\n\n`;
  }

  context += `</search_results>`;

  const systemPromptAddition = `You have access to real-time web search results to help answer the user's question.

${context}

CITATION RULES:
- When using information from search results, cite sources using [1], [2], etc.
- Place citations immediately after the relevant claim
- If search results don't contain needed information, acknowledge this
- Prefer more recent sources when information conflicts
- Don't fabricate information not present in the search results
- You can combine information from multiple sources`;

  return { systemPromptAddition, sources };
}

/**
 * Format sources as a footer for the response
 * @param {Array<{index: number, url: string, title: string}>} sources
 * @returns {string}
 */
export function formatSourcesFooter(sources) {
  if (!sources || sources.length === 0) return '';

  let footer = '\n\n---\n**Sources:**\n';
  for (const source of sources) {
    // Escape markdown special characters in title
    const safeTitle = (source.title || 'Untitled')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]');
    footer += `[${source.index}] [${safeTitle}](${source.url})\n`;
  }
  return footer;
}

/**
 * Inject search context into messages array
 * @param {Object[]} messages - Chat messages
 * @param {FormattedContext} searchContext - Formatted search context
 * @returns {Object[]} Messages with search context injected
 */
export function injectSearchContext(messages, searchContext) {
  if (!searchContext || !searchContext.systemPromptAddition) {
    return messages;
  }

  // Find system message or create one
  const systemIndex = messages.findIndex(m => m.role === 'system');

  if (systemIndex >= 0) {
    // Append to existing system message
    const updatedMessages = [...messages];
    updatedMessages[systemIndex] = {
      ...messages[systemIndex],
      content: `${messages[systemIndex].content}\n\n${searchContext.systemPromptAddition}`
    };
    return updatedMessages;
  } else {
    // Prepend new system message
    return [
      { role: 'system', content: searchContext.systemPromptAddition },
      ...messages
    ];
  }
}

/**
 * Estimate token count for search context
 * @param {FormattedContext} context
 * @returns {number} Approximate token count
 */
export function estimateContextTokens(context) {
  if (!context || !context.systemPromptAddition) return 0;

  // Rough estimate: ~4 characters per token
  return Math.ceil(context.systemPromptAddition.length / 4);
}

/**
 * Create a minimal context for when full context is too large
 * @param {Object} searchResults
 * @param {number} maxSources - Maximum number of sources to include
 * @returns {FormattedContext}
 */
export function formatMinimalContext(searchResults, maxSources = 3) {
  const limitedResults = {
    ...searchResults,
    results: (searchResults.results || []).slice(0, maxSources)
  };
  return formatSearchContext(limitedResults);
}
