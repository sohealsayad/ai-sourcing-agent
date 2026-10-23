import { query } from '../../db/pool.js';
import { ingestInboundEmail } from '../../services/inbound.js';
import { createPersona, respondToCounter, supplierReply } from '../../services/simulation/supplierPersona.js';
import { ThreadStatus } from '../stateMachine.js';

const AWAITING = [ThreadStatus.CONTACTED, ThreadStatus.COUNTERED];

/**
 * Plays the supplier: answers our RFQ (round 0) or our latest counter-offer (round n).
 * The reply goes through ingestInboundEmail(), exactly like a real email would.
 */
export async function simulateSupplierReply(job) {
  const { threadId, round } = job.data;
  const { rows } = await query(
    `SELECT rs.*, s.name AS supplier_name, COALESCE(rs.contact_email, s.email) AS email,
            r.commodity, r.quantity, r.unit, r.currency, r.location, r.target_price, r.buyer_name
       FROM request_suppliers rs
       JOIN suppliers s ON s.id = rs.supplier_id
       JOIN sourcing_requests r ON r.id = rs.request_id
      WHERE rs.id = $1`,
    [threadId],
  );
  const t = rows[0];
  // Skip if the thread moved on (timed out, already answered this round, ...).
  if (!t || !AWAITING.includes(t.status) || t.rounds_used !== round) return;

  let persona = t.sim_profile;
  if (!persona) {
    persona = createPersona(t.id, t);
    await query('UPDATE request_suppliers SET sim_profile = $2 WHERE id = $1 AND sim_profile IS NULL', [t.id, persona]);
  }

  let type;
  let price;
  if (round === 0) {
    if (persona.behavior === 'no_response') return; // the reply timeout will close this thread
    type = persona.behavior === 'decline' ? 'decline' : 'quote';
    price = persona.opening;
  } else {
    const { rows: [counter] } = await query(
      `SELECT parsed_json FROM messages WHERE request_supplier_id = $1 AND kind = 'COUNTER'
        ORDER BY created_at DESC LIMIT 1`,
      [t.id],
    );
    ({ type, price } = respondToCounter(persona, {
      currentPrice: t.current_offer_price,
      counterPrice: counter.parsed_json.counter_price,
    }));
  }

  await ingestInboundEmail({
    from: t.email,
    subject: `Re: ${t.rfq_ref}: ${t.commodity}`,
    body: supplierReply(type, { persona, request: t, supplierName: t.supplier_name, rfqRef: t.rfq_ref, price }),
    idempotencyKey: `sim-reply:${t.id}:${round}`,
    simulated: true,
  });
}
