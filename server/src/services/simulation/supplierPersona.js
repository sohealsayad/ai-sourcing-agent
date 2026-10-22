// Simulated suppliers for demos and tests. Each supplier gets a persona derived from
// its thread id, so it behaves consistently across rounds (and across restarts).

import { round2 } from '../negotiation.js';

/** Small deterministic PRNG (cyrb-style hash seeding a mulberry32 generator). */
export function seededRandom(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAYMENT_TERMS = ['Net 30', 'Net 45', '30% advance, 70% on delivery', '50% advance, 50% before shipment', 'Letter of credit at sight'];
const CONTACTS = ['Priya Nair', 'Omar Haddad', 'Li Wei', 'Sofia Rossi', 'Daniel Okafor', 'Anna Becker'];

/**
 * behavior: ~10% never reply, ~10% decline, the rest quote.
 * floor: the lowest price they will accept (0.90–1.15 × the buyer's target, which they never see).
 */
export function createPersona(seed, { target_price }) {
  const rand = seededRandom(seed);
  const roll = rand();
  const floor = round2(target_price * (0.9 + rand() * 0.25));
  return {
    behavior: roll < 0.1 ? 'no_response' : roll < 0.2 ? 'decline' : 'quote',
    floor,
    opening: round2(floor * (1.15 + rand() * 0.2)),
    flexibility: round2(0.35 + rand() * 0.35),
    deliveryDays: 10 + Math.floor(rand() * 25),
    paymentTerms: PAYMENT_TERMS[Math.floor(rand() * PAYMENT_TERMS.length)],
    validityDays: [7, 14, 30][Math.floor(rand() * 3)],
    contact: CONTACTS[Math.floor(rand() * CONTACTS.length)],
  };
}

/** How the supplier answers our counter-offer. */
export function respondToCounter(persona, { currentPrice, counterPrice }) {
  if (counterPrice >= persona.floor) return { type: 'accept', price: counterPrice };
  const next = round2(Math.max(persona.floor, currentPrice - (currentPrice - counterPrice) * persona.flexibility));
  return next <= persona.floor ? { type: 'final', price: persona.floor } : { type: 'revise', price: next };
}

// ---------------------------------------------------------------------------
// Reply emails, written the way a real supplier might.

const amount = (value) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

function closing(persona, supplierName) {
  return `Best regards,\n${persona.contact}\nSales, ${supplierName}`;
}

function terms(persona) {
  return `Delivery: within ${persona.deliveryDays} days of order confirmation
Payment terms: ${persona.paymentTerms}
Validity: this offer is valid for ${persona.validityDays} days`;
}

/** Builds the reply text for one simulated response. */
export function supplierReply(type, { persona, request, supplierName, rfqRef, price }) {
  const greeting = `Dear ${request.buyer_name || 'Procurement Team'},`;
  const priceLine = `${request.currency} ${amount(price)} per ${request.unit}`;

  switch (type) {
    case 'quote':
      return `${greeting}

Thank you for your enquiry ${rfqRef}. We are pleased to quote as follows:

Product: ${request.commodity}
Quantity: ${request.quantity} ${request.unit}
Price: ${priceLine}, CIF ${request.location}
${terms(persona)}

We look forward to working with you.

${closing(persona, supplierName)}`;

    case 'decline':
      return `${greeting}

Thank you for your enquiry ${rfqRef}. Unfortunately we are unable to quote for this requirement at the moment, as our production capacity is fully allocated for the coming months.

We hope to have the opportunity to work with you in the future.

${closing(persona, supplierName)}`;

    case 'revise':
      return `${greeting}

Thank you for your counter-offer regarding ${rfqRef}. We have reviewed our costs and can improve our price to ${priceLine}, CIF ${request.location}.

${terms(persona)}

${closing(persona, supplierName)}`;

    case 'final':
      return `${greeting}

Thank you for your counter-offer regarding ${rfqRef}. We have gone as low as we can: our best and final price is ${priceLine}, CIF ${request.location}.

${terms(persona)}

${closing(persona, supplierName)}`;

    case 'accept':
      return `${greeting}

Thank you for your counter-offer regarding ${rfqRef}. We accept your counter-offer of ${priceLine}, CIF ${request.location}.

${terms(persona)}

We look forward to receiving your purchase order.

${closing(persona, supplierName)}`;

    default:
      throw new Error(`Unknown reply type ${type}`);
  }
}
