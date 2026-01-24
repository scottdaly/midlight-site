// Tavily API client for web search
// Primary search provider (~$5-8/1k searches)

/**
 * @typedef {Object} TavilySearchResult
 * @property {string} title - Page title
 * @property {string} url - Page URL
 * @property {string} content - Extracted content snippet
 * @property {number} score - Relevance score (0-1)
 * @property {string} [publishedDate] - Publication date if available
 */

/**
 * @typedef {Object} TavilyResponse
 * @property {string} [answer] - AI-generated summary
 * @property {TavilySearchResult[]} results - Search results
 * @property {string} query - Original query
 */

export class TavilySearch {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.tavily.com';
  }

  /**
   * Execute a search query
   * @param {string} query - Search query
   * @param {Object} [options] - Search options
   * @param {'basic'|'advanced'} [options.searchDepth='basic'] - Search depth
   * @param {number} [options.maxResults=5] - Max results per query
   * @param {boolean} [options.includeAnswer=true] - Include AI summary
   * @param {string[]} [options.includeDomains] - Whitelist domains
   * @param {string[]} [options.excludeDomains] - Blacklist domains
   * @param {'general'|'news'} [options.topic='general'] - Search topic
   * @param {number} [options.days] - Limit results to last N days
   * @returns {Promise<TavilyResponse>}
   */
  async search(query, options = {}) {
    const body = {
      api_key: this.apiKey,
      query,
      search_depth: options.searchDepth || 'basic',
      max_results: options.maxResults || 5,
      include_answer: options.includeAnswer ?? true,
      include_raw_content: false,
      include_domains: options.includeDomains,
      exclude_domains: options.excludeDomains,
    };

    // Add topic for news-specific searches
    if (options.topic) {
      body.topic = options.topic;
    }

    // Add days filter for recency
    if (options.days) {
      body.days = options.days;
    }

    const response = await fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Tavily search failed: ${response.status} - ${error}`);
    }

    return response.json();
  }

  /**
   * Execute multiple search queries in parallel
   * @param {string[]} queries - Array of search queries
   * @param {Object} [options] - Search options
   * @returns {Promise<TavilyResponse[]>}
   */
  async searchMultiple(queries, options = {}) {
    return Promise.all(queries.map(q => this.search(q, options)));
  }

  /**
   * Get estimated cost for searches
   * @param {number} queryCount - Number of queries
   * @returns {number} Cost in cents
   */
  static estimateCost(queryCount) {
    // Tavily: ~$0.006-0.008 per search (basic)
    // Using 0.7 cents as average
    return Math.ceil(queryCount * 0.7);
  }
}

/**
 * Check if Tavily is configured
 * @returns {boolean}
 */
export function isConfigured() {
  return !!process.env.TAVILY_API_KEY;
}

/**
 * Create a new Tavily client
 * @returns {TavilySearch}
 * @throws {Error} If API key not configured
 */
export function createClient() {
  if (!isConfigured()) {
    throw new Error('Tavily API key not configured (TAVILY_API_KEY)');
  }
  return new TavilySearch(process.env.TAVILY_API_KEY);
}
