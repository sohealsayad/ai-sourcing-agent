import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

// Live AI runs on Gemini (AI_PROVIDER=gemini) or Claude (AI_PROVIDER=anthropic). Both expose the
// same two calls below, so supplier discovery and reply parsing do not care which one is used.

const useGemini = () => config.ai.provider === 'gemini';

// ---------------------------------------------------------------------------
// Gemini (REST, no SDK)

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

let aiFetch = (...args) => fetch(...args);
/** Test hook: replace fetch for Gemini calls (pass nothing to restore). */
export function setAiFetch(fn) {
  aiFetch = fn ?? ((...args) => fetch(...args));
}

async function geminiGenerate(body) {
  const { apiKey, model } = config.ai.gemini;
  const res = await aiFetch(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.error?.message ? `: ${data.error.message}` : '';
    if (res.status === 429) throw new Error(`Gemini quota exceeded (HTTP 429)${detail}`);
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error(`Gemini rejected the request (HTTP ${res.status})${detail}; check GEMINI_API_KEY and GEMINI_MODEL`);
    }
    throw new Error(`Gemini request failed (HTTP ${res.status})${detail}`);
  }

  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('');
  if (!text) {
    const reason = candidate?.finishReason ?? data.promptFeedback?.blockReason ?? 'no candidates';
    throw new Error(`Gemini returned no text (${reason})`);
  }
  return { text, candidate, usage: data.usageMetadata };
}

async function geminiWithWebSearch({ prompt, maxTokens }) {
  const { text, candidate, usage } = await geminiGenerate({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    // Grounding with Google Search lets Gemini look up real suppliers.
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: maxTokens },
  });
  return {
    text,
    searchQueries: candidate.groundingMetadata?.webSearchQueries ?? [],
    usage: usage && { input_tokens: usage.promptTokenCount, output_tokens: usage.candidatesTokenCount },
    stopReason: candidate.finishReason,
  };
}

async function geminiJson({ prompt, maxTokens }) {
  const { text } = await geminiGenerate({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, responseMimeType: 'application/json' },
  });
  return extractJson(text);
}

// ---------------------------------------------------------------------------
// Anthropic (Claude)

let client;
const getClient = () => (client ??= new Anthropic({ apiKey: config.ai.apiKey }));

// A server-side tool loop can hit its iteration cap and return `pause_turn`;
// we resend the conversation so Claude can continue where it stopped.
const MAX_CONTINUATIONS = 4;

/**
 * Runs a prompt with web search enabled (Gemini: Google Search grounding; Claude: web_search tool).
 * Returns the final text plus the search queries that were run (for the audit log).
 */
export async function completeWithWebSearch({ prompt, maxSearches = config.ai.maxWebSearches, maxTokens = 8000 }) {
  if (useGemini()) return geminiWithWebSearch({ prompt, maxTokens });

  const messages = [{ role: 'user', content: prompt }];
  const tools = [{ type: config.ai.webSearchTool, name: 'web_search', max_uses: maxSearches }];
  const searchQueries = [];
  let response;

  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    response = await getClient().messages.create({
      model: config.ai.model,
      max_tokens: maxTokens,
      tools,
      messages,
    });

    for (const block of response.content) {
      if (block.type === 'server_tool_use' && block.name === 'web_search' && block.input?.query) {
        searchQueries.push(block.input.query);
      }
    }

    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content });
  }

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return { text, searchQueries, usage: response.usage, stopReason: response.stop_reason };
}

/** Single-turn completion that must answer with a JSON object (no tools). */
export async function completeJson({ prompt, maxTokens = 1000 }) {
  if (useGemini()) return geminiJson({ prompt, maxTokens });

  const response = await getClient().messages.create({
    model: config.ai.model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return extractJson(text);
}

/** Pulls the JSON object out of a model reply (fenced ```json block, or the outermost braces). */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!candidate.trim()) throw new Error('Model reply contained no JSON');
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new Error(`Model reply was not valid JSON: ${err.message}`);
  }
}
