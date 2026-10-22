import assert from 'node:assert/strict';
import { test } from 'node:test';

// config.js requires a DATABASE_URL; these tests never connect.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
process.env.AI_MODE = 'mock';

const { extractJson } = await import('../src/services/ai.js');
const { normalizeSuppliers, renderPrompt, findSuppliers } = await import('../src/services/discovery.js');
const { canTransition } = await import('../src/workflow/stateMachine.js');
const { CreateRequestSchema } = await import('../src/validation/request.js');

test('extractJson reads a fenced block and ignores surrounding prose', () => {
  const text = 'Here you go:\n```json\n{"suppliers":[{"name":"Acme"}]}\n```\nThanks';
  assert.deepEqual(extractJson(text), { suppliers: [{ name: 'Acme' }] });
});

test('extractJson falls back to the outermost braces', () => {
  assert.deepEqual(extractJson('Result: {"a": {"b": 1}} done'), { a: { b: 1 } });
});

test('extractJson throws on a reply without JSON', () => {
  assert.throws(() => extractJson('I could not find anything.'), /no JSON|not valid JSON/);
});

test('normalizeSuppliers drops unreachable entries, cleans bad fields, de-dupes and sorts', () => {
  const result = normalizeSuppliers(
    {
      suppliers: [
        { name: 'Low', email: 'a@low.com', relevance_score: 40 },
        { name: 'High', website: 'https://www.high.com', email: 'not-an-email', relevance_score: '95' },
        { name: 'High duplicate', website: 'https://high.com/contact', relevance_score: 90 },
        { name: 'No contact', relevance_score: 99 },
        { name: 'X' }, // name too short
      ],
    },
    5,
  );

  assert.deepEqual(
    result.map((s) => s.name),
    ['High', 'Low'],
  );
  assert.equal(result[0].email, null);
  assert.equal(result[0].relevance_score, 95);
});

test('normalizeSuppliers respects the limit', () => {
  const suppliers = Array.from({ length: 10 }, (_, i) => ({ name: `Supplier ${i}`, email: `s${i}@x.com` }));
  assert.equal(normalizeSuppliers({ suppliers }, 3).length, 3);
});

test('renderPrompt fills every placeholder', () => {
  const prompt = renderPrompt({ commodity: 'Basmati rice', location: 'Dubai, UAE', quantity: 20, unit: 'tonnes' });
  assert.match(prompt, /Basmati rice/);
  assert.match(prompt, /20 tonnes/);
  assert.doesNotMatch(prompt, /\{\{\w+\}\}/);
});

test('mock discovery returns ranked, contactable suppliers on example.com', async () => {
  const { suppliers, mode } = await findSuppliers({ commodity: 'Steel rebar', location: 'Chennai, India' });
  assert.equal(mode, 'mock');
  assert.ok(suppliers.length > 0);
  assert.ok(suppliers.every((s) => s.email.endsWith('.example.com')));
  assert.ok(suppliers[0].relevance_score >= suppliers.at(-1).relevance_score);
});

test('state machine only allows defined transitions', () => {
  assert.equal(canTransition('DRAFT', 'DISCOVERING'), true);
  assert.equal(canTransition('DISCOVERING', 'SUPPLIERS_FOUND'), true);
  assert.equal(canTransition('FAILED', 'DISCOVERING'), true);
  assert.equal(canTransition('DRAFT', 'NEGOTIATING'), false);
  assert.equal(canTransition('CLOSED', 'DISCOVERING'), false);
});

test('CreateRequestSchema coerces form strings and treats blanks as missing', () => {
  const d = CreateRequestSchema.parse({
    commodity: ' Basmati rice ',
    location: 'Dubai',
    quantity: '20',
    unit: 'tonnes',
    target_price: '850',
    max_price: '',
    currency: 'usd',
    deadline: '',
  });
  assert.equal(d.commodity, 'Basmati rice');
  assert.equal(d.quantity, 20);
  assert.equal(d.currency, 'USD');
  assert.equal(d.max_price, undefined);
  assert.equal(d.deadline, undefined);
});

test('CreateRequestSchema rejects a max price below the target', () => {
  const r = CreateRequestSchema.safeParse({
    commodity: 'Rice',
    location: 'Dubai',
    quantity: 1,
    unit: 'kg',
    target_price: 100,
    max_price: 50,
    currency: 'USD',
  });
  assert.equal(r.success, false);
  assert.deepEqual(r.error.issues[0].path, ['max_price']);
});
