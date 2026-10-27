import { Router } from 'express';
import { OFFER_SOURCE_SQL } from '../db/offerSource.js';
import { query } from '../db/pool.js';

// Read-only cross-request views for the Suppliers, Quotes and Negotiations pages.
export const insightsRouter = Router();

const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/** Every supplier with how often it was found, contacted and chosen. */
insightsRouter.get(
  '/suppliers',
  asyncRoute(async (req, res) => {
    const { rows } = await query(
      `SELECT s.id, s.name, s.email, s.website, s.location, s.phone,
              COUNT(rs.id)::int AS requests,
              COUNT(rs.id) FILTER (WHERE rs.selected)::int AS contacted,
              COUNT(rs.id) FILTER (WHERE rs.current_offer_price IS NOT NULL)::int AS quoted,
              COUNT(rs.id) FILTER (WHERE rs.status = 'WON')::int AS won,
              MAX(rs.updated_at) AS last_activity,
              (ARRAY_AGG(rs.request_id ORDER BY rs.updated_at DESC))[1] AS latest_request_id,
              (ARRAY_AGG(rs.id ORDER BY rs.updated_at DESC))[1] AS latest_thread_id
         FROM suppliers s
         LEFT JOIN request_suppliers rs ON rs.supplier_id = s.id
        GROUP BY s.id
        ORDER BY last_activity DESC NULLS LAST, s.name
        LIMIT 500`,
    );
    res.json(rows);
  }),
);

/** Every quote (offer) received, newest first, with its supplier and request. */
insightsRouter.get(
  '/quotes',
  asyncRoute(async (req, res) => {
    const { rows } = await query(
      `SELECT o.id, o.round, o.unit_price, o.delivery_days, o.payment_terms, o.created_at, ${OFFER_SOURCE_SQL} AS source,
              COALESCE(o.currency, r.currency) AS currency,
              rs.id AS thread_id, rs.status AS thread_status, s.name AS supplier,
              r.id AS request_id, r.commodity, r.unit, r.quantity, r.target_price, r.max_price
         FROM offers o
         JOIN request_suppliers rs ON rs.id = o.request_supplier_id
         JOIN suppliers s ON s.id = rs.supplier_id
         JOIN sourcing_requests r ON r.id = rs.request_id
         LEFT JOIN messages m ON m.id = o.message_id
        ORDER BY o.created_at DESC
        LIMIT 500`,
    );
    res.json(rows);
  }),
);

/** Suppliers that were contacted on requests that are still open. */
insightsRouter.get(
  '/negotiations',
  asyncRoute(async (req, res) => {
    const { rows } = await query(
      `SELECT rs.id, rs.status, rs.rounds_used, rs.opening_price, rs.current_offer_price, rs.last_contacted_at, rs.updated_at,
              s.name AS supplier, COALESCE(rs.contact_email, s.email) AS email,
              r.id AS request_id, r.commodity, r.unit, r.currency, r.target_price, r.max_price, r.max_rounds,
              r.status AS request_status
         FROM request_suppliers rs
         JOIN suppliers s ON s.id = rs.supplier_id
         JOIN sourcing_requests r ON r.id = rs.request_id
        WHERE rs.selected AND r.status IN ('SENDING_PROPOSALS', 'AWAITING_REPLIES', 'NEGOTIATING', 'DEAL_RECOMMENDED')
        ORDER BY rs.updated_at DESC
        LIMIT 500`,
    );
    res.json(rows);
  }),
);
