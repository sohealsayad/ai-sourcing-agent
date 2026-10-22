import fs from 'node:fs';
import { z } from 'zod';
import { config } from '../config.js';
import { completeWithWebSearch, extractJson } from './ai.js';

const promptTemplate = fs.readFileSync(new URL('../prompts/discovery.md', import.meta.url), 'utf8');

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

export function renderPrompt(request) {
  const values = {
    commodity: request.commodity,
    specifications: request.specifications || 'None given',
    location: request.location,
    quantity: request.quantity,
    unit: request.unit,
    maxSuppliers: config.maxSuppliers,
  };
  return promptTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key] ?? ''));
}

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

/** Finds suppliers for a request. Returns { suppliers, searchQueries, mode }. */
export async function findSuppliers(request) {
  if (config.ai.mode === 'mock') {
    return { suppliers: normalizeSuppliers(mockSuppliers(request)), searchQueries: [], mode: 'mock' };
  }

  const { text, searchQueries, usage } = await completeWithWebSearch({ prompt: renderPrompt(request) });
  const suppliers = normalizeSuppliers(extractJson(text));
  return { suppliers, searchQueries, usage, mode: 'live' };
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
