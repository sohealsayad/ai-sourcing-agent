import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { HttpError, NotFoundError } from '../errors.js';
import { isSimulatedTransport, recipientAllowed } from '../services/mailer.js';
import {
  AddSupplierSchema,
  ApproveDealSchema,
  CreateRequestSchema,
  RejectDealsSchema,
  SendProposalsSchema,
  ManualQuoteSchema,
  SupplierEmailSchema,
} from '../validation/request.js';
import { upsertSupplier } from '../workflow/jobs/discoverSuppliers.js';
import { approveDeal, rejectDeals } from '../workflow/approval.js';
import { enqueue, enqueueDeliveries, JOBS } from '../workflow/queue.js';
import { LATE_INVITE_STATUSES, queueProposals } from '../workflow/sendProposals.js';
import { OFFER_SOURCE_SQL } from '../db/offerSource.js';
import { closeWaitingThread } from '../workflow/jobs/replyTimeout.js';
import { lockRequest, logEvent, RequestStatus, ThreadStatus, transition } from '../workflow/stateMachine.js';

export const requestsRouter = Router();

// Express 4 does not forward rejected promises to the error handler on its own.
const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

requestsRouter.param('id', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return next(new NotFoundError('Request not found'));
  next();
});

/** Step 1: save the request and start the workflow. */
requestsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const d = CreateRequestSchema.parse(req.body);

    const request = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO sourcing_requests
           (commodity, specifications, location, quantity, unit, target_price, max_price, currency, deadline,
            buyer_name, buyer_email, status, max_rounds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [
          d.commodity,
          d.specifications ?? null,
          d.location,
          d.quantity,
          d.unit,
          d.target_price,
          d.max_price ?? null,
          d.currency,
          d.deadline ?? null,
          d.buyer_name ?? null,
          d.buyer_email ?? null,
          RequestStatus.DRAFT,
          d.max_rounds,
        ],
      );
      const { id } = rows[0];
      await logEvent(client, id, 'REQUEST_CREATED', { commodity: d.commodity, location: d.location });
      await transition(client, id, RequestStatus.DISCOVERING);
      return (await client.query('SELECT * FROM sourcing_requests WHERE id = $1', [id])).rows[0];
    });

    // Enqueue after commit so the worker never picks up a request it cannot see yet.
    await enqueue(JOBS.DISCOVER_SUPPLIERS, { requestId: request.id });
    res.status(201).json(request);
  }),
);

requestsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const { rows } = await query(
      `SELECT r.*, COUNT(rs.id)::int AS supplier_count
         FROM sourcing_requests r
         LEFT JOIN request_suppliers rs ON rs.request_id = r.id
        GROUP BY r.id
        ORDER BY r.created_at DESC
        LIMIT 100`,
    );
    res.json(rows);
  }),
);

requestsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    const [request, suppliers, messages, offers, events] = await Promise.all([
      query('SELECT * FROM sourcing_requests WHERE id = $1', [id]),
      query(
        `SELECT rs.id, rs.status, rs.selected, rs.rfq_ref, rs.relevance_score, rs.ai_reasoning,
                rs.opening_price, rs.current_offer_price, rs.rounds_used, rs.final_reason, rs.last_error,
                rs.last_contacted_at, s.id AS supplier_id, s.name,
                COALESCE(rs.contact_email, s.email) AS email, s.email AS original_email,
                (rs.contact_email IS NOT NULL) AS email_overridden,
                s.phone, s.website, s.location, s.description, s.source_url
           FROM request_suppliers rs
           JOIN suppliers s ON s.id = rs.supplier_id
          WHERE rs.request_id = $1
          ORDER BY rs.relevance_score DESC NULLS LAST, s.name`,
        [id],
      ),
      query(
        `SELECT m.id, m.request_supplier_id, m.direction, m.kind, m.subject, m.body, m.delivery_status, m.attempts,
                m.error, m.simulated, m.parsed_json, m.sent_at, m.created_at
           FROM messages m
           JOIN request_suppliers rs ON rs.id = m.request_supplier_id
          WHERE rs.request_id = $1
          ORDER BY m.created_at, m.id`,
        [id],
      ),
      query(
        `SELECT o.*, ${OFFER_SOURCE_SQL} AS source FROM offers o
           JOIN request_suppliers rs ON rs.id = o.request_supplier_id
           LEFT JOIN messages m ON m.id = o.message_id
          WHERE rs.request_id = $1
          ORDER BY o.round, o.created_at`,
        [id],
      ),
      query('SELECT id, type, payload, created_at FROM workflow_events WHERE request_id = $1 ORDER BY id', [id]),
    ]);

    if (!request.rows[0]) throw new NotFoundError('Request not found');
    const byThread = (rows) => (threadId) => rows.filter((r) => r.request_supplier_id === threadId);
    // Who a message is from: a quote typed in by the buyer is stored like a reply, but is not the supplier's.
    const withSource = (m) => ({
      ...m,
      source: m.direction === 'outbound' ? 'buyer' : m.parsed_json?.manual ? 'buyer_manual' : 'supplier',
    });
    const messagesOf = byThread(messages.rows.map(withSource));
    const offersOf = byThread(offers.rows);
    const usedMessageIds = new Set(offers.rows.map((o) => o.message_id));
    // A lower price in a reply that arrived after the offer went final (can be applied with recheck).
    const lowerQuoteOf = (s) => {
      if (s.status !== 'FINAL_OFFER' || s.current_offer_price == null) return null;
      const m = messagesOf(s.id)
        .filter((m) => m.direction === 'inbound' && !usedMessageIds.has(m.id) && Number(m.parsed_json?.unit_price) < s.current_offer_price)
        .at(-1);
      return m ? { message_id: m.id, unit_price: Number(m.parsed_json.unit_price), received_at: m.created_at } : null;
    };
    // Prices the supplier wrote that never became an offer (e.g. sent while they were parked for review).
    const unusedQuotesOf = (s) =>
      messagesOf(s.id)
        .filter((m) => m.direction === 'inbound' && !usedMessageIds.has(m.id) && !m.parsed_json?.manual && m.parsed_json?.unit_price != null)
        .map((m) => ({ message_id: m.id, unit_price: Number(m.parsed_json.unit_price), received_at: m.created_at }));

    res.json({
      ...request.rows[0],
      simulation: isSimulatedTransport(),
      suppliers: suppliers.rows.map((s) => ({
        ...s,
        can_email: recipientAllowed(s.email),
        messages: messagesOf(s.id),
        offers: offersOf(s.id),
        lower_quote: lowerQuoteOf(s),
        unused_quotes: unusedQuotesOf(s),
      })),
      events: events.rows,
    });
  }),
);

// Suppliers can be added (and given an email) while choosing suppliers or while quotes are still coming in.
const SUPPLIER_EDIT_STATUSES = [RequestStatus.SUPPLIERS_FOUND, ...LATE_INVITE_STATUSES];

function assertCanEditSuppliers(request) {
  if (!SUPPLIER_EDIT_STATUSES.includes(request.status)) {
    throw new HttpError(409, `Suppliers can only be changed until a deal is recommended (request is ${request.status})`);
  }
}

/** Adds a supplier by hand (e.g. a Temp Mail test address), before or after the first proposals are sent. */
requestsRouter.post(
  '/:id/suppliers',
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    const d = AddSupplierSchema.parse(req.body ?? {});
    const threadId = await withTransaction(async (client) => {
      assertCanEditSuppliers(await lockRequest(client, id));
      const supplierId = await upsertSupplier(client, {
        name: d.name,
        email: d.email,
        website: d.website ?? null,
        phone: null,
        location: null,
        description: null,
        source_url: null,
      });
      // An existing address keeps its supplier record; show the name that was just typed.
      await client.query('UPDATE suppliers SET name = $2, updated_at = now() WHERE id = $1', [supplierId, d.name]);
      const { rows } = await client.query(
        `INSERT INTO request_suppliers (request_id, supplier_id, ai_reasoning) VALUES ($1, $2, 'Added manually')
         ON CONFLICT (request_id, supplier_id) DO NOTHING RETURNING id`,
        [id, supplierId],
      );
      if (!rows[0]) throw new HttpError(409, 'This supplier is already on the request');
      await logEvent(client, id, 'SUPPLIER_ADDED', { supplier: d.name, email: d.email, canEmail: recipientAllowed(d.email) });
      return rows[0].id;
    });
    res.status(201).json({ id: threadId, can_email: recipientAllowed(d.email) });
  }),
);

/**
 * Sets (or clears, with email: null) the email used for one supplier on this request only,
 * e.g. a test inbox for a supplier found online without an address. Not after it was contacted.
 */
requestsRouter.patch(
  '/:id/suppliers/:threadId',
  asyncRoute(async (req, res) => {
    const { id, threadId } = req.params;
    if (!UUID_RE.test(threadId)) throw new NotFoundError('Supplier not found');
    const { email } = SupplierEmailSchema.parse(req.body ?? {});

    const result = await withTransaction(async (client) => {
      assertCanEditSuppliers(await lockRequest(client, id));
      const { rows: [thread] } = await client.query(
        `SELECT rs.id, rs.status, s.name, s.email AS original_email
           FROM request_suppliers rs JOIN suppliers s ON s.id = rs.supplier_id
          WHERE rs.id = $1 AND rs.request_id = $2
          FOR UPDATE OF rs`,
        [threadId, id],
      );
      if (!thread) throw new NotFoundError('Supplier not found');
      if (thread.status !== 'PENDING') {
        throw new HttpError(409, `${thread.name} has already been contacted; its email can no longer be changed`);
      }
      await client.query('UPDATE request_suppliers SET contact_email = $2, updated_at = now() WHERE id = $1', [threadId, email]);
      const effective = email ?? thread.original_email;
      await logEvent(client, id, 'SUPPLIER_EMAIL_SET', {
        supplier: thread.name,
        email: effective,
        overridden: Boolean(email),
        canEmail: recipientAllowed(effective),
      });
      return { email: effective, can_email: recipientAllowed(effective) };
    });
    res.json({ id: threadId, ...result });
  }),
);

// ---------------------------------------------------------------------------
// Recovery tools while quotes are coming in (real email: unreadable replies, silent suppliers).

/** Loads one supplier thread of a request (locked) and checks the request is still collecting quotes. */
async function lockQuotingThread(client, requestId, threadId, allowed = LATE_INVITE_STATUSES) {
  if (!UUID_RE.test(threadId)) throw new NotFoundError('Supplier not found');
  const { rows: [thread] } = await client.query(
    `SELECT rs.*, s.name AS supplier_name, r.status AS request_status, r.currency, r.unit
       FROM request_suppliers rs
       JOIN suppliers s ON s.id = rs.supplier_id
       JOIN sourcing_requests r ON r.id = rs.request_id
      WHERE rs.id = $1 AND rs.request_id = $2
      FOR UPDATE OF rs`,
    [threadId, requestId],
  );
  if (!thread) throw new NotFoundError('Supplier not found');
  if (!allowed.includes(thread.request_status)) {
    throw new HttpError(409, `This is only possible while quotes are being collected (request is ${thread.request_status})`);
  }
  return thread;
}

// A lower final offer can still be applied after the recommendation, until a deal is approved.
const RECHECK_STATUSES = [...LATE_INVITE_STATUSES, RequestStatus.DEAL_RECOMMENDED];

// A thread parked for review goes back to waiting for the reply it was on.
const reopenStatus = (thread) => (thread.rounds_used > 0 ? ThreadStatus.COUNTERED : ThreadStatus.CONTACTED);

/**
 * Re-reads a supplier's replies: the newest priced reply of a supplier that needs review, or a
 * newer, lower quote that arrived after their offer went final.
 */
requestsRouter.post(
  '/:id/suppliers/:threadId/recheck',
  asyncRoute(async (req, res) => {
    const { id, threadId } = req.params;
    const messageId = await withTransaction(async (client) => {
      const thread = await lockQuotingThread(client, id, threadId, RECHECK_STATUSES);

      // A final offer can still be lowered by a later reply (applied by processReply, no email sent).
      if (thread.status === ThreadStatus.FINAL_OFFER) {
        const { rows: [lower] } = await client.query(
          `SELECT m.id FROM messages m
            WHERE m.request_supplier_id = $1 AND m.direction = 'inbound'
              AND (m.parsed_json->>'unit_price')::numeric < $2
              AND NOT EXISTS (SELECT 1 FROM offers o WHERE o.message_id = m.id)
            ORDER BY m.created_at DESC LIMIT 1`,
          [threadId, thread.current_offer_price],
        );
        if (!lower) throw new HttpError(409, `No newer, lower quote from ${thread.supplier_name} to apply`);
        await client.query('UPDATE messages SET processed_at = NULL WHERE id = $1', [lower.id]);
        await logEvent(client, id, 'REPLIES_RECHECKED', { supplier: thread.supplier_name });
        return lower.id;
      }

      if (thread.status !== ThreadStatus.NEEDS_REVIEW || thread.request_status === RequestStatus.DEAL_RECOMMENDED) {
        throw new HttpError(409, `Only suppliers that need review can be re-checked (${thread.supplier_name} is ${thread.status})`);
      }
      // Prefer the newest reply that contains a price; a later "thanks"/total-only reply must not hide it.
      const { rows: [latest] } = await client.query(
        `SELECT id FROM messages WHERE request_supplier_id = $1 AND direction = 'inbound'
          ORDER BY (parsed_json->>'unit_price') IS NOT NULL DESC, created_at DESC LIMIT 1`,
        [threadId],
      );
      if (!latest) throw new HttpError(409, `${thread.supplier_name} has not replied yet`);
      await client.query('UPDATE request_suppliers SET status = $2, final_reason = NULL, updated_at = now() WHERE id = $1', [
        threadId,
        reopenStatus(thread),
      ]);
      await client.query('UPDATE messages SET processed_at = NULL WHERE id = $1', [latest.id]);
      await logEvent(client, id, 'REPLIES_RECHECKED', { supplier: thread.supplier_name });
      return latest.id;
    });
    await enqueue(JOBS.PROCESS_REPLY, { messageId, requestId: id });
    res.status(202).json({ id: threadId, messageId });
  }),
);

/** Records a quote typed in by the buyer; it then follows the normal negotiation path. */
requestsRouter.post(
  '/:id/suppliers/:threadId/quote',
  asyncRoute(async (req, res) => {
    const { id, threadId } = req.params;
    const q = ManualQuoteSchema.parse(req.body ?? {});
    const messageId = await withTransaction(async (client) => {
      const thread = await lockQuotingThread(client, id, threadId);
      const allowed = [ThreadStatus.CONTACTED, ThreadStatus.COUNTERED, ThreadStatus.NEEDS_REVIEW];
      if (!allowed.includes(thread.status)) {
        throw new HttpError(409, `A quote can only be entered while waiting for ${thread.supplier_name}'s reply (status ${thread.status})`);
      }
      if (thread.status === ThreadStatus.NEEDS_REVIEW) {
        await client.query('UPDATE request_suppliers SET status = $2, final_reason = NULL WHERE id = $1', [threadId, reopenStatus(thread)]);
      }
      const body = [
        'Quote entered manually by the buyer:',
        `Price: ${thread.currency} ${q.unit_price} per ${thread.unit}`,
        q.delivery_days ? `Delivery: within ${q.delivery_days} days` : null,
        q.payment_terms ? `Payment terms: ${q.payment_terms}` : null,
        q.validity_days ? `Valid for: ${q.validity_days} day${q.validity_days === 1 ? '' : 's'}` : null,
        'Recorded by the buyer; not sent to or confirmed by the supplier.',
      ]
        .filter(Boolean)
        .join('\n');
      const parsed = {
        manual: true,
        parser: 'manual',
        declined: false,
        unit_price: q.unit_price,
        currency: thread.currency,
        delivery_days: q.delivery_days ?? null,
        payment_terms: q.payment_terms ?? null,
        validity_days: q.validity_days ?? null,
        is_final: false,
        accepts_counter: false,
      };
      const { rows: [msg] } = await client.query(
        `INSERT INTO messages (request_supplier_id, direction, kind, subject, body, delivery_status, parsed_json)
         VALUES ($1, 'inbound', 'REPLY', 'Manual quote', $2, 'RECEIVED', $3) RETURNING id`,
        [threadId, body, parsed],
      );
      await logEvent(client, id, 'QUOTE_ENTERED_MANUALLY', { supplier: thread.supplier_name, price: q.unit_price });
      return msg.id;
    });
    await enqueue(JOBS.PROCESS_REPLY, { messageId, requestId: id });
    res.status(202).json({ id: threadId, messageId });
  }),
);

/** "Mark as no response": closes a supplier that is still waiting, like the reply timeout would. */
requestsRouter.post(
  '/:id/suppliers/:threadId/close',
  asyncRoute(async (req, res) => {
    const { id, threadId } = req.params;
    const status = await withTransaction(async (client) => {
      const thread = await lockQuotingThread(client, id, threadId);
      const closed = await closeWaitingThread(client, threadId, { manual: true });
      if (!closed) throw new HttpError(409, `${thread.supplier_name} is not waiting for a reply (status ${thread.status})`);
      return closed;
    });
    res.json({ id: threadId, status });
  }),
);

/** Step 3: send an RFQ to the selected suppliers (or retry a send that failed). */
requestsRouter.post(
  '/:id/send-proposals',
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    const { requestSupplierIds } = SendProposalsSchema.parse(req.body ?? {});
    const { messageIds, count } = await queueProposals(id, requestSupplierIds);
    // Enqueue after commit so the worker never picks up a message it cannot see yet.
    await enqueueDeliveries(messageIds);
    res.status(202).json({ id, status: RequestStatus.SENDING_PROPOSALS, suppliers: count, queued: messageIds.length });
  }),
);

/** Step 7: human approval. Nothing binding is sent before this. */
requestsRouter.post(
  '/:id/approve',
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    const input = ApproveDealSchema.parse(req.body ?? {});
    const messageIds = await approveDeal(id, input);
    await enqueueDeliveries(messageIds);
    res.json({ id, status: RequestStatus.CLOSED });
  }),
);

requestsRouter.post(
  '/:id/reject',
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    const input = RejectDealsSchema.parse(req.body ?? {});
    const messageIds = await rejectDeals(id, input);
    await enqueueDeliveries(messageIds);
    res.json({ id, status: RequestStatus.CANCELLED });
  }),
);

/** Re-run Step 2, e.g. after a failure or if the found suppliers are not good enough. */
requestsRouter.post(
  '/:id/rediscover',
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    await withTransaction(async (client) => {
      await transition(client, id, RequestStatus.DISCOVERING, { meta: { reason: 'manual_rediscover' } });
      // "Search again" means fresh web results, not the cached ones from the last attempt.
      await client.query('UPDATE sourcing_requests SET discovery_cache = NULL WHERE id = $1', [id]);
      // Drop suppliers that were never contacted; contacted ones keep their history.
      await client.query(`DELETE FROM request_suppliers WHERE request_id = $1 AND status = 'PENDING'`, [id]);
    });
    await enqueue(JOBS.DISCOVER_SUPPLIERS, { requestId: id });
    res.status(202).json({ id, status: RequestStatus.DISCOVERING });
  }),
);
