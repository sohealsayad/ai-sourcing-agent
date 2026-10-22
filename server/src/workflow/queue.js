import PgBoss from 'pg-boss';
import { config } from '../config.js';

export const JOBS = Object.freeze({
  DISCOVER_SUPPLIERS: 'discover-suppliers',
  DELIVER_MESSAGE: 'deliver-message',
  PROCESS_REPLY: 'process-reply',
  SIMULATE_SUPPLIER_REPLY: 'simulate-supplier-reply',
  REPLY_TIMEOUT: 'reply-timeout',
});

export const RETRY_LIMIT = 2;

// pg-boss keeps its job tables in their own schema in the same Postgres database.
export const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'pgboss' });

boss.on('error', (err) => console.error('[queue]', err));

export async function startQueue() {
  await boss.start();
  for (const name of Object.values(JOBS)) {
    if (!(await boss.getQueue(name))) await boss.createQueue(name);
  }
}

// Tests replace the queue with an in-memory capture so jobs can be run step by step.
let interceptor = null;
export function interceptEnqueue(fn) {
  interceptor = fn;
}

export function enqueue(name, data, options = {}) {
  if (interceptor) return interceptor(name, data, options);
  return boss.send(name, data, {
    retryLimit: RETRY_LIMIT,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 600,
    ...options,
  });
}

/** Enqueues delivery for outbound messages; call after the transaction that created them commits. */
export async function enqueueDeliveries(messageIds) {
  for (const messageId of messageIds) await enqueue(JOBS.DELIVER_MESSAGE, { messageId });
}
