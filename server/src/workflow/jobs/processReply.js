import { query, withTransaction } from '../../db/pool.js';
import { decideNextMove } from '../../services/negotiation.js';
import { buildCounter } from '../../services/proposals.js';
import { parseReply } from '../../services/replyParser.js';
import { refreshRecommendation, syncRequestStatus } from '../progress.js';
import { enqueueDeliveries } from '../queue.js';
import { logEvent, ThreadStatus } from '../stateMachine.js';

const AWAITING = [ThreadStatus.CONTACTED, ThreadStatus.COUNTERED];

async function closeThread(client, threadId, status, reason) {
  await client.query('UPDATE request_suppliers SET status = $2, final_reason = $3, updated_at = now() WHERE id = $1', [
    threadId,
    status,
    reason,
  ]);
}

/**
 * Steps 5–6: reads a supplier reply, records the offer and makes the next negotiation move.
 * Idempotent: a reply is processed once (processed_at), under a lock on its thread.
 */
export async function processReply(job) {
  const { messageId } = job.data;
  const { rows: [msg] } = await query(
    `SELECT m.id, m.body, m.processed_at, m.created_at, m.parsed_json, m.request_supplier_id, r.currency
       FROM messages m
       JOIN request_suppliers rs ON rs.id = m.request_supplier_id
       JOIN sourcing_requests r ON r.id = rs.request_id
      WHERE m.id = $1 AND m.direction = 'inbound'`,
    [messageId],
  );
  if (!msg || msg.processed_at) return;

  // A quote entered by hand is already structured; otherwise parse outside the transaction,
  // because in live mode this may call the LLM.
  const parsed = msg.parsed_json?.manual ? msg.parsed_json : await parseReply(msg.body, { currency: msg.currency });

  const toDeliver = await withTransaction(async (client) => {
    // Lock order everywhere: thread/message first, then the request (inside syncRequestStatus).
    const { rows: [t] } = await client.query(
      `SELECT rs.*, s.name AS supplier_name FROM request_suppliers rs JOIN suppliers s ON s.id = rs.supplier_id
        WHERE rs.id = $1 FOR UPDATE OF rs`,
      [msg.request_supplier_id],
    );
    const { rows: [fresh] } = await client.query('SELECT processed_at FROM messages WHERE id = $1 FOR UPDATE', [msg.id]);
    if (fresh.processed_at) return [];
    await client.query('UPDATE messages SET parsed_json = $2, processed_at = now() WHERE id = $1', [msg.id, parsed]);

    const { rows: [request] } = await client.query('SELECT * FROM sourcing_requests WHERE id = $1', [t.request_id]);
    const supplier = t.supplier_name;

    // A supplier may still lower a final offer before approval: record it and re-rank, send nothing.
    // Terms the new reply does not mention are carried over from their previous offer.
    if (
      t.status === ThreadStatus.FINAL_OFFER &&
      !['CLOSED', 'CANCELLED'].includes(request.status) &&
      parsed.unit_price != null &&
      t.current_offer_price != null &&
      parsed.unit_price < t.current_offer_price
    ) {
      await client.query(
        `INSERT INTO offers (request_supplier_id, round, unit_price, quantity, delivery_days, payment_terms, valid_until,
                             currency, is_final, message_id)
         SELECT $1, $2, $3, $4, COALESCE($5, prev.delivery_days), COALESCE($6, prev.payment_terms),
                CASE WHEN $7::int IS NULL THEN prev.valid_until ELSE current_date + $7::int END, $8, true, $9
           FROM (SELECT NULL) x
           LEFT JOIN LATERAL (
             SELECT delivery_days, payment_terms, valid_until FROM offers
              WHERE request_supplier_id = $1 ORDER BY round DESC, created_at DESC LIMIT 1
           ) prev ON true
         ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
        [t.id, t.rounds_used, parsed.unit_price, request.quantity, parsed.delivery_days, parsed.payment_terms,
          parsed.validity_days, parsed.currency ?? request.currency, msg.id],
      );
      await client.query(
        `UPDATE request_suppliers SET current_offer_price = $2, final_reason = 'Supplier improved their offer', updated_at = now()
          WHERE id = $1`,
        [t.id, parsed.unit_price],
      );
      await logEvent(client, request.id, 'OFFER_IMPROVED', { supplier, price: parsed.unit_price, previous: t.current_offer_price });
      await refreshRecommendation(client, request.id);
      return [];
    }

    if (!AWAITING.includes(t.status)) {
      await logEvent(client, request.id, 'LATE_REPLY_IGNORED', { supplier, threadStatus: t.status });
      return [];
    }

    // A reply received before our latest counter-offer answers an earlier round; treating it
    // as the answer to the new counter would invent a negotiation round.
    if (t.status === ThreadStatus.COUNTERED) {
      const { rows: [counter] } = await client.query(
        `SELECT created_at FROM messages WHERE request_supplier_id = $1 AND kind = 'COUNTER' ORDER BY created_at DESC LIMIT 1`,
        [t.id],
      );
      if (counter && msg.created_at < counter.created_at) {
        await logEvent(client, request.id, 'LATE_REPLY_IGNORED', { supplier, threadStatus: t.status, reason: 'stale' });
        return [];
      }
    }

    if (parsed.declined) {
      await closeThread(client, t.id, ThreadStatus.DECLINED, 'Supplier declined to quote');
      await logEvent(client, request.id, 'SUPPLIER_DECLINED', { supplier });
      await syncRequestStatus(client, request.id);
      return [];
    }

    // Suppliers often acknowledge first ("Yes, we are interested") and quote later: keep waiting.
    // The reply timeout still applies, and a price can also be entered by hand.
    if (parsed.unit_price == null) {
      await logEvent(client, request.id, 'REPLY_WITHOUT_PRICE', { supplier });
      return [];
    }

    const price = parsed.unit_price;
    await client.query(
      `INSERT INTO offers (request_supplier_id, round, unit_price, quantity, delivery_days, payment_terms, valid_until,
                           currency, is_final, message_id)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int IS NULL THEN NULL ELSE current_date + $7::int END, $8, $9, $10)
       ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING`,
      [t.id, t.rounds_used, price, request.quantity, parsed.delivery_days, parsed.payment_terms, parsed.validity_days,
        parsed.currency ?? request.currency, parsed.is_final, msg.id],
    );
    await client.query(
      `UPDATE request_suppliers SET current_offer_price = $2, opening_price = COALESCE(opening_price, $2), updated_at = now()
        WHERE id = $1`,
      [t.id, price],
    );
    await logEvent(client, request.id, 'QUOTE_RECEIVED', {
      supplier,
      price,
      round: t.rounds_used,
      deliveryDays: parsed.delivery_days,
      parser: parsed.parser,
    });

    const { rows: [competitor] } = await client.query(
      `SELECT MIN(current_offer_price) AS price FROM request_suppliers
        WHERE request_id = $1 AND id <> $2 AND current_offer_price IS NOT NULL
          AND status NOT IN ('DECLINED', 'WALKED_AWAY', 'NEEDS_REVIEW', 'SEND_FAILED')`,
      [request.id, t.id],
    );

    const decision = decideNextMove({
      price,
      isFinal: parsed.is_final,
      acceptsCounter: parsed.accepts_counter,
      target: request.target_price,
      max: request.max_price,
      round: t.rounds_used,
      maxRounds: request.max_rounds,
      bestCompetitor: competitor.price,
    });
    await logEvent(client, request.id, 'NEGOTIATION_DECISION', {
      supplier,
      action: decision.action,
      price,
      counterPrice: decision.counterPrice ?? null,
      reason: decision.reason,
      round: t.rounds_used,
    });

    const messageIds = [];
    if (decision.action === 'COUNTER') {
      const round = t.rounds_used + 1;
      const { subject, body } = buildCounter({
        request,
        supplier: { name: supplier },
        rfqRef: t.rfq_ref,
        theirPrice: price,
        counterPrice: decision.counterPrice,
        leverage: decision.leverage,
        round,
        maxRounds: request.max_rounds,
      });
      const { rows } = await client.query(
        `INSERT INTO messages (request_supplier_id, direction, kind, subject, body, to_email, idempotency_key, delivery_status, parsed_json)
         SELECT $1, 'outbound', 'COUNTER', $2, $3, COALESCE(rs.contact_email, s.email), $4, 'PENDING', $5
           FROM request_suppliers rs JOIN suppliers s ON s.id = rs.supplier_id WHERE rs.id = $1
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [t.id, subject, body, `counter:${t.id}:${round}`, { counter_price: decision.counterPrice, round }],
      );
      if (rows[0]) messageIds.push(rows[0].id);
      await client.query(
        `UPDATE request_suppliers SET status = $2, rounds_used = $3, updated_at = now() WHERE id = $1`,
        [t.id, ThreadStatus.COUNTERED, round],
      );
    } else {
      const status = decision.action === 'WALK_AWAY' ? ThreadStatus.WALKED_AWAY : ThreadStatus.FINAL_OFFER;
      await closeThread(client, t.id, status, decision.reason);
    }

    await syncRequestStatus(client, request.id);
    return messageIds;
  });

  await enqueueDeliveries(toDeliver);
}
