import { rankOffers, round2, WEIGHTS } from '../services/negotiation.js';
import { logEvent, lockRequest, RequestStatus, TERMINAL_THREAD_STATUSES, ThreadStatus, transition } from './stateMachine.js';

const S = RequestStatus;

/**
 * Derives the request status from its threads and applies any transitions that are due.
 * Call at the end of every transaction that changes a thread. It locks the request row,
 * so concurrent per-supplier jobs settle the request status one at a time.
 */
export async function syncRequestStatus(client, requestId) {
  let request = await lockRequest(client, requestId);

  if (request.status === S.SENDING_PROPOSALS) {
    const { rows } = await client.query(
      `SELECT m.delivery_status, COUNT(*)::int AS n
         FROM messages m
         JOIN request_suppliers rs ON rs.id = m.request_supplier_id
        WHERE rs.request_id = $1 AND m.kind = 'RFQ' AND rs.selected
        GROUP BY m.delivery_status`,
      [requestId],
    );
    const counts = Object.fromEntries(rows.map((r) => [r.delivery_status, r.n]));
    if (counts.PENDING) return request.status; // still delivering

    const sent = counts.SENT ?? 0;
    const failed = counts.FAILED ?? 0;
    if (sent === 0) {
      await transition(client, requestId, S.FAILED, {
        error: `No proposals could be delivered (${failed} failed).`,
      });
      return S.FAILED;
    }
    await transition(client, requestId, S.AWAITING_REPLIES, { meta: { sent, failed } });
    if (failed) await logEvent(client, requestId, 'PROPOSALS_PARTIALLY_SENT', { sent, failed });
    request = { ...request, status: S.AWAITING_REPLIES };
  }

  if (request.status !== S.AWAITING_REPLIES && request.status !== S.NEGOTIATING) return request.status;

  const threads = await loadThreads(client, requestId);

  if (!threads.every((t) => TERMINAL_THREAD_STATUSES.has(t.status))) {
    if (request.status === S.AWAITING_REPLIES && threads.some((t) => t.rounds_used > 0)) {
      await transition(client, requestId, S.NEGOTIATING);
      return S.NEGOTIATING;
    }
    return request.status;
  }

  // Every supplier has finished: recommend the best final offer, or report that there is none.
  return finalize(client, request, threads);
}

/** Selected threads with their latest offer terms, as used for ranking. */
async function loadThreads(client, requestId) {
  const { rows } = await client.query(
    `SELECT rs.id, rs.status, rs.rounds_used, rs.opening_price, rs.current_offer_price, s.name,
            lo.delivery_days, lo.payment_terms
       FROM request_suppliers rs
       JOIN suppliers s ON s.id = rs.supplier_id
       LEFT JOIN LATERAL (
         SELECT delivery_days, payment_terms FROM offers o
          WHERE o.request_supplier_id = rs.id
          ORDER BY o.round DESC, o.created_at DESC LIMIT 1
       ) lo ON true
      WHERE rs.request_id = $1 AND rs.selected`,
    [requestId],
  );
  return rows;
}

/**
 * Re-ranks a request whose recommendation is already out (e.g. a supplier lowered a final offer
 * before approval); otherwise just settles the status as usual.
 */
export async function refreshRecommendation(client, requestId) {
  const request = await lockRequest(client, requestId);
  if (request.status !== S.DEAL_RECOMMENDED) return syncRequestStatus(client, requestId);
  return finalize(client, request, await loadThreads(client, requestId));
}

async function finalize(client, request, threads) {
  const counts = threads.reduce((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {});
  const ranked = rankOffers(
    threads
      .filter((t) => t.status === ThreadStatus.FINAL_OFFER)
      .map((t) => ({
        requestSupplierId: t.id,
        name: t.name,
        price: t.current_offer_price,
        openingPrice: t.opening_price,
        deliveryDays: t.delivery_days,
        paymentTerms: t.payment_terms,
        rounds: t.rounds_used,
      })),
    { max: request.max_price },
  ).map((o) => ({
    ...o,
    total: round2(o.price * request.quantity),
    savingsVsOpening: o.openingPrice ? round2(((o.openingPrice - o.price) / o.openingPrice) * 100) : 0,
    vsTarget: round2(((o.price - request.target_price) / request.target_price) * 100),
  }));

  if (!ranked.length) {
    const summary = Object.entries(counts)
      .map(([status, n]) => `${n} ${status.toLowerCase().replace(/_/g, ' ')}`)
      .join(', ');
    await transition(client, request.id, S.NO_DEAL, {
      error: `No supplier offered a price within the maximum (${summary}).`,
    });
    return S.NO_DEAL;
  }

  const best = ranked[0];
  const recommendation = {
    generatedAt: new Date().toISOString(),
    weights: WEIGHTS,
    counts,
    ranked,
    reason:
      ranked.length === 1
        ? `${best.name} is the only supplier with an acceptable final offer.`
        : `${best.name} has the best overall score (${best.score}/100), weighing price ${WEIGHTS.price * 100}%, ` +
          `delivery time ${WEIGHTS.delivery * 100}% and payment terms ${WEIGHTS.payment * 100}%.`,
  };

  await client.query(
    'UPDATE sourcing_requests SET recommendation = $2, recommended_request_supplier_id = $3 WHERE id = $1',
    [request.id, recommendation, best.requestSupplierId],
  );
  const updated = request.status === S.DEAL_RECOMMENDED;
  if (!updated) await transition(client, request.id, S.DEAL_RECOMMENDED);
  await logEvent(client, request.id, updated ? 'RECOMMENDATION_UPDATED' : 'DEAL_RECOMMENDED', {
    supplier: best.name,
    price: best.price,
    score: best.score,
    offers: ranked.length,
  });
  return S.DEAL_RECOMMENDED;
}
