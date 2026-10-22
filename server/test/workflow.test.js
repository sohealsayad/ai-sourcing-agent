import {
  closeDatabase,
  drain,
  persona,
  resetDatabase,
  runJob,
  seedRequest,
  setupDatabase,
  startServer,
  takeJobs,
} from './helpers/db.js';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { config } from '../src/config.js';
import { query } from '../src/db/pool.js';
import { setTransport } from '../src/services/mailer.js';
import { JOBS } from '../src/workflow/queue.js';

let api;

before(async () => {
  await setupDatabase();
  api = await startServer();
});

after(async () => {
  await api.close();
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  setTransport();
  config.simulation.suppliers = true;
});

const getRequest = async (id) => (await api.get(`/requests/${id}`)).body;
const threadOf = (r, name) => r.suppliers.find((s) => s.name === name);
const messagesOfKind = async (requestId, kind) =>
  (
    await query(
      `SELECT m.*, s.name FROM messages m
         JOIN request_suppliers rs ON rs.id = m.request_supplier_id
         JOIN suppliers s ON s.id = rs.supplier_id
        WHERE rs.request_id = $1 AND m.kind = $2`,
      [requestId, kind],
    )
  ).rows;

// Alpha accepts our first counter; Beta haggles to its floor; Gamma declines.
const NEGOTIATING_SUPPLIERS = [
  { name: 'Alpha Foods', email: 'sales@alpha.example.com', score: 90, persona: persona({ floor: 820, opening: 1000, deliveryDays: 14, paymentTerms: 'Net 30' }) },
  { name: 'Beta Traders', email: 'sales@beta.example.com', score: 80, persona: persona({ floor: 900, opening: 1100, flexibility: 0.4, deliveryDays: 10, paymentTerms: '50% advance, 50% before shipment' }) },
  { name: 'Gamma Exports', email: 'sales@gamma.example.com', score: 70, persona: persona({ behavior: 'decline' }) },
];

async function runToRecommendation(suppliers = NEGOTIATING_SUPPLIERS, overrides = {}) {
  const { request } = await seedRequest({ suppliers, ...overrides });
  assert.equal((await api.post(`/requests/${request.id}/send-proposals`, {})).status, 202);
  await drain();
  return getRequest(request.id);
}

describe('simulated negotiation', () => {
  test('runs from proposals to a recommended deal', async () => {
    const r = await runToRecommendation();
    assert.equal(r.status, 'DEAL_RECOMMENDED');

    const alpha = threadOf(r, 'Alpha Foods');
    assert.equal(alpha.status, 'FINAL_OFFER');
    assert.equal(alpha.opening_price, 1000);
    assert.equal(alpha.current_offer_price, 824.5); // accepted our anchored first counter
    assert.equal(alpha.rounds_used, 1);

    const beta = threadOf(r, 'Beta Traders');
    assert.equal(beta.status, 'FINAL_OFFER');
    assert.ok(beta.current_offer_price >= 900 && beta.current_offer_price <= 950);
    assert.ok(beta.rounds_used <= r.max_rounds, 'never more counters than allowed');

    assert.equal(threadOf(r, 'Gamma Exports').status, 'DECLINED');

    assert.equal(r.recommended_request_supplier_id, alpha.id);
    assert.equal(r.recommendation.ranked[0].name, 'Alpha Foods');
    assert.equal(r.recommendation.ranked.length, 2);
    assert.equal(r.recommendation.ranked[0].total, 824.5 * 20);
    assert.ok(r.events.some((e) => e.type === 'STATUS_CHANGED' && e.payload.to === 'NEGOTIATING'));
    assert.ok(r.events.some((e) => e.type === 'DEAL_RECOMMENDED'));
  });

  test('no acceptance is sent and no thread is won before a person approves', async () => {
    const r = await runToRecommendation();
    assert.equal((await messagesOfKind(r.id, 'ACCEPTANCE')).length, 0);
    assert.ok(r.suppliers.every((s) => s.status !== 'WON'));
  });

  test('counter-offers never reveal the target or maximum price', async () => {
    const r = await runToRecommendation();
    const outbound = [...(await messagesOfKind(r.id, 'RFQ')), ...(await messagesOfKind(r.id, 'COUNTER'))];
    assert.ok(outbound.length > 3);
    for (const m of outbound) assert.doesNotMatch(`${m.subject}\n${m.body}`, /850|950/);
  });

  test('ends in NO_DEAL when every final price is above the maximum', async () => {
    const r = await runToRecommendation([
      { name: 'Pricey Co', email: 'sales@pricey.example.com', score: 80, persona: persona({ floor: 1000, opening: 1200 }) },
    ]);
    assert.equal(r.status, 'NO_DEAL');
    assert.equal(threadOf(r, 'Pricey Co').status, 'WALKED_AWAY');
    assert.match(r.error, /No supplier offered a price within the maximum/);
  });

  test('accepts an opening quote at or below target without countering', async () => {
    const r = await runToRecommendation([
      { name: 'Bargain Ltd', email: 'sales@bargain.example.com', score: 80, persona: persona({ floor: 800, opening: 840 }) },
    ]);
    assert.equal(r.status, 'DEAL_RECOMMENDED');
    assert.equal(threadOf(r, 'Bargain Ltd').rounds_used, 0);
    assert.equal((await messagesOfKind(r.id, 'COUNTER')).length, 0);
  });

  test('respects max_rounds = 1', async () => {
    const r = await runToRecommendation(
      [{ name: 'Beta Traders', email: 'sales@beta.example.com', score: 80, persona: persona({ floor: 900, opening: 940, flexibility: 0.4 }) }],
      { max_rounds: 1 },
    );
    assert.equal(r.status, 'DEAL_RECOMMENDED');
    assert.equal(threadOf(r, 'Beta Traders').rounds_used, 1);
    assert.equal((await messagesOfKind(r.id, 'COUNTER')).length, 1);
  });

  test('a supplier that never replies is closed by the timeout', async () => {
    const { request } = await seedRequest({
      suppliers: [
        { name: 'Alpha Foods', email: 'sales@alpha.example.com', score: 90, persona: persona({ floor: 800, opening: 840 }) },
        { name: 'Silent Supply', email: 'sales@silent.example.com', score: 80, persona: persona({ behavior: 'no_response' }) },
      ],
    });
    await api.post(`/requests/${request.id}/send-proposals`, {});
    await drain();

    let r = await getRequest(request.id);
    assert.equal(r.status, 'AWAITING_REPLIES');
    assert.equal(threadOf(r, 'Silent Supply').status, 'CONTACTED');

    await drain({ includeDelayed: true }); // fire the reply timeouts
    r = await getRequest(request.id);
    assert.equal(threadOf(r, 'Silent Supply').status, 'NO_RESPONSE');
    assert.equal(r.status, 'DEAL_RECOMMENDED');
    assert.ok(r.events.some((e) => e.type === 'REPLY_TIMEOUT' && e.payload.supplier === 'Silent Supply'));
  });

  test('a duplicate process-reply job is a no-op', async () => {
    const { request } = await seedRequest({
      suppliers: [{ name: 'Alpha Foods', email: 'sales@alpha.example.com', score: 90, persona: persona() }],
    });
    await api.post(`/requests/${request.id}/send-proposals`, {});
    for (const job of takeJobs(JOBS.DELIVER_MESSAGE)) await runJob(job);
    for (const job of takeJobs(JOBS.SIMULATE_SUPPLIER_REPLY)) await runJob(job);

    const [job] = takeJobs(JOBS.PROCESS_REPLY);
    await runJob(job);
    await runJob(job);

    const offers = await query('SELECT * FROM offers');
    assert.equal(offers.rowCount, 1);
    assert.equal((await messagesOfKind(request.id, 'COUNTER')).length, 1);
    const r = await getRequest(request.id);
    assert.equal(r.events.filter((e) => e.type === 'NEGOTIATION_DECISION').length, 1);
  });

  test('a duplicate simulated reply job creates only one reply', async () => {
    const { request } = await seedRequest({
      suppliers: [{ name: 'Alpha Foods', email: 'sales@alpha.example.com', score: 90, persona: persona() }],
    });
    await api.post(`/requests/${request.id}/send-proposals`, {});
    for (const job of takeJobs(JOBS.DELIVER_MESSAGE)) await runJob(job);
    const [sim] = takeJobs(JOBS.SIMULATE_SUPPLIER_REPLY);
    await runJob(sim);
    await runJob(sim);
    assert.equal((await messagesOfKind(request.id, 'REPLY')).length, 1);
  });
});

describe('human approval', () => {
  test('approving sends exactly one acceptance and regrets to the others', async () => {
    const r = await runToRecommendation();
    const alpha = threadOf(r, 'Alpha Foods');

    const res = await api.post(`/requests/${r.id}/approve`, { requestSupplierId: alpha.id, approvedBy: 'Sayad' });
    assert.equal(res.status, 200);
    await drain();

    const closed = await getRequest(r.id);
    assert.equal(closed.status, 'CLOSED');
    assert.equal(closed.approved_by, 'Sayad');
    assert.equal(closed.approved_request_supplier_id, alpha.id);
    assert.equal(threadOf(closed, 'Alpha Foods').status, 'WON');
    assert.equal(threadOf(closed, 'Beta Traders').status, 'LOST');
    assert.equal(threadOf(closed, 'Gamma Exports').status, 'DECLINED'); // declined suppliers are left alone

    const acceptances = await messagesOfKind(r.id, 'ACCEPTANCE');
    assert.equal(acceptances.length, 1);
    assert.equal(acceptances[0].name, 'Alpha Foods');
    assert.equal(acceptances[0].delivery_status, 'SENT');
    assert.match(acceptances[0].body, /Approved by Sayad/);
    assert.match(acceptances[0].body, /\$16,490\.00/); // 824.50 × 20
    assert.match(acceptances[0].body, /binding once that purchase order is issued/);

    const regrets = await messagesOfKind(r.id, 'REGRET');
    assert.deepEqual(regrets.map((m) => m.name), ['Beta Traders']);
    assert.ok(closed.events.some((e) => e.type === 'DEAL_APPROVED' && e.payload.recommended === true));
  });

  test('a different eligible offer than the recommended one can be approved', async () => {
    const r = await runToRecommendation();
    const beta = threadOf(r, 'Beta Traders');
    const res = await api.post(`/requests/${r.id}/approve`, { requestSupplierId: beta.id, approvedBy: 'Sayad' });
    assert.equal(res.status, 200);
    const closed = await getRequest(r.id);
    assert.equal(threadOf(closed, 'Beta Traders').status, 'WON');
    assert.equal(threadOf(closed, 'Alpha Foods').status, 'LOST');
    assert.ok(closed.events.some((e) => e.type === 'DEAL_APPROVED' && e.payload.recommended === false));
  });

  test('approval is refused for ineligible suppliers, wrong states and repeat clicks', async () => {
    const r = await runToRecommendation();
    const gamma = threadOf(r, 'Gamma Exports');
    const alpha = threadOf(r, 'Alpha Foods');

    const ineligible = await api.post(`/requests/${r.id}/approve`, { requestSupplierId: gamma.id, approvedBy: 'Sayad' });
    assert.equal(ineligible.status, 400);
    assert.equal((await api.post(`/requests/${r.id}/approve`, { requestSupplierId: alpha.id })).status, 400); // name required

    assert.equal((await api.post(`/requests/${r.id}/approve`, { requestSupplierId: alpha.id, approvedBy: 'Sayad' })).status, 200);
    const again = await api.post(`/requests/${r.id}/approve`, { requestSupplierId: alpha.id, approvedBy: 'Sayad' });
    assert.equal(again.status, 409);
    assert.equal((await messagesOfKind(r.id, 'ACCEPTANCE')).length, 1);

    const { request: early } = await seedRequest({ status: 'NEGOTIATING' });
    const tooEarly = await api.post(`/requests/${early.id}/approve`, { requestSupplierId: alpha.id, approvedBy: 'Sayad' });
    assert.equal(tooEarly.status, 409);
  });

  test('rejecting all offers cancels the request and notifies suppliers who quoted', async () => {
    const r = await runToRecommendation();
    const res = await api.post(`/requests/${r.id}/reject`, { rejectedBy: 'Sayad', reason: 'Budget frozen' });
    assert.equal(res.status, 200);
    await drain();

    const cancelled = await getRequest(r.id);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal((await messagesOfKind(r.id, 'ACCEPTANCE')).length, 0);
    assert.deepEqual((await messagesOfKind(r.id, 'REGRET')).map((m) => m.name).sort(), ['Alpha Foods', 'Beta Traders']);
  });
});

describe('inbound email webhook', () => {
  test('a real-style reply is matched by RFQ reference and negotiated', async () => {
    config.simulation.suppliers = false; // a "real" supplier answers through the webhook
    const { request } = await seedRequest({
      suppliers: [{ name: 'Alpha Foods', email: 'sales@alpha.example.com', score: 90 }],
    });
    await api.post(`/requests/${request.id}/send-proposals`, {});
    await drain();
    const ref = threadOf(await getRequest(request.id), 'Alpha Foods').rfq_ref;

    const email = {
      from: 'sales@alpha.example.com',
      subject: `Re: ${ref}: Basmati rice`,
      text: 'Hello,\n\nPrice: USD 845.00 per tonne, CIF Dubai\nDelivery: within 12 days\nPayment terms: Net 30\n\nRegards',
      messageId: '<abc@alpha.example.com>',
    };
    const res = await api.post('/webhooks/email', email);
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { matched: true, duplicate: false });

    const dup = await api.post('/webhooks/email', email);
    assert.deepEqual(dup.body, { matched: true, duplicate: true });

    await drain();
    const r = await getRequest(request.id);
    assert.equal(r.status, 'DEAL_RECOMMENDED');
    const alpha = threadOf(r, 'Alpha Foods');
    assert.equal(alpha.current_offer_price, 845);
    assert.equal(alpha.offers[0].delivery_days, 12);
    assert.equal(alpha.offers[0].payment_terms, 'Net 30');
  });

  test('unmatched and unreadable replies are handled safely', async () => {
    config.simulation.suppliers = false;
    const unknown = await api.post('/webhooks/email', { from: 'nobody@example.com', subject: 'Hello', text: 'Hi there' });
    assert.deepEqual(unknown.body, { matched: false, duplicate: false });
    assert.equal((await api.post('/webhooks/email', { subject: 'x' })).status, 400);

    const { request } = await seedRequest({
      suppliers: [{ name: 'Alpha Foods', email: 'sales@alpha.example.com', score: 90 }],
    });
    await api.post(`/requests/${request.id}/send-proposals`, {});
    await drain();
    const ref = threadOf(await getRequest(request.id), 'Alpha Foods').rfq_ref;
    await api.post('/webhooks/email', { from: 'sales@alpha.example.com', subject: `Re: ${ref}`, text: 'Thanks, we will revert next week.' });
    await drain();

    const r = await getRequest(request.id);
    assert.equal(threadOf(r, 'Alpha Foods').status, 'NEEDS_REVIEW');
    assert.equal(r.status, 'NO_DEAL');
  });
});
