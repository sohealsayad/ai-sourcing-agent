import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

// Live mode on Gemini with a fake API (no network). Set before config.js is loaded.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
process.env.AI_MODE = 'live';
process.env.AI_PROVIDER = 'gemini';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.GEMINI_MODEL = 'gemini-test-model';
process.env.EMAIL_TRANSPORT = 'simulated';
process.env.INBOUND_PROVIDER = 'none';

const { buildConfig } = await import('../src/config.js');
const { completeJson, completeWithWebSearch, setAiFetch } = await import('../src/services/ai.js');
const { findSuppliers } = await import('../src/services/discovery.js');
const { parseReply } = await import('../src/services/replyParser.js');

/** Records requests and answers with a Gemini generateContent response. */
function fakeGemini(respond) {
  const calls = [];
  setAiFetch(async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, headers: opts.headers, body });
    const { status = 200, json } = respond(body);
    return { ok: status < 400, status, json: async () => json };
  });
  return calls;
}

const textResponse = (text, extra = {}) => ({
  json: {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', ...extra }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 80 },
  },
});

afterEach(() => setAiFetch());

describe('AI provider config', () => {
  const BASE = { DATABASE_URL: 'postgres://x/y' };

  test('picks Gemini from AI_PROVIDER or from the key alone', () => {
    const cfg = buildConfig({ ...BASE, AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' });
    assert.equal(cfg.ai.provider, 'gemini');
    assert.equal(cfg.ai.mode, 'live', 'a key turns live mode on by default');
    assert.equal(cfg.ai.gemini.model, 'gemini-2.5-flash');
    assert.equal(buildConfig({ ...BASE, GEMINI_API_KEY: 'k' }).ai.provider, 'gemini');
  });

  test('without any key it stays in mock mode', () => {
    const cfg = buildConfig(BASE);
    assert.equal(cfg.ai.mode, 'mock');
    assert.equal(buildConfig({ ...BASE, AI_PROVIDER: 'gemini' }).ai.mode, 'mock');
  });

  test('live mode requires the key of the chosen provider', () => {
    assert.throws(() => buildConfig({ ...BASE, AI_MODE: 'live', AI_PROVIDER: 'gemini' }), /AI_PROVIDER=gemini requires GEMINI_API_KEY/);
    assert.throws(() => buildConfig({ ...BASE, AI_MODE: 'live', AI_PROVIDER: 'anthropic', GEMINI_API_KEY: 'k' }), /requires ANTHROPIC_API_KEY/);
    assert.equal(buildConfig({ ...BASE, AI_MODE: 'live', ANTHROPIC_API_KEY: 'k' }).ai.provider, 'anthropic', 'Claude still works');
  });

  test('rejects an unknown provider', () => {
    assert.throws(() => buildConfig({ ...BASE, AI_PROVIDER: 'openai' }), /AI_PROVIDER must be one of gemini, anthropic/);
  });
});

describe('Gemini calls', () => {
  test('supplier search uses Google Search grounding and reports the queries', async () => {
    const calls = fakeGemini(() => textResponse('{"suppliers": []}', { groundingMetadata: { webSearchQueries: ['basmati rice exporters hyderabad'] } }));
    const result = await completeWithWebSearch({ prompt: 'find suppliers', maxTokens: 4000 });

    const [call] = calls;
    assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent');
    assert.equal(call.headers['x-goog-api-key'], 'test-gemini-key');
    assert.deepEqual(call.body.tools, [{ google_search: {} }]);
    assert.deepEqual(call.body.contents, [{ role: 'user', parts: [{ text: 'find suppliers' }] }]);
    assert.equal(call.body.generationConfig.maxOutputTokens, 4000);

    assert.equal(result.text, '{"suppliers": []}');
    assert.deepEqual(result.searchQueries, ['basmati rice exporters hyderabad']);
    assert.deepEqual(result.usage, { input_tokens: 120, output_tokens: 80 });
  });

  test('live supplier discovery returns normalized suppliers from a Gemini answer', async () => {
    const answer = '```json\n' + JSON.stringify({
      suppliers: [
        { name: 'Deccan Rice Mills', website: 'https://deccanrice.example', email: 'Sales@DeccanRice.example', relevance_score: 88, reasoning: 'Hyderabad miller' },
        { name: 'No Contact Traders', relevance_score: 95 },
      ],
    }) + '\n```';
    fakeGemini(() => textResponse(answer, { groundingMetadata: { webSearchQueries: ['q1', 'q2'] } }));

    const { suppliers, searchQueries, mode, usage } = await findSuppliers({ commodity: '1121 Basmati rice', location: 'Hyderabad', quantity: 10, unit: 'tonnes' });
    assert.equal(mode, 'live');
    assert.deepEqual(searchQueries, ['q1', 'q2']);
    assert.equal(usage.input_tokens, 120);
    assert.equal(suppliers.length, 1, 'suppliers without email or website are dropped');
    assert.equal(suppliers[0].email, 'sales@deccanrice.example');
  });

  test('reply parsing asks Gemini for JSON and uses its answer', async () => {
    const calls = fakeGemini(() =>
      textResponse('{"declined": false, "unit_price": 16500, "currency": "INR", "delivery_days": 10, "payment_terms": "Net 30", "validity_days": 7, "is_final": false, "accepts_counter": false}'),
    );
    const parsed = await parseReply('We can supply at Rs 16,500 per tonne.', { currency: 'INR' });
    assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
    assert.equal(calls[0].body.tools, undefined, 'no search for reply parsing');
    assert.equal(parsed.parser, 'llm');
    assert.equal(parsed.unit_price, 16500);
    assert.equal(parsed.delivery_days, 10);
  });

  test('completeJson parses fenced JSON too', async () => {
    fakeGemini(() => textResponse('```json\n{"ok": true}\n```'));
    assert.deepEqual(await completeJson({ prompt: 'x' }), { ok: true });
  });

  test('clear errors for a bad key, quota limits and empty answers', async () => {
    fakeGemini(() => ({ status: 400, json: { error: { message: 'API key not valid. Please pass a valid API key.' } } }));
    await assert.rejects(completeJson({ prompt: 'x' }), /HTTP 400\): API key not valid.*check GEMINI_API_KEY/);

    fakeGemini(() => ({ status: 429, json: { error: { message: 'Resource has been exhausted' } } }));
    await assert.rejects(completeWithWebSearch({ prompt: 'x' }), /Gemini quota exceeded \(HTTP 429\)/);

    fakeGemini(() => ({ json: { candidates: [], promptFeedback: { blockReason: 'SAFETY' } } }));
    await assert.rejects(completeJson({ prompt: 'x' }), /Gemini returned no text \(SAFETY\)/);
  });

  test('reply parsing falls back to the built-in rules if Gemini fails', async () => {
    fakeGemini(() => ({ status: 500, json: {} }));
    const parsed = await parseReply('Price: INR 16,500.00 per tonne\nDelivery: within 10 days', { currency: 'INR' });
    assert.equal(parsed.parser, 'rules');
    assert.equal(parsed.unit_price, 16500);
  });
});
