import { config } from '../config.js';

// Web search for live supplier discovery via Tavily (https://tavily.com), which has a free tier.
// Gemini then reads these results; it does not need its own (paid) Google Search grounding.

const TAVILY_URL = 'https://api.tavily.com/search';

let searchFetch = (...args) => fetch(...args);
/** Test hook: replace fetch for Tavily calls (pass nothing to restore). */
export function setSearchFetch(fn) {
  searchFetch = fn ?? ((...args) => fetch(...args));
}

/**
 * Returns [{ title, url, content }] for one query. Errors carry `searchFailed` (so callers can tell
 * a search outage from an AI failure) and `permanent` when retrying cannot help.
 */
export async function searchWeb(query, { maxResults = 8 } = {}) {
  let res;
  try {
    res = await searchFetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.search.tavilyApiKey}` },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic', include_answer: false }),
    });
  } catch (err) {
    throw Object.assign(new Error(`Could not reach Tavily (${err.cause?.code ?? err.message})`), { searchFailed: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(searchError(res, data), { searchFailed: true });
  return (data.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url, content: r.content ?? '' }));
}

function searchError(res, data) {
  const detail = data.detail?.error ?? data.error ?? data.detail ?? '';
  const message = typeof detail === 'string' && detail ? `: ${detail}` : '';
  if (res.status === 401 || res.status === 403) {
    return Object.assign(new Error(`Tavily rejected the API key (HTTP ${res.status})${message}; check TAVILY_API_KEY`), { permanent: true });
  }
  if ([429, 432, 433].includes(res.status)) return new Error(`Tavily quota or rate limit reached (HTTP ${res.status})${message}`);
  return new Error(`Tavily search failed (HTTP ${res.status})${message}`);
}
