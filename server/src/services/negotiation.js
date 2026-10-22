// Pure negotiation rules. The code decides every price; an LLM never does.

export const round2 = (n) => Math.round(n * 100) / 100;

// The first counter anchors a little below target to leave room to concede.
export const ANCHOR_FACTOR = 0.97;
// By the last allowed counter we concede up to this share of the gap.
const MAX_CONCESSION = 0.6;

/** Share of the gap (their price − our anchor) we concede at a given round. */
export function concession(round, maxRounds) {
  if (maxRounds <= 1) return 0;
  return (MAX_CONCESSION * Math.min(round, maxRounds - 1)) / (maxRounds - 1);
}

/**
 * Decides the next move after a supplier quote.
 *
 * @param price          the supplier's current unit price
 * @param isFinal        supplier said this is their final price
 * @param acceptsCounter supplier accepted our last counter-offer
 * @param round          counter-offers already sent to this supplier
 * @param maxRounds      most counter-offers allowed
 * @param bestCompetitor lowest current price from another supplier, if any
 * @returns {{ action: 'ACCEPT'|'FINAL'|'WALK_AWAY'|'COUNTER', reason: string, counterPrice?: number, leverage?: boolean }}
 */
export function decideNextMove({ price, isFinal = false, acceptsCounter = false, target, max = null, round, maxRounds, bestCompetitor = null }) {
  const ceiling = max ?? Infinity;
  const withinMax = price <= ceiling;

  if (acceptsCounter) {
    return withinMax
      ? { action: 'ACCEPT', reason: 'Supplier accepted our counter-offer' }
      : { action: 'WALK_AWAY', reason: 'Agreed price is above the maximum' };
  }
  if (price <= target) return { action: 'ACCEPT', reason: 'Offer meets the target price' };

  if (isFinal || round >= maxRounds) {
    const why = isFinal
      ? 'Supplier stated a final price'
      : `Reached the limit of ${maxRounds} counter-offer${maxRounds === 1 ? '' : 's'}`;
    return withinMax
      ? { action: 'FINAL', reason: `${why}; it is within the maximum` }
      : { action: 'WALK_AWAY', reason: `${why}; it is above the maximum` };
  }

  const anchor = target * ANCHOR_FACTOR;
  let counter = anchor + (price - anchor) * concession(round, maxRounds);
  const leverage = bestCompetitor != null && bestCompetitor < price;
  // Never offer more than a competitor is already charging.
  if (leverage) counter = Math.min(counter, Math.max(anchor, bestCompetitor));
  counter = round2(Math.min(counter, ceiling));

  if (counter >= price) {
    return withinMax
      ? { action: 'FINAL', reason: 'No room left to negotiate; it is within the maximum' }
      : { action: 'WALK_AWAY', reason: 'No room left to negotiate; it is above the maximum' };
  }
  return {
    action: 'COUNTER',
    counterPrice: counter,
    leverage,
    reason: `Counter-offer ${round + 1} of ${maxRounds}`,
  };
}

// ---------------------------------------------------------------------------
// Ranking final offers

export const WEIGHTS = Object.freeze({ price: 0.7, delivery: 0.2, payment: 0.1 });

// Buyer-friendliness of payment terms (more credit = better). First match wins.
const PAYMENT_SCORES = [
  [/100\s*%\s*advance|full advance|prepayment/i, 0.2],
  [/50\s*%\s*advance/i, 0.45],
  [/30\s*%\s*advance/i, 0.6],
  [/letter of credit|\bL\/?C\b/i, 0.6],
  [/on delivery|against delivery|cash against documents/i, 0.7],
  [/net\s*60/i, 1],
  [/net\s*45/i, 0.95],
  [/net\s*30/i, 0.85],
];

export function paymentScore(terms) {
  if (!terms) return 0.5;
  const match = PAYMENT_SCORES.find(([re]) => re.test(terms));
  return match ? match[1] : 0.5;
}

/**
 * Scores offers (0–100) on price, delivery time and payment terms and sorts best first.
 * Offers above `max` are excluded.
 */
export function rankOffers(offers, { max = null } = {}) {
  const eligible = offers.filter((o) => o.price != null && (max == null || o.price <= max));
  if (!eligible.length) return [];

  const minPrice = Math.min(...eligible.map((o) => o.price));
  const days = eligible.map((o) => o.deliveryDays).filter((d) => d > 0);
  const minDays = days.length ? Math.min(...days) : null;

  return eligible
    .map((o) => {
      const price = minPrice / o.price;
      const delivery = minDays && o.deliveryDays > 0 ? minDays / o.deliveryDays : 0.5;
      const payment = paymentScore(o.paymentTerms);
      const score = 100 * (WEIGHTS.price * price + WEIGHTS.delivery * delivery + WEIGHTS.payment * payment);
      return {
        ...o,
        score: round2(score),
        breakdown: { price: round2(price * 100), delivery: round2(delivery * 100), payment: round2(payment * 100) },
      };
    })
    .sort((a, b) => b.score - a.score || a.price - b.price);
}
