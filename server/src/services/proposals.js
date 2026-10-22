// Deterministic email templates. Prices and terms come from code, never from an LLM,
// and the buyer's target and maximum prices are never written into any email.

const money = (value, currency) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);

const qty = (value) => new Intl.NumberFormat('en-US').format(value);

const longDate = (value) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(value),
  );

const DAY_MS = 24 * 60 * 60 * 1000;

/** Quotes are due in 5 days, or sooner if the goods are needed within two weeks. */
export function replyByDate(request, now = new Date()) {
  const inFiveDays = new Date(now.getTime() + 5 * DAY_MS);
  if (!request.deadline) return inFiveDays;
  const weekBeforeDeadline = new Date(new Date(request.deadline).getTime() - 7 * DAY_MS);
  const tomorrow = new Date(now.getTime() + DAY_MS);
  return new Date(Math.max(tomorrow.getTime(), Math.min(inFiveDays.getTime(), weekBeforeDeadline.getTime())));
}

/** e.g. RFQ-46CB27EC-01 — quoted in every email so replies can be matched to the thread. */
export const makeRfqRef = (requestId, index) =>
  `RFQ-${requestId.replace(/-/g, '').slice(0, 8).toUpperCase()}-${String(index).padStart(2, '0')}`;

function signature(request) {
  return [request.buyer_name || 'Procurement Team', request.buyer_email].filter(Boolean).join('\n');
}

export function buildRfq({ request, supplier, rfqRef, now = new Date() }) {
  const subject = `${rfqRef}: Request for quotation – ${request.commodity}, ${qty(request.quantity)} ${request.unit} to ${request.location}`;

  const requirements = [
    `Commodity:          ${request.commodity}`,
    `Specifications:     ${request.specifications || 'Standard commercial grade'}`,
    `Quantity:           ${qty(request.quantity)} ${request.unit}`,
    `Delivery location:  ${request.location}`,
    `Required by:        ${request.deadline ? longDate(request.deadline) : 'Flexible, please state your earliest delivery date'}`,
    `Quote currency:     ${request.currency}`,
  ];

  const body = `Dear ${supplier.name} team,

We are sourcing the goods below and would like to invite you to submit a quotation.

${requirements.join('\n')}

Please include the following in your quotation:
  1. Unit price in ${request.currency} per ${request.unit}, delivered to ${request.location} (please state the Incoterm)
  2. Minimum order quantity, if any
  3. Lead time / delivery time in days from order confirmation
  4. Payment terms
  5. Quote validity period
  6. Relevant certifications or quality documents

We would appreciate your quotation by ${longDate(replyByDate(request, now))}. Please keep the reference ${rfqRef} in the subject line of your reply.

This request for quotation is not a purchase order and does not commit either party.

Kind regards,
${signature(request)}`;

  return { subject, body };
}

/** Our counter-offer. `counterPrice` comes from the negotiation rules, never from an LLM. */
export function buildCounter({ request, supplier, rfqRef, theirPrice, counterPrice, leverage, round, maxRounds }) {
  const subject = `Re: ${rfqRef}: Counter-offer – ${request.commodity}`;
  const competition = leverage ? 'We have received more competitive offers for this requirement, and ' : '';
  const finalNote =
    round === maxRounds ? '\nThis is our final counter-offer for this requirement.\n' : '';

  const body = `Dear ${supplier.name} team,

Thank you for your quotation of ${money(theirPrice, request.currency)} per ${request.unit} (ref ${rfqRef}).

${competition}we would like to propose ${money(counterPrice, request.currency)} per ${request.unit}, delivered to ${request.location}, for ${qty(request.quantity)} ${request.unit}. All other terms as per your quotation.
${finalNote}
Please let us know whether you can accept this price, keeping ${rfqRef} in the subject line.

This message is part of a negotiation and is not a purchase order.

Kind regards,
${signature(request)}`;

  return { subject, body };
}

/** Sent only after a person approves the deal. */
export function buildAcceptance({ request, supplier, rfqRef, price, approvedBy }) {
  const subject = `Re: ${rfqRef}: Offer accepted – ${request.commodity}`;
  const body = `Dear ${supplier.name} team,

We are pleased to confirm that we accept your offer for ${request.commodity}:

Quantity:           ${qty(request.quantity)} ${request.unit}
Unit price:         ${money(price, request.currency)} per ${request.unit}
Total:              ${money(price * request.quantity, request.currency)}
Delivery location:  ${request.location}${request.deadline ? `\nRequired by:        ${longDate(request.deadline)}` : ''}

All other terms are as per your latest quotation (ref ${rfqRef}). A formal purchase order will follow; the order is binding once that purchase order is issued.

Approved by ${approvedBy}.

Kind regards,
${signature(request)}`;

  return { subject, body };
}

/** Polite note to suppliers who quoted but were not selected. */
export function buildRegret({ request, supplier, rfqRef }) {
  const subject = `Re: ${rfqRef}: ${request.commodity} – outcome of our request for quotation`;
  const body = `Dear ${supplier.name} team,

Thank you for your quotation and for your time during our discussions (ref ${rfqRef}).

After careful review we have decided to proceed with another supplier for this requirement. We appreciated your offer and would welcome the opportunity to work with you on future requirements.

Kind regards,
${signature(request)}`;

  return { subject, body };
}
