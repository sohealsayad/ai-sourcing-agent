import { withTransaction } from '../../db/pool.js';
import { isSimulatedTransport, PermanentDeliveryError, sendEmail } from '../../services/mailer.js';
import { syncRequestStatus } from '../progress.js';
import { logEvent, ThreadStatus } from '../stateMachine.js';

// Called after a message is delivered, outside the transaction (e.g. to schedule supplier replies).
const afterDeliveredHooks = [];
export const onDelivered = (fn) => afterDeliveredHooks.push(fn);

async function loadForUpdate(client, messageId) {
  const { rows } = await client.query(
    `SELECT m.*, rs.request_id, rs.rounds_used, rs.current_offer_price, rs.rfq_ref, s.name AS supplier_name, r.max_price
       FROM messages m
       JOIN request_suppliers rs ON rs.id = m.request_supplier_id
       JOIN suppliers s ON s.id = rs.supplier_id
       JOIN sourcing_requests r ON r.id = rs.request_id
      WHERE m.id = $1
      FOR UPDATE OF m, rs`,
    [messageId],
  );
  return rows[0];
}

async function markFailed(client, msg, error) {
  await client.query(
    `UPDATE messages SET delivery_status = 'FAILED', attempts = attempts + 1, error = $2 WHERE id = $1`,
    [msg.id, error],
  );
  if (msg.kind === 'RFQ') {
    await client.query(
      `UPDATE request_suppliers SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`,
      [msg.request_supplier_id, ThreadStatus.SEND_FAILED, error],
    );
  } else if (msg.kind === 'COUNTER') {
    // We could not counter, so the supplier's last offer is where this negotiation ends.
    const withinMax = msg.max_price == null || msg.current_offer_price <= msg.max_price;
    await client.query(
      `UPDATE request_suppliers SET status = $2, final_reason = $3, last_error = $4, updated_at = now() WHERE id = $1`,
      [
        msg.request_supplier_id,
        withinMax ? ThreadStatus.FINAL_OFFER : ThreadStatus.WALKED_AWAY,
        'Counter-offer could not be delivered; their last offer stands',
        error,
      ],
    );
  }
  await logEvent(client, msg.request_id, msg.kind === 'RFQ' ? 'PROPOSAL_FAILED' : 'MESSAGE_FAILED', {
    kind: msg.kind,
    supplier: msg.supplier_name,
    attempts: msg.attempts + 1,
    error,
  });
  await syncRequestStatus(client, msg.request_id);
}

/**
 * Delivers one outbound message. Safe to run any number of times: the message row is
 * locked and only a PENDING message is sent, so retries and duplicate jobs cannot send twice.
 */
export async function deliverMessage(job, { isFinalAttempt }) {
  const { messageId } = job.data;

  const outcome = await withTransaction(async (client) => {
    const msg = await loadForUpdate(client, messageId);
    if (!msg || msg.direction !== 'outbound' || msg.delivery_status !== 'PENDING') return { skipped: true };

    let externalId;
    try {
      ({ externalId } = await sendEmail({
        to: msg.to_email,
        subject: msg.subject,
        body: msg.body,
        idempotencyKey: msg.idempotency_key,
        rfqRef: msg.rfq_ref,
      }));
    } catch (err) {
      // A blocked recipient will never succeed, so fail now instead of retrying.
      if (isFinalAttempt || err instanceof PermanentDeliveryError) {
        await markFailed(client, msg, err.message);
        return { failed: true };
      }
      // Keep it PENDING so the retry picks it up; record the attempt for visibility.
      await client.query('UPDATE messages SET attempts = attempts + 1, error = $2 WHERE id = $1', [msg.id, err.message]);
      await logEvent(client, msg.request_id, 'MESSAGE_RETRYING', {
        kind: msg.kind,
        supplier: msg.supplier_name,
        attempt: msg.attempts + 1,
        error: err.message,
      });
      return { retry: err };
    }

    await client.query(
      `UPDATE messages
          SET delivery_status = 'SENT', attempts = attempts + 1, sent_at = now(), external_id = $2,
              error = NULL, simulated = $3
        WHERE id = $1`,
      [msg.id, externalId, isSimulatedTransport()],
    );
    await client.query(
      `UPDATE request_suppliers
          SET status = CASE WHEN $2 = 'RFQ' AND status = 'QUEUED' THEN 'CONTACTED' ELSE status END,
              last_contacted_at = now(), last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [msg.request_supplier_id, msg.kind],
    );
    await logEvent(client, msg.request_id, 'MESSAGE_SENT', {
      kind: msg.kind,
      supplier: msg.supplier_name,
      to: msg.to_email,
      simulated: isSimulatedTransport(),
    });
    await syncRequestStatus(client, msg.request_id);
    return { sent: true, msg };
  });

  if (outcome.retry) throw outcome.retry; // pg-boss retries with backoff
  if (outcome.sent) for (const hook of afterDeliveredHooks) await hook(outcome.msg);
}

/** Final-attempt fallback when the job itself crashed (e.g. a database error). */
export async function failDelivery(job, err) {
  await withTransaction(async (client) => {
    const msg = await loadForUpdate(client, job.data.messageId);
    if (msg && msg.delivery_status === 'PENDING') await markFailed(client, msg, err.message);
  });
}
