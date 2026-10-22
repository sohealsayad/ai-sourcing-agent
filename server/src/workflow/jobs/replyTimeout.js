import { withTransaction } from '../../db/pool.js';
import { syncRequestStatus } from '../progress.js';
import { logEvent, ThreadStatus } from '../stateMachine.js';

/**
 * Closes a thread whose supplier did not answer a round in time. Without any offer the
 * supplier is NO_RESPONSE; otherwise their last offer stands (or is above the maximum).
 */
export async function replyTimeout(job) {
  const { threadId, round } = job.data;

  await withTransaction(async (client) => {
    const { rows: [t] } = await client.query(
      `SELECT rs.*, s.name AS supplier_name, r.max_price
         FROM request_suppliers rs
         JOIN suppliers s ON s.id = rs.supplier_id
         JOIN sourcing_requests r ON r.id = rs.request_id
        WHERE rs.id = $1
        FOR UPDATE OF rs`,
      [threadId],
    );
    const waiting = t && [ThreadStatus.CONTACTED, ThreadStatus.COUNTERED].includes(t.status) && t.rounds_used === round;
    if (!waiting) return;

    let status;
    let reason;
    if (t.current_offer_price == null) {
      status = ThreadStatus.NO_RESPONSE;
      reason = 'No reply to our request for quotation';
    } else if (t.max_price == null || t.current_offer_price <= t.max_price) {
      status = ThreadStatus.FINAL_OFFER;
      reason = 'No reply to our counter-offer; their last offer stands';
    } else {
      status = ThreadStatus.WALKED_AWAY;
      reason = 'No reply to our counter-offer; their last offer is above the maximum';
    }

    await client.query('UPDATE request_suppliers SET status = $2, final_reason = $3, updated_at = now() WHERE id = $1', [
      t.id,
      status,
      reason,
    ]);
    await logEvent(client, t.request_id, 'REPLY_TIMEOUT', { supplier: t.supplier_name, round, outcome: status });
    await syncRequestStatus(client, t.request_id);
  });
}
