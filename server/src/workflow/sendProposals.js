import { withTransaction } from '../db/pool.js';
import { HttpError, InvalidTransitionError } from '../errors.js';
import { recipientAllowed } from '../services/mailer.js';
import { buildRfq, makeRfqRef } from '../services/proposals.js';
import { syncRequestStatus } from './progress.js';
import { lockRequest, logEvent, RequestStatus, ThreadStatus, transition } from './stateMachine.js';

const S = RequestStatus;

/** Statuses in which more suppliers can still be added and invited. */
export const LATE_INVITE_STATUSES = [S.AWAITING_REPLIES, S.NEGOTIATING];

/**
 * Step 3: selects suppliers and writes one RFQ per supplier to the outbox.
 *
 * - From SUPPLIERS_FOUND: sends to the given threads (default: every supplier with an email).
 * - From FAILED (a previous send where nothing could be delivered): retries the same threads.
 *
 * Each RFQ has the idempotency key `rfq:<threadId>`, so a retry re-uses the existing row
 * instead of creating a second proposal. Returns the ids of messages that need delivery;
 * the caller enqueues them after this transaction commits.
 */
export async function queueProposals(requestId, requestSupplierIds) {
  return withTransaction(async (client) => {
    const request = await lockRequest(client, requestId);
    const { rows: all } = await client.query(
      `SELECT rs.id, rs.status, rs.selected, rs.rfq_ref, s.name, COALESCE(rs.contact_email, s.email) AS email
         FROM request_suppliers rs
         JOIN suppliers s ON s.id = rs.supplier_id
        WHERE rs.request_id = $1
        ORDER BY rs.relevance_score DESC NULLS LAST, s.name, rs.id`,
      [requestId],
    );

    let threads;
    if (request.status === S.SUPPLIERS_FOUND) {
      threads = requestSupplierIds ? pickThreads(all, requestSupplierIds) : all.filter((t) => recipientAllowed(t.email));
      if (!threads.length) {
        throw new HttpError(
          400,
          all.some((t) => t.email)
            ? 'None of the suppliers can be emailed: their addresses are not in EMAIL_ALLOWED_RECIPIENTS'
            : 'Select at least one supplier with an email address',
        );
      }
    } else if (request.status === S.FAILED) {
      threads = all.filter((t) => t.selected && [ThreadStatus.SEND_FAILED, ThreadStatus.QUEUED].includes(t.status));
      // A request that failed during discovery has nothing to resend.
      if (!threads.length) throw new InvalidTransitionError(request.status, S.SENDING_PROPOSALS);
    } else if (LATE_INVITE_STATUSES.includes(request.status)) {
      // Inviting more suppliers while others are already quoting: explicit choice only.
      if (!requestSupplierIds) throw new HttpError(400, 'Choose which suppliers to invite');
      threads = pickThreads(all, requestSupplierIds);
      const contacted = threads.filter((t) => t.status !== ThreadStatus.PENDING);
      if (contacted.length) {
        throw new HttpError(400, `Already contacted: ${contacted.map((t) => t.name).join(', ')}`);
      }
    } else {
      throw new InvalidTransitionError(request.status, S.SENDING_PROPOSALS);
    }

    // References continue from the highest one used, so suppliers added later never reuse a number.
    let nextRef = Math.max(0, ...all.map((t) => Number(t.rfq_ref?.split('-').pop()) || 0)) + 1;
    const messageIds = [];
    for (const t of threads) {
      const rfqRef = t.rfq_ref ?? makeRfqRef(requestId, nextRef++);
      await client.query(
        `UPDATE request_suppliers
            SET selected = true, status = $2, rfq_ref = $3, last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [t.id, ThreadStatus.QUEUED, rfqRef],
      );

      const { subject, body } = buildRfq({ request, supplier: t, rfqRef });
      const { rows } = await client.query(
        `INSERT INTO messages (request_supplier_id, direction, kind, subject, body, to_email, idempotency_key, delivery_status)
         VALUES ($1, 'outbound', 'RFQ', $2, $3, $4, $5, 'PENDING')
         ON CONFLICT (idempotency_key) DO UPDATE
           SET delivery_status = CASE WHEN messages.delivery_status = 'FAILED' THEN 'PENDING' ELSE messages.delivery_status END,
               error = CASE WHEN messages.delivery_status = 'FAILED' THEN NULL ELSE messages.error END
         RETURNING id, delivery_status`,
        [t.id, subject, body, t.email, `rfq:${t.id}`],
      );
      if (rows[0].delivery_status === 'PENDING') messageIds.push(rows[0].id);
    }

    const late = LATE_INVITE_STATUSES.includes(request.status);
    const retry = request.status === S.FAILED;
    // Late invitations keep the request where it is; the recommendation waits for them anyway.
    if (!late) await transition(client, requestId, S.SENDING_PROPOSALS, { meta: { suppliers: threads.length, retry } });
    await logEvent(client, requestId, 'PROPOSALS_QUEUED', {
      count: threads.length,
      suppliers: threads.map((t) => t.name),
      retry,
      ...(late && { late: true }),
    });
    // If every RFQ was already delivered there is nothing to wait for.
    await syncRequestStatus(client, requestId);

    return { messageIds, count: threads.length };
  });
}

function pickThreads(all, ids) {
  const byId = new Map(all.map((t) => [t.id, t]));
  const unique = [...new Set(ids)];

  const unknown = unique.filter((id) => !byId.has(id));
  if (unknown.length) throw new HttpError(400, `Not suppliers of this request: ${unknown.join(', ')}`);

  const threads = unique.map((id) => byId.get(id));
  const noEmail = threads.filter((t) => !t.email);
  if (noEmail.length) {
    throw new HttpError(400, `No email address for: ${noEmail.map((t) => t.name).join(', ')}`);
  }
  const blocked = threads.filter((t) => !recipientAllowed(t.email));
  if (blocked.length) {
    throw new HttpError(
      400,
      `Not allowed to email: ${blocked.map((t) => `${t.name} <${t.email}>`).join(', ')} (not in EMAIL_ALLOWED_RECIPIENTS)`,
    );
  }
  return threads;
}
