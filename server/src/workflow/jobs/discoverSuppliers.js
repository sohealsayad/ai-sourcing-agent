import { pool, query, withTransaction } from '../../db/pool.js';
import { findSuppliers } from '../../services/discovery.js';
import { logEvent, RequestStatus, transition } from '../stateMachine.js';

export async function upsertSupplier(client, s) {
  // Re-use a supplier found by an earlier request (same email, or same website when there is no email).
  const { rows: existing } = await client.query(
    `SELECT id FROM suppliers
      WHERE ($1::text IS NOT NULL AND lower(email) = lower($1))
         OR ($1::text IS NULL AND $2::text IS NOT NULL AND lower(website) = lower($2))
      LIMIT 1`,
    [s.email, s.website],
  );

  if (existing[0]) {
    await client.query(
      `UPDATE suppliers
          SET phone = COALESCE($2, phone), website = COALESCE($3, website), location = COALESCE($4, location),
              description = COALESCE($5, description), source_url = COALESCE($6, source_url), updated_at = now()
        WHERE id = $1`,
      [existing[0].id, s.phone, s.website, s.location, s.description, s.source_url],
    );
    return existing[0].id;
  }

  const { rows } = await client.query(
    `INSERT INTO suppliers (name, email, phone, website, location, description, source_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [s.name, s.email, s.phone, s.website, s.location, s.description, s.source_url],
  );
  return rows[0].id;
}

export async function discoverSuppliers(job) {
  const { requestId } = job.data;
  const { rows } = await query('SELECT * FROM sourcing_requests WHERE id = $1', [requestId]);
  const request = rows[0];

  // Idempotency: a retried or duplicate job for a request that already moved on does nothing.
  if (!request || request.status !== RequestStatus.DISCOVERING) return;

  await logEvent(pool, requestId, 'DISCOVERY_STARTED', { attempt: (job.retryCount ?? 0) + 1 });
  const { suppliers, searchQueries, mode, usage } = await findSuppliers(request);

  await withTransaction(async (client) => {
    for (const s of suppliers) {
      const supplierId = await upsertSupplier(client, s);
      await client.query(
        `INSERT INTO request_suppliers (request_id, supplier_id, relevance_score, ai_reasoning)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (request_id, supplier_id)
         DO UPDATE SET relevance_score = EXCLUDED.relevance_score, ai_reasoning = EXCLUDED.ai_reasoning, updated_at = now()`,
        [requestId, supplierId, s.relevance_score, s.reasoning],
      );
    }

    await logEvent(client, requestId, 'SUPPLIERS_DISCOVERED', {
      mode,
      count: suppliers.length,
      searchQueries,
      ...(usage && { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }),
    });

    if (suppliers.length > 0) {
      await transition(client, requestId, RequestStatus.SUPPLIERS_FOUND);
    } else {
      await transition(client, requestId, RequestStatus.FAILED, {
        error: 'No suppliers with contact details were found. Try a broader commodity or location.',
      });
    }
  });
}
