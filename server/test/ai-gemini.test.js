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
// Default here: Gemini's own Google Search grounding. Tavily tests switch it per test.
process.env.SEARCH_PROVIDER = 'gemini';
process.env.TAVILY_API_KEY = 'tvly-test-key';

const { buildConfig, config } = await import('../src/config.js');
const { completeJson, completeWithWebSearch, setAiFetch, setAiSleep } = await import('../src/services/ai.js');
const { buildSearchQueries, findSuppliers } = await import('../src/services/discovery.js');
const { parseReply } = await import('../src/services/replyParser.js');
const { setSearchFetch } = await import('../src/services/webSearch.js');

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

setAiSleep(async () => {}); // in-call retries wait without real delays in tests

afterEach(() => {
  setAiFetch();
  setSearchFetch();
  config.search.provider = 'gemini';
});

describe('AI provider config', () => {
  const BASE = { DATABASE_URL: 'postgres://x/y' };

  test('picks Gemini from AI_PROVIDER or from the key alone', () => {
    const cfg = buildConfig({ ...BASE, AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' });
    assert.equal(cfg.ai.provider, 'gemini');
    assert.equal(cfg.ai.mode, 'live', 'a key turns live mode on by default');
    assert.equal(cfg.ai.gemini.model, 'gemini-3.5-flash');
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

  test('retired models and bad keys are permanent errors (no pointless retries)', async () => {
    fakeGemini(() => ({ status: 404, json: { error: { message: 'This model is no longer available to new users.' } } }));
    await assert.rejects(completeJson({ prompt: 'x' }), (err) => err.permanent === true && /HTTP 404/.test(err.message));
    fakeGemini(() => ({ status: 429, json: {} }));
    await assert.rejects(completeJson({ prompt: 'x' }), (err) => !err.permanent);
  });
});

// ---------------------------------------------------------------------------
// Tavily search + Gemini

const REQUEST = {
  commodity: 'Refined Sunflower Oil',
  specifications: 'Food-grade, sealed 15-litre containers',
  location: 'Hyderabad, Telangana, India',
  quantity: 5000,
  unit: 'kg',
};

/** Fake Tavily: answers per query; `fail(query)` can return { status, json } to simulate errors. */
function fakeTavily(resultsFor, fail = () => null) {
  const calls = [];
  setSearchFetch(async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, headers: opts.headers, body });
    const error = fail(body.query);
    if (error) return { ok: false, status: error.status, json: async () => error.json ?? {} };
    return { ok: true, status: 200, json: async () => ({ query: body.query, results: resultsFor(body.query) }) };
  });
  return calls;
}

const SEARCH_RESULTS = [
  { title: 'Natraj Oil Mills - Sunflower Oil Hyderabad', url: 'https://www.natrajoil.com', content: 'Sri Sarwo Natraj Agro, refined sunflower oil manufacturer in Hyderabad. Bulk supply.' },
  { title: 'Gemini Edibles & Fats', url: 'https://www.geminiedibles.com', content: 'Freedom refined sunflower oil, Hyderabad, Telangana.' },
  { title: 'Kernel Holding SA stock', url: 'https://www.cnbc.com/quotes/KARNF', content: 'Stock quote.' },
];

describe('supplier search with Tavily + Gemini', () => {
  test('builds three search queries from the request', () => {
    const queries = buildSearchQueries(REQUEST);
    assert.equal(queries.length, 3);
    assert.match(queries[0], /Refined Sunflower Oil supplier Hyderabad, Telangana, India contact email/);
    assert.match(queries[2], /Food-grade distributor India$/);
  });

  test('searches with Tavily, lets Gemini pick suppliers from the results, and finds emails on their own domain', async () => {
    config.search.provider = 'tavily';
    const tavily = fakeTavily((query) =>
      query.includes('"Natraj Oil Mills"')
        ? [{ title: 'Contact us', url: 'https://www.natrajoil.com/contact', content: 'Write to sales@natrajoil.com or info@gmail.com' }]
        : query.includes('"Gemini Edibles"')
          ? [{ title: 'Directory', url: 'https://directory.example', content: 'contact: someone@otherdomain.com' }]
          : SEARCH_RESULTS,
    );
    const gemini = fakeGemini(() =>
      textResponse(
        JSON.stringify({
          suppliers: [
            { name: 'Natraj Oil Mills', website: 'https://www.natrajoil.com', email: null, relevance_score: 90, reasoning: 'Hyderabad manufacturer', source_url: 'https://www.natrajoil.com' },
            { name: 'Gemini Edibles & Fats', website: 'https://www.geminiedibles.com', email: null, relevance_score: 80, reasoning: 'Freedom brand', source_url: 'https://www.geminiedibles.com' },
          ],
        }),
      ),
    );

    const result = await findSuppliers(REQUEST);

    // Three discovery searches, sent with the Tavily key; duplicates across queries are merged.
    const discovery = tavily.filter((c) => !c.body.query.includes('"'));
    assert.equal(discovery.length, 3);
    assert.equal(discovery[0].headers.Authorization, 'Bearer tvly-test-key');
    assert.equal(discovery[0].url, 'https://api.tavily.com/search');

    // Gemini gets one plain call (no Google Search tool) containing the deduplicated results.
    assert.equal(gemini.length, 1);
    assert.equal(gemini[0].body.tools, undefined);
    assert.equal(gemini[0].body.generationConfig.responseMimeType, 'application/json');
    const prompt = gemini[0].body.contents[0].parts[0].text;
    assert.equal(prompt.match(/URL: https:\/\/www\.natrajoil\.com\n/g).length, 1, 'each result appears once');
    assert.match(prompt, /Use ONLY these results/);

    assert.equal(result.mode, 'live');
    assert.equal(result.suppliers.length, 2);
    assert.equal(result.suppliers[0].email, 'sales@natrajoil.com', 'email accepted only on the supplier’s own domain');
    assert.equal(result.suppliers[1].email, null, 'an address on another domain is never used');
    assert.ok(result.searchQueries.length >= 3);
  });

  test('falls back to AI knowledge (marked unverified) when Tavily is out of quota', async () => {
    config.search.provider = 'tavily';
    fakeTavily(() => [], () => ({ status: 432, json: { detail: { error: 'Plan usage limit exceeded' } } }));
    fakeGemini(() =>
      textResponse(JSON.stringify({ suppliers: [{ name: 'Ruchi Soya', website: 'https://www.ruchisoya.com', relevance_score: 70, reasoning: 'Large edible oil maker' }] })),
    );
    const result = await findSuppliers(REQUEST);
    assert.equal(result.mode, 'live-unverified');
    assert.match(result.searchError, /Tavily quota or rate limit reached \(HTTP 432\): Plan usage limit exceeded/);
    assert.match(result.suppliers[0].reasoning, /^Not web-verified: /);
  });

  test('a rejected Tavily key fails clearly instead of guessing', async () => {
    config.search.provider = 'tavily';
    fakeTavily(() => [], () => ({ status: 401, json: { detail: { error: 'Unauthorized: missing or invalid API key.' } } }));
    await assert.rejects(findSuppliers(REQUEST), (err) => err.permanent === true && /check TAVILY_API_KEY/.test(err.message));
  });

  test('without any search provider, Gemini suggests suppliers from its knowledge only', async () => {
    config.search.provider = 'none';
    const gemini = fakeGemini(() => textResponse(JSON.stringify({ suppliers: [{ name: 'Known Oils Ltd', website: 'https://knownoils.example', relevance_score: 60 }] })));
    const result = await findSuppliers(REQUEST);
    assert.equal(result.mode, 'live-unverified');
    assert.equal(gemini[0].body.tools, undefined);
    assert.match(gemini[0].body.contents[0].parts[0].text, /You cannot browse the web/);
  });

  test('search provider config: defaults and validation', () => {
    const BASE = { DATABASE_URL: 'postgres://x/y', AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' };
    assert.equal(buildConfig({ ...BASE, TAVILY_API_KEY: 'tvly-1' }).search.provider, 'tavily');
    assert.equal(buildConfig(BASE).search.provider, 'none');
    assert.throws(() => buildConfig({ ...BASE, SEARCH_PROVIDER: 'tavily' }), /SEARCH_PROVIDER=tavily requires TAVILY_API_KEY/);
    assert.throws(() => buildConfig({ ...BASE, SEARCH_PROVIDER: 'bing' }), /SEARCH_PROVIDER must be one of tavily, gemini, none/);
  });
});

describe('job retries', () => {
  test('a permanent error ends the job on the first attempt; others are retried', async () => {
    const { handle } = await import('../src/workflow/worker.js');
    const finals = [];
    const run = (err) => handle('test-job', async () => { throw err; }, async (_job, e) => finals.push(e.message))([{ id: 'j1', data: {}, retryCount: 0, retryLimit: 2 }]);

    await run(Object.assign(new Error('model retired'), { permanent: true }));
    assert.deepEqual(finals, ['model retired'], 'failed immediately, no retry');

    await assert.rejects(run(new Error('temporary outage')), /temporary outage/);
    assert.equal(finals.length, 1, 'a temporary error is rethrown for pg-boss to retry');
  });
});

const OVERLOADED = {
  status: 503,
  json: { error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand. Please try again later.' } },
};

describe('Gemini outages', () => {
  test('a temporary 503 is retried inside the call', async () => {
    let n = 0;
    const calls = fakeGemini(() => (n++ === 0 ? OVERLOADED : textResponse('{"ok": true}')));
    assert.deepEqual(await completeJson({ prompt: 'x', maxTokens: 10 }), { ok: true });
    assert.equal(calls.length, 2);
  });

  test('a lasting 503 says it is a Google-side capacity issue, not the key or model', async () => {
    const calls = fakeGemini(() => OVERLOADED);
    await assert.rejects(completeJson({ prompt: 'x', maxTokens: 10 }), (err) => {
      assert.match(err.message, /Gemini is temporarily unavailable \(HTTP 503 UNAVAILABLE\)/);
      assert.match(err.message, /not your API key or model \(gemini-test-model\)/);
      assert.equal(err.permanent, undefined, 'the job may still retry later');
      return true;
    });
    assert.equal(calls.length, 3);
  });

  test('a network failure is retried; a 404 (wrong model) is not', async () => {
    let n = 0;
    setAiFetch(async () => {
      if (n++ === 0) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return { ok: true, status: 200, json: async () => textResponse('{"ok": 1}').json };
    });
    assert.deepEqual(await completeJson({ prompt: 'x', maxTokens: 10 }), { ok: 1 });
    assert.equal(n, 2);

    const calls = fakeGemini(() => ({ status: 404, json: { error: { message: 'models/x is not found' } } }));
    await assert.rejects(completeJson({ prompt: 'x', maxTokens: 10 }), (err) => err.permanent === true);
    assert.equal(calls.length, 1);
  });

  test('when Gemini fails after the search, discovery fails (no silent fallback) and a retry reuses the search', async () => {
    config.search.provider = 'tavily';
    const tavily = fakeTavily(() => SEARCH_RESULTS);
    let saved = null;
    const saveSearchCache = async (cache) => {
      saved = cache;
    };
    fakeGemini(() => OVERLOADED);
    await assert.rejects(findSuppliers(REQUEST, { saveSearchCache }), /temporarily unavailable/);
    assert.equal(tavily.length, 3, 'three discovery searches');
    assert.equal(Object.keys(saved.searches).length, 3);

    // The job retry reads the request again, now with the cached results.
    fakeGemini(() => textResponse(JSON.stringify({ suppliers: [{ name: 'Natraj Oil Mills', website: 'https://www.natrajoil.com', email: 'sales@natrajoil.com', relevance_score: 90 }] })));
    const result = await findSuppliers({ ...REQUEST, discovery_cache: saved }, { saveSearchCache });
    assert.equal(result.mode, 'live');
    assert.equal(tavily.length, 3, 'no new Tavily searches (credits) on the retry');
  });
});
