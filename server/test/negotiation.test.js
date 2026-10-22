import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// config.js requires a DATABASE_URL; these tests never connect.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
process.env.AI_MODE = 'mock';

const { decideNextMove, concession, rankOffers, paymentScore, ANCHOR_FACTOR } = await import('../src/services/negotiation.js');
const { parseReplyText } = await import('../src/services/replyParser.js');
const { createPersona, respondToCounter, supplierReply } = await import('../src/services/simulation/supplierPersona.js');
const { buildCounter, buildRfq } = await import('../src/services/proposals.js');

const base = { target: 850, max: 950, maxRounds: 3, round: 0 };

describe('decideNextMove', () => {
  test('accepts an offer at or below target', () => {
    assert.equal(decideNextMove({ ...base, price: 850 }).action, 'ACCEPT');
    assert.equal(decideNextMove({ ...base, price: 799 }).action, 'ACCEPT');
  });

  test('accepts when the supplier agrees to our counter-offer', () => {
    const d = decideNextMove({ ...base, price: 880, acceptsCounter: true, round: 1 });
    assert.equal(d.action, 'ACCEPT');
    assert.match(d.reason, /accepted our counter-offer/);
  });

  test('first counter anchors below target', () => {
    const d = decideNextMove({ ...base, price: 1000 });
    assert.equal(d.action, 'COUNTER');
    assert.equal(d.counterPrice, Math.round(850 * ANCHOR_FACTOR * 100) / 100);
    assert.ok(d.counterPrice < 850);
  });

  test('counters rise round by round but stay below their price and the max', () => {
    let previous = 0;
    for (let round = 0; round < 3; round++) {
      const d = decideNextMove({ ...base, price: 1000, round });
      assert.equal(d.action, 'COUNTER');
      assert.ok(d.counterPrice > previous, `round ${round} should concede more`);
      assert.ok(d.counterPrice < 1000 && d.counterPrice <= 950);
      previous = d.counterPrice;
    }
  });

  test('never counters above the maximum', () => {
    const d = decideNextMove({ target: 850, max: 860, maxRounds: 2, round: 1, price: 2000 });
    assert.equal(d.action, 'COUNTER');
    assert.equal(d.counterPrice, 860);
  });

  test('uses a lower competing offer as leverage, never countering above it', () => {
    const d = decideNextMove({ ...base, price: 1000, round: 2, bestCompetitor: 880 });
    assert.equal(d.leverage, true);
    assert.ok(d.counterPrice <= 880);
    assert.equal(decideNextMove({ ...base, price: 1000, bestCompetitor: 1200 }).leverage, false);
  });

  test('stops at the round limit: final if within max, walk away if not', () => {
    assert.equal(decideNextMove({ ...base, price: 900, round: 3 }).action, 'FINAL');
    const walk = decideNextMove({ ...base, price: 990, round: 3 });
    assert.equal(walk.action, 'WALK_AWAY');
    assert.match(walk.reason, /limit of 3 counter-offers/);
  });

  test("respects a supplier's final price", () => {
    assert.equal(decideNextMove({ ...base, price: 920, isFinal: true }).action, 'FINAL');
    assert.equal(decideNextMove({ ...base, price: 960, isFinal: true }).action, 'WALK_AWAY');
  });

  test('without a maximum, any final price is acceptable', () => {
    assert.equal(decideNextMove({ target: 850, max: null, maxRounds: 1, round: 1, price: 5000 }).action, 'FINAL');
  });

  test('concession schedule goes from 0 to 60%', () => {
    assert.equal(concession(0, 3), 0);
    assert.equal(concession(1, 3), 0.3);
    assert.equal(concession(2, 3), 0.6);
    assert.equal(concession(0, 1), 0);
  });
});

describe('rankOffers', () => {
  test('ranks by weighted price, delivery and payment terms and drops offers above max', () => {
    const ranked = rankOffers(
      [
        { name: 'Cheap slow', price: 830, deliveryDays: 30, paymentTerms: '100% advance' },
        { name: 'Balanced', price: 845, deliveryDays: 12, paymentTerms: 'Net 45' },
        { name: 'Too expensive', price: 990, deliveryDays: 5, paymentTerms: 'Net 60' },
      ],
      { max: 950 },
    );
    assert.deepEqual(ranked.map((o) => o.name), ['Balanced', 'Cheap slow']);
    assert.ok(ranked[0].score > ranked[1].score);
    assert.ok(ranked[0].score <= 100);
  });

  test('returns nothing when no offer is within max', () => {
    assert.deepEqual(rankOffers([{ price: 1000 }], { max: 950 }), []);
  });

  test('payment terms scoring prefers credit over advance payment', () => {
    assert.ok(paymentScore('Net 60') > paymentScore('Net 30'));
    assert.ok(paymentScore('Net 30') > paymentScore('50% advance, 50% before shipment'));
    assert.ok(paymentScore('30% advance, 70% on delivery') > paymentScore('100% advance'));
    assert.equal(paymentScore(null), 0.5);
  });
});

describe('simulated suppliers', () => {
  const request = { commodity: 'Basmati rice', quantity: 20, unit: 'tonnes', currency: 'USD', location: 'Dubai, UAE', buyer_name: 'Buyer', target_price: 850 };
  const p = createPersona('thread-1', request);

  test('personas are deterministic per thread and stay within bounds', () => {
    assert.deepEqual(createPersona('thread-1', request), p);
    assert.notDeepEqual(createPersona('thread-2', request), p);
    assert.ok(p.floor >= 850 * 0.9 && p.floor <= 850 * 1.15);
    assert.ok(p.opening > p.floor);
  });

  test('responds to counters: accept at/above floor, otherwise revise down to a final floor', () => {
    const persona = { floor: 900, flexibility: 0.5 };
    assert.deepEqual(respondToCounter(persona, { currentPrice: 1000, counterPrice: 910 }), { type: 'accept', price: 910 });
    assert.deepEqual(respondToCounter(persona, { currentPrice: 1000, counterPrice: 850 }), { type: 'revise', price: 925 });
    assert.deepEqual(respondToCounter(persona, { currentPrice: 920, counterPrice: 850 }), { type: 'final', price: 900 });
  });

  test('the parser reads every simulated reply correctly', () => {
    const persona = { ...p, deliveryDays: 21, paymentTerms: 'Net 45', validityDays: 14 };
    const reply = (type, price) => parseReplyText(supplierReply(type, { persona, request, supplierName: 'Acme', rfqRef: 'RFQ-ABCDEF12-01', price }));

    const quote = reply('quote', 1020.5);
    assert.equal(quote.unit_price, 1020.5);
    assert.equal(quote.currency, 'USD');
    assert.equal(quote.delivery_days, 21);
    assert.equal(quote.payment_terms, 'Net 45');
    assert.equal(quote.validity_days, 14);
    assert.equal(quote.is_final, false);
    assert.equal(quote.accepts_counter, false);
    assert.equal(quote.declined, false);

    assert.equal(reply('decline').declined, true);
    assert.equal(reply('decline').unit_price, null);
    assert.equal(reply('revise', 950).unit_price, 950);
    assert.equal(reply('final', 900).is_final, true);
    const accept = reply('accept', 1234.5);
    assert.equal(accept.accepts_counter, true);
    assert.equal(accept.unit_price, 1234.5);
  });

  test('the parser handles common real-world formats', () => {
    assert.equal(parseReplyText('We can do $1,050 / tonne delivered.').unit_price, 1050);
    assert.equal(parseReplyText('We can do $1,050 / tonne delivered.').currency, 'USD');
    assert.equal(parseReplyText('Our price is EUR 990.00 per MT, delivery in 30 days').delivery_days, 30);
    assert.equal(parseReplyText('Thanks, we will get back to you next week.').unit_price, null);
  });
});

describe('outbound emails never reveal the buyer limits', () => {
  const request = { id: '46cb27ec-6006-417f-a724-664ddf0eb924', commodity: 'Basmati rice', quantity: 20, unit: 'tonnes', currency: 'USD', location: 'Dubai, UAE', target_price: 850, max_price: 950, deadline: '2026-12-15' };

  test('RFQ and counter-offers do not contain the target or maximum', () => {
    const rfq = buildRfq({ request, supplier: { name: 'Acme' }, rfqRef: 'RFQ-46CB27EC-01' });
    const counter = buildCounter({ request, supplier: { name: 'Acme' }, rfqRef: 'RFQ-46CB27EC-01', theirPrice: 1000, counterPrice: 824.5, leverage: true, round: 3, maxRounds: 3 });
    for (const text of [rfq.body, rfq.subject, counter.body, counter.subject]) {
      assert.doesNotMatch(text, /850|950/);
    }
    assert.match(counter.body, /\$824\.50 per tonnes/);
    assert.match(counter.body, /more competitive offers/);
    assert.match(counter.body, /final counter-offer/);
    assert.match(counter.body, /not a purchase order/);
  });
});
