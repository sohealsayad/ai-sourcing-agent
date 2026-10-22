import { InvalidTransitionError, NotFoundError } from '../errors.js';

export const RequestStatus = Object.freeze({
  DRAFT: 'DRAFT',
  DISCOVERING: 'DISCOVERING',
  SUPPLIERS_FOUND: 'SUPPLIERS_FOUND',
  SENDING_PROPOSALS: 'SENDING_PROPOSALS',
  AWAITING_REPLIES: 'AWAITING_REPLIES',
  NEGOTIATING: 'NEGOTIATING',
  DEAL_RECOMMENDED: 'DEAL_RECOMMENDED',
  CLOSED: 'CLOSED',
  NO_DEAL: 'NO_DEAL',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
});

const S = RequestStatus;

// Allowed moves. Anything not listed here is rejected, so a job can never skip a stage.
const TRANSITIONS = {
  [S.DRAFT]: [S.DISCOVERING],
  [S.DISCOVERING]: [S.SUPPLIERS_FOUND, S.FAILED],
  [S.SUPPLIERS_FOUND]: [S.SENDING_PROPOSALS, S.DISCOVERING],
  [S.SENDING_PROPOSALS]: [S.AWAITING_REPLIES, S.FAILED],
  [S.AWAITING_REPLIES]: [S.NEGOTIATING, S.DEAL_RECOMMENDED, S.NO_DEAL],
  [S.NEGOTIATING]: [S.DEAL_RECOMMENDED, S.NO_DEAL],
  [S.DEAL_RECOMMENDED]: [S.CLOSED, S.CANCELLED],
  [S.CLOSED]: [],
  [S.NO_DEAL]: [],
  [S.CANCELLED]: [],
  [S.FAILED]: [S.DISCOVERING, S.SENDING_PROPOSALS],
};

export const canTransition = (from, to) => TRANSITIONS[from]?.includes(to) ?? false;

/** Status of one supplier within one request (a "thread"). */
export const ThreadStatus = Object.freeze({
  PENDING: 'PENDING', // found, not selected yet
  QUEUED: 'QUEUED', // selected, RFQ waiting for delivery
  CONTACTED: 'CONTACTED', // RFQ delivered, waiting for a quote
  COUNTERED: 'COUNTERED', // our counter-offer sent, waiting for a reply
  SEND_FAILED: 'SEND_FAILED',
  DECLINED: 'DECLINED',
  NO_RESPONSE: 'NO_RESPONSE',
  FINAL_OFFER: 'FINAL_OFFER', // negotiation finished with an offer on the table
  WALKED_AWAY: 'WALKED_AWAY', // final price stayed above the buyer's maximum
  NEEDS_REVIEW: 'NEEDS_REVIEW', // reply could not be understood
  WON: 'WON',
  LOST: 'LOST',
});

/** Threads in these states need nothing more from the workflow. */
export const TERMINAL_THREAD_STATUSES = new Set([
  ThreadStatus.SEND_FAILED,
  ThreadStatus.DECLINED,
  ThreadStatus.NO_RESPONSE,
  ThreadStatus.FINAL_OFFER,
  ThreadStatus.WALKED_AWAY,
  ThreadStatus.NEEDS_REVIEW,
  ThreadStatus.WON,
  ThreadStatus.LOST,
]);

export async function logEvent(db, requestId, type, payload = {}) {
  await db.query('INSERT INTO workflow_events (request_id, type, payload) VALUES ($1, $2, $3)', [
    requestId,
    type,
    payload,
  ]);
}

/** Locks the request row for the rest of the caller's transaction and returns it. */
export async function lockRequest(client, requestId) {
  const { rows } = await client.query('SELECT * FROM sourcing_requests WHERE id = $1 FOR UPDATE', [requestId]);
  if (!rows[0]) throw new NotFoundError(`Request ${requestId} not found`);
  return rows[0];
}

/**
 * Moves a request to a new status inside the caller's transaction.
 * Locks the row so concurrent jobs cannot both win the same transition.
 */
export async function transition(client, requestId, to, { error = null, meta = {} } = {}) {
  const { status: from } = await lockRequest(client, requestId);
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);

  await client.query('UPDATE sourcing_requests SET status = $2, error = $3, updated_at = now() WHERE id = $1', [
    requestId,
    to,
    error,
  ]);
  await logEvent(client, requestId, 'STATUS_CHANGED', { from, to, ...(error && { error }), ...meta });
  return { from, to };
}
