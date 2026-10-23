import fs from 'node:fs';
import { z } from 'zod';
import { config } from '../config.js';
import { completeJson, completeWithWebSearch, extractJson } from './ai.js';
import { searchWeb } from './webSearch.js';

const promptTemplate = fs.readFileSync(new URL('../prompts/discovery.md', import.meta.url), 'utf8');
const resultsPromptTemplate = fs.readFileSync(new URL('../prompts/discovery-from-results.md', import.meta.url), 'utf8');

// LLM output is untrusted: coerce what we can and null out fields that fail validation
// instead of rejecting the whole supplier.
const nullableString = z.string().trim().min(1).nullish().catch(null);

const SupplierSchema = z.object({
  name: z.string().trim().min(2),
  website: z.string().trim().url().nullish().catch(null),
  email: z.string().trim().toLowerCase().email().nullish().catch(null),
  phone: nullableString,
  location: nullableString,
  description: nullableString,
  relevance_score: z.coerce.number().min(0).max(100).catch(50),
  reasoning: z.string().trim().catch(''),
  source_url: z.string().trim().url().nullish().catch(null),
});

function fillTemplate(template, request, extra = {}) {
  const values = {
    commodity: request.commodity,
    specifications: request.specifications || 'None given',
    location: request.location,
    quantity: request.quantity,
    unit: request.unit,
    maxSuppliers: config.maxSuppliers,
    ...extra,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key] ?? ''));
}

export const renderPrompt = (request) => fillTemplate(promptTemplate, request);

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
};

/** Validates, filters and de-duplicates raw supplier objects from the model. */
export function normalizeSuppliers(raw, limit = config.maxSuppliers) {
  const list = Array.isArray(raw?.suppliers) ? raw.suppliers : Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const result = [];

  for (const item of list) {
    const parsed = SupplierSchema.safeParse(item);
    if (!parsed.success) continue;
    const s = parsed.data;

    // Without an email or a website there is no way to reach the supplier.
    if (!s.email && !s.website) continue;

    const key = s.email || hostOf(s.website) || s.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(s);
  }

  return result.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, limit);
}

/**
 * Finds suppliers for a request. Returns { suppliers, searchQueries, mode, usage?, searchError? }.
 * - mock: generated demo suppliers
 * - Claude, or Gemini with SEARCH_PROVIDER=gemini: the model searches the web itself
 * - Gemini + SEARCH_PROVIDER=tavily: Tavily searches, Gemini picks suppliers from the results
 * - Gemini + no search (or search unavailable): suppliers from Gemini's knowledge, marked unverified
 */
export async function findSuppliers(request, { saveSearchCache } = {}) {
  if (config.ai.mode === 'mock') {
    return { suppliers: normalizeSuppliers(mockSuppliers(request)), searchQueries: [], mode: 'mock' };
  }

  if (config.ai.provider === 'gemini' && config.search.provider !== 'gemini') {
    if (config.search.provider === 'tavily') {
      try {
        return await findWithTavily(request, saveSearchCache);
      } catch (err) {
        // Only a search outage falls back to AI knowledge (clearly marked unverified). A bad key, or
        // Gemini itself failing after the search, fails the job so it is retried with the cached results.
        if (err.permanent || !err.searchFailed) throw err;
        return { ...(await findFromKnowledge(request)), searchError: err.message };
      }
    }
    return findFromKnowledge(request);
  }

  const { text, searchQueries, usage } = await completeWithWebSearch({ prompt: renderPrompt(request) });
  const suppliers = normalizeSuppliers(extractJson(text));
  return { suppliers, searchQueries, usage, mode: 'live' };
}

// ---------------------------------------------------------------------------
// Tavily + Gemini

const MAX_RESULTS_FOR_MODEL = 15;
const MAX_EMAIL_LOOKUPS = 5;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Search queries for a request; the country is the last part of the location ("Guntur, AP, India" → "India"). */
export function buildSearchQueries(request) {
  const country = request.location.split(',').at(-1).trim();
  const spec = (request.specifications ?? '').split(/[,.;]/)[0].trim().slice(0, 60);
  return [
    `${request.commodity} supplier ${request.location} contact email`,
    `${request.commodity} manufacturer wholesale ${request.location}`,
    `${request.commodity} ${spec} distributor ${country}`.replace(/\s+/g, ' ').trim(),
  ];
}

const formatResults = (results) =>
  results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content.replace(/\s+/g, ' ').slice(0, 700)}`).join('\n\n');

/**
 * Tavily search that remembers results per query on the request (`discovery_cache`), so a job
 * retry after a Gemini failure reuses them instead of spending search credits again.
 */
function cachedSearch(request, saveSearchCache) {
  const cache = { ...(request.discovery_cache?.searches ?? {}) };
  return async (query, options) => {
    if (cache[query]) return cache[query];
    cache[query] = await searchWeb(query, options);
    await saveSearchCache?.({ searches: cache });
    return cache[query];
  };
}

async function findWithTavily(request, saveSearchCache) {
  const search = cachedSearch(request, saveSearchCache);
  const searchQueries = buildSearchQueries(request);
  const byUrl = new Map();
  for (const query of searchQueries) {
    for (const r of await search(query)) if (r.url && !byUrl.has(r.url)) byUrl.set(r.url, r);
  }
  const results = [...byUrl.values()].slice(0, MAX_RESULTS_FOR_MODEL);
  if (!results.length) return { suppliers: [], searchQueries, mode: 'live' };

  const raw = await completeJson({
    prompt: fillTemplate(resultsPromptTemplate, request, { results: formatResults(results) }),
    maxTokens: 4000,
  });
  const suppliers = normalizeSuppliers(raw);
  const lookups = await addEmailsFromSearch(suppliers, request, search);
  return { suppliers, searchQueries: [...searchQueries, ...lookups], mode: 'live' };
}

/**
 * Snippets rarely contain emails, so for suppliers without one run a small "<name> contact email"
 * search and accept only an address on the supplier's own domain (never a guess).
 */
async function addEmailsFromSearch(suppliers, request, search) {
  const queries = [];
  for (const s of suppliers.filter((x) => !x.email && x.website).slice(0, MAX_EMAIL_LOOKUPS)) {
    const domain = hostOf(s.website);
    if (!domain) continue;
    const query = `"${s.name}" ${request.location.split(',')[0]} contact email`;
    queries.push(query);
    try {
      const results = await search(query, { maxResults: 5 });
      const found = results
        .flatMap((r) => `${r.content} ${r.title}`.match(EMAIL_RE) ?? [])
        .map((e) => e.toLowerCase())
        .find((e) => e.endsWith(`@${domain}`) || e.endsWith(`.${domain}`));
      if (found) s.email = found;
    } catch {
      // Best effort: keep the supplier without an email.
    }
  }
  return queries;
}

// Gemini only, no web search: clearly marked so nobody mistakes it for verified data.
async function findFromKnowledge(request) {
  const prompt = `${renderPrompt(request)}

IMPORTANT: You cannot browse the web right now. Only list companies you are confident exist. Leave email, phone and source_url null unless you are certain they are correct.`;
  const suppliers = normalizeSuppliers(await completeJson({ prompt, maxTokens: 4000 })).map((s) => ({
    ...s,
    reasoning: `Not web-verified: ${s.reasoning}`.trim(),
  }));
  return { suppliers, searchQueries: [], mode: 'live-unverified' };
}

// ---------------------------------------------------------------------------
// Mock mode: realistic-looking demo suppliers so the workflow runs without an API key.
// All addresses use the reserved example.com domain, so nothing can be emailed by accident.

function mockSuppliers(request) {
  const city = request.location.split(',')[0].trim();
  const item = request.commodity.trim();
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const templates = [
    [`${city} ${item} Traders`, 'Regional wholesaler with own warehousing', 92],
    [`Global ${item} Exports`, 'Large exporter shipping to over 30 countries', 86],
    [`${item} Direct Manufacturing`, 'Manufacturer selling direct to bulk buyers', 81],
    [`Prime ${item} Supply Co.`, 'Distributor focused on mid-size orders', 74],
    [`${city} Industrial Sourcing`, 'General industrial supplier with a broad catalogue', 63],
    [`Eastern ${item} Partners`, 'Newer supplier with competitive pricing', 58],
  ];

  return {
    suppliers: templates.map(([name, description, score]) => {
      const domain = `${slug(name)}.example.com`;
      return {
        name,
        website: `https://${domain}`,
        email: `sales@${domain}`,
        phone: null,
        location: request.location,
        description: `${description}.`,
        relevance_score: score,
        reasoning: `Mock result: ${description.toLowerCase()} for ${item} near ${city}.`,
        source_url: `https://${domain}/contact`,
      };
    }),
  };
}
