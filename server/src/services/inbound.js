import { createHash } from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import { enqueue, JOBS } from '../workflow/queue.js';
import { logEvent } from '../workflow/stateMachine.js';

const REF_RE = /RFQ-[0-9A-F]{8}-\d{2}/i;

const normalizeText = (s = '') => s.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();

/**
 * Deduplication key for an inbound email. The email's own Message-ID identifies it across
 * every channel (webhook, inbox poller, repeated posts); without one, a hash of sender,
 * subject and body does. Either way, the same email is stored and processed only once.
 */
export function inboundKey({ messageId, from, subject, body }) {
  if (messageId) return `inbound:msgid:${messageId.trim().replace(/^<|>$/g, '').toLowerCase()}`;
  const digest = createHash('sha256')
    .update([(from ?? '').trim().toLowerCase(), normalizeText(subject), normalizeText(body)].join('\n\u0000'))
    .digest('hex');
  return `inbound:hash:${digest}`;
}

/**
 * Entry point for every supplier reply: webhook, inbox poller or simulator. Matches the reply
 * to a thread by its RFQ reference (or, failing that, the sender's address), stores it once
 * and queues it for processing.
 */
export async function ingestInboundEmail({ from, subject = '', body, messageId = null, idempotencyKey = null, simulated = false }) {
  const key = idempotencyKey ?? inboundKey({ messageId, from, subject, body });
  const result = await withTransaction(async (client) => {
    const ref = (subject.match(REF_RE) ?? body.match(REF_RE))?.[0]?.toUpperCase();

    let thread;
    if (ref) {
      ({ rows: [thread] } = await client.query(
        `SELECT rs.id, rs.request_id, s.name FROM request_suppliers rs JOIN suppliers s ON s.id = rs.supplier_id
          WHERE rs.rfq_ref = $1`,
        [ref],
      ));
    }
    if (!thread && from) {
      ({ rows: [thread] } = await client.query(
        `SELECT rs.id, rs.request_id, s.name FROM request_suppliers rs JOIN suppliers s ON s.id = rs.supplier_id
          WHERE lower(s.email) = lower($1) AND rs.status IN ('CONTACTED', 'COUNTERED')
          ORDER BY rs.last_contacted_at DESC NULLS LAST LIMIT 1`,
        [from],
      ));
    }
    if (!thread) return { matched: false };

    const { rows } = await client.query(
      `INSERT INTO messages (request_supplier_id, direction, kind, subject, body, from_email, delivery_status, idempotency_key, simulated)
       VALUES ($1, 'inbound', 'REPLY', $2, $3, $4, 'RECEIVED', $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [thread.id, subject, body, from ?? null, key, simulated],
    );
    if (!rows[0]) return { matched: true, duplicate: true, requestId: thread.request_id };

    await logEvent(client, thread.request_id, 'REPLY_RECEIVED', { supplier: thread.name, simulated });
    return { matched: true, messageId: rows[0].id, requestId: thread.request_id };
  });

  if (result.messageId) await enqueue(JOBS.PROCESS_REPLY, { messageId: result.messageId, requestId: result.requestId });
  return result;
}
