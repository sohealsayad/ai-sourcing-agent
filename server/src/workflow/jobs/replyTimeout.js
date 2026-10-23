import { withTransaction } from '../../db/pool.js';
import { syncRequestStatus } from '../progress.js';
import { logEvent, ThreadStatus } from '../stateMachine.js';

const WAITING = [ThreadStatus.CONTACTED, ThreadStatus.COUNTERED];

/**
 * Closes a thread that is waiting for a supplier reply. Without any offer the supplier is
 * NO_RESPONSE; otherwise their last offer stands (or is above the maximum).
 * `round` (timeouts) only closes the thread if it is still waiting for that round;
 * `manual` is the buyer's "Mark as no response". Returns the new status, or null if not waiting.
 */
export async function closeWaitingThread(client, threadId, { round, manual = false } = {}) {
  const { rows: [t] } = await client.query(
    `SELECT rs.*, s.name AS supplier_name, r.max_price
       FROM request_suppliers rs
       JOIN suppliers s ON s.id = rs.supplier_id
       JOIN sourcing_requests r ON r.id = rs.request_id
      WHERE rs.id = $1
      FOR UPDATE OF rs`,
    [threadId],
  );
  const waiting = t && WAITING.includes(t.status) && (round === undefined || t.rounds_used === round);
  if (!waiting) return null;

  const who = manual ? 'Marked as no response by the buyer' : 'No reply';
  let status;
  let reason;
  if (t.current_offer_price == null) {
    status = ThreadStatus.NO_RESPONSE;
    reason = manual ? `${who}; no quote received` : 'No reply to our request for quotation';
  } else if (t.max_price == null || t.current_offer_price <= t.max_price) {
    status = ThreadStatus.FINAL_OFFER;
    reason = `${manual ? who : 'No reply to our counter-offer'}; their last offer stands`;
  } else {
    status = ThreadStatus.WALKED_AWAY;
    reason = `${manual ? who : 'No reply to our counter-offer'}; their last offer is above the maximum`;
  }

  await client.query('UPDATE request_suppliers SET status = $2, final_reason = $3, updated_at = now() WHERE id = $1', [
    t.id,
    status,
    reason,
  ]);
  await logEvent(client, t.request_id, manual ? 'SUPPLIER_CLOSED_MANUALLY' : 'REPLY_TIMEOUT', {
    supplier: t.supplier_name,
    round: t.rounds_used,
    outcome: status,
  });
  await syncRequestStatus(client, t.request_id);
  return status;
}

export async function replyTimeout(job) {
  const { threadId, round } = job.data;
  await withTransaction((client) => closeWaitingThread(client, threadId, { round }));
}
