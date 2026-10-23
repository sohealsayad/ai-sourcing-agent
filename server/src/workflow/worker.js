import { config } from '../config.js';
import { pool, query, withTransaction } from '../db/pool.js';
import { deliverMessage, failDelivery, onDelivered } from './jobs/deliverMessage.js';
import { discoverSuppliers } from './jobs/discoverSuppliers.js';
import { processReply } from './jobs/processReply.js';
import { replyTimeout } from './jobs/replyTimeout.js';
import { simulateSupplierReply } from './jobs/simulateSupplierReply.js';
import { syncRequestStatus } from './progress.js';
import { boss, enqueue, enqueueDeliveries, JOBS, RETRY_LIMIT } from './queue.js';
import { logEvent, RequestStatus, ThreadStatus } from './stateMachine.js';

/** Marks a request FAILED if it is still in the given in-progress status. */
const failRequestIn = (inProgressStatus) => async (job, err) => {
  const { requestId } = job.data;
  const { rowCount } = await query(
    `UPDATE sourcing_requests SET status = $2, error = $3, updated_at = now()
      WHERE id = $1 AND status = $4`,
    [requestId, RequestStatus.FAILED, err.message, inProgressStatus],
  );
  if (rowCount) {
    await logEvent(pool, requestId, 'STATUS_CHANGED', { from: inProgressStatus, to: RequestStatus.FAILED, error: err.message });
  }
};

/** When a per-supplier job keeps crashing, park that thread for manual review instead of hanging. */
async function threadNeedsReview(job, err) {
  const threadId =
    job.data.threadId ??
    (await query('SELECT request_supplier_id FROM messages WHERE id = $1', [job.data.messageId])).rows[0]?.request_supplier_id;
  if (!threadId) return;
  await withTransaction(async (client) => {
    const { rows: [t] } = await client.query(
      `UPDATE request_suppliers SET status = $2, final_reason = $3, updated_at = now()
        WHERE id = $1 AND status IN ('CONTACTED', 'COUNTERED')
        RETURNING request_id`,
      [threadId, ThreadStatus.NEEDS_REVIEW, `Automatic processing failed: ${err.message}`],
    );
    if (t) await syncRequestStatus(client, t.request_id);
  });
}

/**
 * Wraps a job handler: passes `isFinalAttempt`, logs failures and, once retries are
 * exhausted, runs `onFinalFailure` so nothing hangs in an in-progress state.
 */
export function handle(name, fn, onFinalFailure) {
  return async ([job]) => {
    const retryCount = job.retryCount ?? 0;
    const isFinalAttempt = retryCount >= (job.retryLimit ?? RETRY_LIMIT);
    try {
      await fn(job, { isFinalAttempt });
    } catch (err) {
      // Errors marked permanent (bad API key, retired model, ...) can never succeed: stop now.
      const final = isFinalAttempt || Boolean(err.permanent);
      console.error(`[${name}] job ${job.id} attempt ${retryCount + 1} failed:`, err.message);
      if (job.data.requestId) {
        await logEvent(pool, job.data.requestId, 'JOB_FAILED', {
          job: name,
          attempt: retryCount + 1,
          final,
          error: err.message,
        });
      }
      if (!final || !onFinalFailure) throw err; // let pg-boss retry with backoff
      await onFinalFailure(job, err);
    }
  };
}

/** Job name → wrapped handler. Exported so tests can run jobs directly. */
export const handlers = {
  [JOBS.DISCOVER_SUPPLIERS]: handle(JOBS.DISCOVER_SUPPLIERS, discoverSuppliers, failRequestIn(RequestStatus.DISCOVERING)),
  [JOBS.DELIVER_MESSAGE]: handle(JOBS.DELIVER_MESSAGE, deliverMessage, failDelivery),
  [JOBS.PROCESS_REPLY]: handle(JOBS.PROCESS_REPLY, processReply, threadNeedsReview),
  [JOBS.SIMULATE_SUPPLIER_REPLY]: handle(JOBS.SIMULATE_SUPPLIER_REPLY, simulateSupplierReply, threadNeedsReview),
  [JOBS.REPLY_TIMEOUT]: handle(JOBS.REPLY_TIMEOUT, replyTimeout, threadNeedsReview),
};

const randomDelay = ([min, max]) => Math.round(min + Math.random() * (max - min));

// Once a proposal or counter-offer is delivered, wait for the supplier: schedule the
// simulated reply (in simulation) and a timeout for that round.
onDelivered(async (msg) => {
  if (msg.kind !== 'RFQ' && msg.kind !== 'COUNTER') return;
  const data = { threadId: msg.request_supplier_id, requestId: msg.request_id, round: msg.kind === 'RFQ' ? 0 : msg.rounds_used };
  if (config.simulation.suppliers) {
    await enqueue(JOBS.SIMULATE_SUPPLIER_REPLY, data, { startAfter: randomDelay(config.simulation.replyDelaySeconds) });
  }
  await enqueue(JOBS.REPLY_TIMEOUT, data, { startAfter: config.replyTimeoutSeconds });
});

export async function startWorker() {
  for (const [name, handler] of Object.entries(handlers)) {
    await boss.work(name, { includeMetadata: true }, handler);
  }

  // Recover work interrupted by a crash or a failed enqueue. Every job is idempotent,
  // so re-queuing one that is already queued or running is harmless.
  const { rows: stuck } = await query('SELECT id FROM sourcing_requests WHERE status = $1', [RequestStatus.DISCOVERING]);
  for (const { id } of stuck) await enqueue(JOBS.DISCOVER_SUPPLIERS, { requestId: id });

  const { rows: pending } = await query(
    `SELECT id FROM messages WHERE direction = 'outbound' AND delivery_status = 'PENDING' ORDER BY created_at`,
  );
  await enqueueDeliveries(pending.map((m) => m.id));

  const { rows: unprocessed } = await query(
    `SELECT m.id, rs.request_id FROM messages m JOIN request_suppliers rs ON rs.id = m.request_supplier_id
      WHERE m.direction = 'inbound' AND m.processed_at IS NULL`,
  );
  for (const m of unprocessed) await enqueue(JOBS.PROCESS_REPLY, { messageId: m.id, requestId: m.request_id });

  // Threads still waiting for a supplier get a fresh timeout so they cannot wait forever.
  const { rows: waiting } = await query(
    `SELECT id, request_id, rounds_used FROM request_suppliers WHERE status IN ('CONTACTED', 'COUNTERED')`,
  );
  for (const t of waiting) {
    const data = { threadId: t.id, requestId: t.request_id, round: t.rounds_used };
    if (config.simulation.suppliers) await enqueue(JOBS.SIMULATE_SUPPLIER_REPLY, data);
    await enqueue(JOBS.REPLY_TIMEOUT, data, { startAfter: config.replyTimeoutSeconds });
  }

  const recovered = stuck.length + pending.length + unprocessed.length + waiting.length;
  if (recovered) console.log(`[worker] recovered ${recovered} unfinished item(s)`);
  console.log('[worker] listening for jobs');
}
