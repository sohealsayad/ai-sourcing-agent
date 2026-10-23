import { withTransaction } from '../db/pool.js';
import { HttpError, InvalidTransitionError } from '../errors.js';
import { buildAcceptance, buildRegret } from '../services/proposals.js';
import { lockRequest, logEvent, RequestStatus, ThreadStatus, transition } from './stateMachine.js';

const S = RequestStatus;

// Threads that sent us an offer and should hear the outcome.
const QUOTED = [ThreadStatus.FINAL_OFFER, ThreadStatus.WALKED_AWAY];

async function loadThreads(client, requestId) {
  const { rows } = await client.query(
    `SELECT rs.*, s.name, COALESCE(rs.contact_email, s.email) AS email FROM request_suppliers rs JOIN suppliers s ON s.id = rs.supplier_id
      WHERE rs.request_id = $1 AND rs.selected
      ORDER BY rs.id
      FOR UPDATE OF rs`,
    [requestId],
  );
  return rows;
}

async function queueEmail(client, thread, kind, idempotencyKey, { subject, body }) {
  const { rows } = await client.query(
    `INSERT INTO messages (request_supplier_id, direction, kind, subject, body, to_email, idempotency_key, delivery_status)
     VALUES ($1, 'outbound', $2, $3, $4, $5, $6, 'PENDING')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [thread.id, kind, subject, body, thread.email, idempotencyKey],
  );
  return rows[0]?.id;
}

async function sendRegrets(client, request, losers) {
  const ids = [];
  for (const t of losers) {
    await client.query('UPDATE request_suppliers SET status = $2, updated_at = now() WHERE id = $1', [t.id, ThreadStatus.LOST]);
    const id = await queueEmail(client, t, 'REGRET', `regret:${t.id}`, buildRegret({ request, supplier: t, rfqRef: t.rfq_ref }));
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Step 7: a person approves one final offer. This is the only place an acceptance email is
 * created, and its idempotency key is per request, so at most one supplier is ever accepted.
 * Returns the ids of messages to deliver after commit.
 */
export async function approveDeal(requestId, { requestSupplierId, approvedBy }) {
  return withTransaction(async (client) => {
    const request = await lockRequest(client, requestId);
    if (request.status !== S.DEAL_RECOMMENDED) throw new InvalidTransitionError(request.status, S.CLOSED);

    const eligible = new Set((request.recommendation?.ranked ?? []).map((o) => o.requestSupplierId));
    if (!eligible.has(requestSupplierId)) {
      throw new HttpError(400, 'Only a supplier with an acceptable final offer can be approved');
    }

    const threads = await loadThreads(client, requestId);
    const winner = threads.find((t) => t.id === requestSupplierId);
    const price = winner.current_offer_price;

    await client.query('UPDATE request_suppliers SET status = $2, updated_at = now() WHERE id = $1', [winner.id, ThreadStatus.WON]);
    const acceptanceId = await queueEmail(
      client,
      winner,
      'ACCEPTANCE',
      `acceptance:${requestId}`,
      buildAcceptance({ request, supplier: winner, rfqRef: winner.rfq_ref, price, approvedBy }),
    );
    const regretIds = await sendRegrets(client, request, threads.filter((t) => t.id !== winner.id && QUOTED.includes(t.status)));

    await client.query(
      `UPDATE sourcing_requests SET approved_request_supplier_id = $2, approved_by = $3, approved_at = now() WHERE id = $1`,
      [requestId, winner.id, approvedBy],
    );
    await transition(client, requestId, S.CLOSED, { meta: { approvedBy } });
    await logEvent(client, requestId, 'DEAL_APPROVED', {
      supplier: winner.name,
      price,
      total: price * request.quantity,
      approvedBy,
      recommended: winner.id === request.recommended_request_supplier_id,
    });

    return [acceptanceId, ...regretIds].filter(Boolean);
  });
}

/** Step 7 alternative: a person rejects every offer. Suppliers who quoted are told politely. */
export async function rejectDeals(requestId, { rejectedBy, reason }) {
  return withTransaction(async (client) => {
    const request = await lockRequest(client, requestId);
    if (request.status !== S.DEAL_RECOMMENDED) throw new InvalidTransitionError(request.status, S.CANCELLED);

    const threads = await loadThreads(client, requestId);
    const regretIds = await sendRegrets(client, request, threads.filter((t) => QUOTED.includes(t.status)));

    await transition(client, requestId, S.CANCELLED, { meta: { rejectedBy, reason } });
    await logEvent(client, requestId, 'DEALS_REJECTED', { rejectedBy, reason: reason ?? null });
    return regretIds;
  });
}
