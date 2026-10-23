import './env.js'; // keep first: configures the test database before src/ is loaded

import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../../src/app.js';
import { migrate } from '../../src/db/migrate.js';
import { pool, query } from '../../src/db/pool.js';
import { resetAllowlistCache } from '../../src/services/emailAllowlist.js';
import { interceptEnqueue } from '../../src/workflow/queue.js';
import { handlers } from '../../src/workflow/worker.js';

// ---------------------------------------------------------------------------
// In-memory job queue: everything the app enqueues lands here, and tests decide
// when (and how many times) each job runs.

export const jobs = [];

interceptEnqueue((name, data, options = {}) => {
  const id = randomUUID();
  jobs.push({ id, name, data, options });
  return id;
});

/** Runs one captured job through the same wrapped handler the worker uses. */
export function runJob(job, { retryCount = 0, retryLimit = 2 } = {}) {
  return handlers[job.name]([{ id: job.id, name: job.name, data: job.data, retryCount, retryLimit }]);
}

/** Removes and returns the captured jobs with this name. */
export function takeJobs(name) {
  const taken = jobs.filter((j) => j.name === name);
  for (const j of taken) jobs.splice(jobs.indexOf(j), 1);
  return taken;
}

const isDelayed = (job) => (job.options.startAfter ?? 0) > 0;

/**
 * Runs queued jobs (including ones they enqueue) until none are left.
 * Delayed jobs, such as reply timeouts, are skipped unless `includeDelayed` is set.
 */
export async function drain({ includeDelayed = false, maxSteps = 500 } = {}) {
  let steps = 0;
  for (;;) {
    const next = jobs.find((j) => includeDelayed || !isDelayed(j));
    if (!next) return steps;
    jobs.splice(jobs.indexOf(next), 1);
    await runJob(next);
    if (++steps > maxSteps) throw new Error('drain() did not settle; possible job loop');
  }
}

// ---------------------------------------------------------------------------
// Database

export async function setupDatabase() {
  await migrate({ log: () => {} });
}

export async function resetDatabase() {
  await query('TRUNCATE sourcing_requests, suppliers, inbound_cursor, email_allowlist RESTART IDENTITY CASCADE');
  resetAllowlistCache();
  jobs.length = 0;
}

export const closeDatabase = () => pool.end();

export const DEFAULT_SUPPLIERS = [
  { name: 'Alpha Foods', email: 'sales@alpha.example.com', score: 90 },
  { name: 'Beta Traders', email: 'sales@beta.example.com', score: 80 },
  { name: 'Gamma Exports', email: null, website: 'https://gamma.example.com', score: 70 },
];

/** Inserts a request and its suppliers directly. Returns { request, threads } with threads in seed order. */
export async function seedRequest({ status = 'SUPPLIERS_FOUND', suppliers = DEFAULT_SUPPLIERS, ...overrides } = {}) {
  const r = {
    commodity: '1121 Basmati rice',
    specifications: 'Extra-long grain, 25 kg bags',
    location: 'Dubai, UAE',
    quantity: 20,
    unit: 'tonnes',
    target_price: 850,
    max_price: 950,
    currency: 'USD',
    deadline: '2026-12-15',
    max_rounds: 3,
    buyer_name: 'Test Buyer',
    buyer_email: 'buyer@example.com',
    ...overrides,
  };
  const { rows } = await query(
    `INSERT INTO sourcing_requests
       (commodity, specifications, location, quantity, unit, target_price, max_price, currency, deadline, max_rounds,
        buyer_name, buyer_email, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [r.commodity, r.specifications, r.location, r.quantity, r.unit, r.target_price, r.max_price, r.currency,
      r.deadline, r.max_rounds, r.buyer_name, r.buyer_email, status],
  );
  const request = rows[0];

  const threads = [];
  for (const s of suppliers) {
    // Suppliers are shared across requests (unique by email), like discovery does.
    const { rows: [supplier] } = await query(
      `INSERT INTO suppliers (name, email, website) VALUES ($1, $2, $3)
       ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [s.name, s.email, s.website ?? null],
    );
    // `persona` pins the simulated supplier's behaviour so negotiations are deterministic.
    const { rows: [thread] } = await query(
      `INSERT INTO request_suppliers (request_id, supplier_id, relevance_score, ai_reasoning, sim_profile)
       VALUES ($1, $2, $3, 'seeded', $4) RETURNING *`,
      [request.id, supplier.id, s.score, s.persona ?? null],
    );
    threads.push({ ...thread, name: s.name, email: s.email });
  }
  return { request, threads };
}

/** A simulated supplier persona with sensible defaults. */
export const persona = (overrides = {}) => ({
  behavior: 'quote',
  floor: 820,
  opening: 1000,
  flexibility: 0.5,
  deliveryDays: 14,
  paymentTerms: 'Net 30',
  validityDays: 14,
  contact: 'Test Contact',
  ...overrides,
});

// ---------------------------------------------------------------------------
// HTTP

export async function startServer() {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    patch: (path, body) => call('PATCH', path, body),
    delete: (path) => call('DELETE', path),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------------------------------------------------------------------------
// Fake transports

/**
 * A transport that records sends; `shouldFail(message, attemptNumberForThatMessage)` can make it throw.
 * `simulated: false` makes it behave like real SMTP (the recipient allowlist applies).
 */
export function recordingTransport(shouldFail = () => false, { simulated = true } = {}) {
  const sent = [];
  const attempts = new Map();
  return {
    sent,
    simulated,
    async send(message) {
      const attempt = (attempts.get(message.idempotencyKey) ?? 0) + 1;
      attempts.set(message.idempotencyKey, attempt);
      if (shouldFail(message, attempt)) throw new Error('SMTP 421: service temporarily unavailable');
      sent.push(message);
      return { externalId: `test_${message.idempotencyKey}` };
    },
  };
}
