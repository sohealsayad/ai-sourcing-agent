import { z } from 'zod';
import { config } from '../config.js';
import { completeJson } from './ai.js';

const SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR' };

/**
 * Rule-based extraction of a supplier's quote. Works offline and handles the
 * simulated replies; real-world replies go through the LLM first in live mode.
 */
export function parseReplyText(text, { currency } = {}) {
  // Currency codes are matched case-sensitively so ordinary words ("for 20 …") are not mistaken for one.
  const price = text.match(/(?:\b([A-Z]{3})|([$€£₹]))\s?(\d[\d,]*(?:\.\d{1,2})?)\s*(?:[Pp]er|\/)\s*[A-Za-z]/);
  const delivery = text.match(/deliver(?:y|ed)?\b[^\n\d]{0,40}?(\d{1,3})\s*(?:calendar\s+|working\s+|business\s+)?days?/i);
  const payment = text.match(/payment terms?\s*[:-]\s*([^\n]+)/i);
  const validity = text.match(/valid\s+(?:for\s+)?(\d{1,3})\s*days/i);

  const unitPrice = price ? parseFloat(price[3].replace(/,/g, '')) : null;
  const declined =
    !unitPrice && /\b(unable to (quote|supply|offer)|cannot (quote|supply)|not able to quote|must decline|regret)\b/i.test(text);

  return {
    declined,
    unit_price: unitPrice,
    currency: price ? (price[1] ?? SYMBOLS[price[2]]) : currency ?? null,
    delivery_days: delivery ? Number(delivery[1]) : null,
    payment_terms: payment ? payment[1].trim().replace(/\.$/, '') : null,
    validity_days: validity ? Number(validity[1]) : null,
    is_final: /\b(best and final|final (price|offer)|cannot go (any )?lower|lowest possible)\b/i.test(text),
    accepts_counter: /\b(accept|agree to) your (counter[- ]?offer|offer|proposed price)\b/i.test(text),
  };
}

const ParsedSchema = z.object({
  declined: z.boolean().catch(false),
  unit_price: z.coerce.number().positive().nullable().catch(null),
  currency: z.string().length(3).nullable().catch(null),
  delivery_days: z.coerce.number().int().positive().nullable().catch(null),
  payment_terms: z.string().nullable().catch(null),
  validity_days: z.coerce.number().int().positive().nullable().catch(null),
  is_final: z.boolean().catch(false),
  accepts_counter: z.boolean().catch(false),
});

const llmPrompt = (text, currency) => `Extract the supplier's offer from this email reply to our request for quotation.
Reply with ONLY a JSON object with these keys:
declined (boolean), unit_price (number or null), currency (3-letter code or null; assume ${currency} if not stated),
delivery_days (integer or null), payment_terms (string or null), validity_days (integer or null),
is_final (boolean: they say this is their final/best price), accepts_counter (boolean: they accept our counter-offer).

Email:
"""
${text}
"""`;

/** Parses a reply: Claude JSON extraction in live mode (validated), regex otherwise or as fallback. */
export async function parseReply(text, { currency } = {}) {
  if (config.ai.mode === 'live') {
    try {
      const parsed = ParsedSchema.parse(await completeJson({ prompt: llmPrompt(text, currency) }));
      return { ...parsed, parser: 'llm' };
    } catch (err) {
      console.warn('[replyParser] LLM extraction failed, falling back to rules:', err.message);
    }
  }
  return { ...parseReplyText(text, { currency }), parser: 'rules' };
}
