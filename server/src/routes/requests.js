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
} from '../validation/request.js';
import { upsertSupplier } from '../workflow/jobs/discoverSuppliers.js';
import { approveDeal, rejectDeals } from '../workflow/approval.js';
import { enqueue, enqueueDeliveries, JOBS } from '../workflow/queue.js';
import { queueProposals } from '../workflow/sendProposals.js';
import { lockRequest, logEvent, RequestStatus, transition } from '../workflow/stateMachine.js';

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
                rs.last_contacted_at, s.id AS supplier_id, s.name, s.email, s.phone, s.website, s.location,
                s.description, s.source_url
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
        `SELECT o.* FROM offers o
           JOIN request_suppliers rs ON rs.id = o.request_supplier_id
          WHERE rs.request_id = $1
          ORDER BY o.round, o.created_at`,
        [id],
      ),
      query('SELECT id, type, payload, created_at FROM workflow_events WHERE request_id = $1 ORDER BY id', [id]),
    ]);

    if (!request.rows[0]) throw new NotFoundError('Request not found');
    const byThread = (rows) => (threadId) => rows.filter((r) => r.request_supplier_id === threadId);
    const messagesOf = byThread(messages.rows);
    const offersOf = byThread(offers.rows);

    res.json({
      ...request.rows[0],
      simulation: isSimulatedTransport(),
      suppliers: suppliers.rows.map((s) => ({
        ...s,
        can_email: recipientAllowed(s.email),
        messages: messagesOf(s.id),
        offers: offersOf(s.id),
      })),
      events: events.rows,
    });
  }),
);

/** Adds a supplier by hand (e.g. a Temp Mail test address) while suppliers are being chosen. */
requestsRouter.post(
  '/:id/suppliers',
  asyncRoute(async (req, res) => {
    const { id } = req.params;
    const d = AddSupplierSchema.parse(req.body ?? {});
    const threadId = await withTransaction(async (client) => {
      const request = await lockRequest(client, id);
      if (request.status !== RequestStatus.SUPPLIERS_FOUND) {
        throw new HttpError(409, `Suppliers can only be added before proposals are sent (request is ${request.status})`);
      }
      const supplierId = await upsertSupplier(client, {
        name: d.name,
        email: d.email,
        website: d.website ?? null,
        phone: null,
        location: null,
        description: null,
        source_url: null,
      });
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
      // Drop suppliers that were never contacted; contacted ones keep their history.
      await client.query(`DELETE FROM request_suppliers WHERE request_id = $1 AND status = 'PENDING'`, [id]);
    });
    await enqueue(JOBS.DISCOVER_SUPPLIERS, { requestId: id });
    res.status(202).json({ id, status: RequestStatus.DISCOVERING });
  }),
);
