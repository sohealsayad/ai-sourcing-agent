import {
  closeDatabase,
  drain,
  jobs,
  recordingTransport,
  resetDatabase,
  runJob,
  seedRequest,
  setupDatabase,
  startServer,
  takeJobs,
} from './helpers/db.js';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { config } from '../src/config.js';
import { query } from '../src/db/pool.js';
import { setTransport } from '../src/services/mailer.js';
import { JOBS } from '../src/workflow/queue.js';

let api;
let transport;

before(async () => {
  // These tests cover sending only; supplier replies are tested in workflow.test.js.
  config.simulation.suppliers = false;
  await setupDatabase();
  api = await startServer();
});

after(async () => {
  setTransport();
  await api.close();
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  transport = recordingTransport();
  setTransport(transport);
});

const getRequest = async (id) => (await api.get(`/requests/${id}`)).body;
const send = (id, body = {}) => api.post(`/requests/${id}/send-proposals`, body);
const rfqRows = async (requestId) =>
  (
    await query(
      `SELECT m.* FROM messages m JOIN request_suppliers rs ON rs.id = m.request_supplier_id
        WHERE rs.request_id = $1 AND m.kind = 'RFQ' ORDER BY m.id`,
      [requestId],
    )
  ).rows;
const threadOf = (request, name) => request.suppliers.find((s) => s.name === name);

describe('send proposals: success', () => {
  test('sends one RFQ per contactable supplier and moves to AWAITING_REPLIES', async () => {
    const { request } = await seedRequest();

    const res = await send(request.id);
    assert.equal(res.status, 202);
    assert.equal(res.body.suppliers, 2);
    assert.equal(res.body.queued, 2);

    let r = await getRequest(request.id);
    assert.equal(r.status, 'SENDING_PROPOSALS');
    assert.equal(threadOf(r, 'Alpha Foods').status, 'QUEUED');
    assert.equal(threadOf(r, 'Gamma Exports').status, 'PENDING'); // no email → not selected

    await drain();

    r = await getRequest(request.id);
    assert.equal(r.status, 'AWAITING_REPLIES');
    assert.equal(transport.sent.length, 2);
    for (const name of ['Alpha Foods', 'Beta Traders']) {
      const t = threadOf(r, name);
      assert.equal(t.status, 'CONTACTED');
      assert.match(t.rfq_ref, /^RFQ-[0-9A-F]{8}-\d{2}$/);
      assert.equal(t.messages.length, 1);
      assert.equal(t.messages[0].delivery_status, 'SENT');
      assert.equal(t.messages[0].attempts, 1);
      assert.equal(t.messages[0].simulated, true);
    }
    const types = r.events.map((e) => e.type);
    assert.ok(types.includes('PROPOSALS_QUEUED'));
    assert.equal(types.filter((t) => t === 'MESSAGE_SENT').length, 2);
    assert.ok(r.events.some((e) => e.type === 'STATUS_CHANGED' && e.payload.to === 'AWAITING_REPLIES'));
  });

  test('RFQ has the full requirement and never reveals the target or maximum price', async () => {
    const { request } = await seedRequest();
    await send(request.id);
    await drain();

    const r = await getRequest(request.id);
    const t = threadOf(r, 'Alpha Foods');
    const { subject, body } = t.messages[0];

    assert.ok(subject.startsWith(t.rfq_ref));
    for (const expected of [
      'Dear Alpha Foods team',
      '1121 Basmati rice',
      'Extra-long grain, 25 kg bags',
      '20 tonnes',
      'Dubai, UAE',
      '15 December 2026',
      'quotation',
      t.rfq_ref,
      'Test Buyer',
    ]) {
      assert.ok(body.includes(expected), `RFQ body should include "${expected}"`);
    }
    assert.doesNotMatch(`${subject}\n${body}`, /850|950/);
    assert.equal(transport.sent[0].idempotencyKey.startsWith('rfq:'), true);
  });

  test('only the selected suppliers receive a proposal', async () => {
    const { request, threads } = await seedRequest();
    const beta = threads.find((t) => t.name === 'Beta Traders');

    const res = await send(request.id, { requestSupplierIds: [beta.id, beta.id] }); // duplicates collapse
    assert.equal(res.status, 202);
    assert.equal(res.body.suppliers, 1);
    await drain();

    const r = await getRequest(request.id);
    assert.equal(threadOf(r, 'Beta Traders').status, 'CONTACTED');
    assert.equal(threadOf(r, 'Alpha Foods').status, 'PENDING');
    assert.deepEqual(transport.sent.map((m) => m.to), ['sales@beta.example.com']);
  });
});

describe('send proposals: invalid requests', () => {
  for (const status of ['DISCOVERING', 'DEAL_RECOMMENDED', 'CLOSED']) {
    test(`rejects sending while the request is ${status}`, async () => {
      const { request } = await seedRequest({ status });
      const res = await send(request.id);
      assert.equal(res.status, 409);
      assert.match(res.body.error, new RegExp(`from ${status}`));
      assert.equal((await rfqRows(request.id)).length, 0);
    });
  }

  for (const status of ['AWAITING_REPLIES', 'NEGOTIATING']) {
    test(`while ${status}, more suppliers can only be invited by explicit choice`, async () => {
      const { request } = await seedRequest({ status });
      const res = await send(request.id);
      assert.equal(res.status, 400);
      assert.match(res.body.error, /Choose which suppliers to invite/);
      assert.equal((await rfqRows(request.id)).length, 0);
    });
  }

  test('a second send (double click) is rejected and creates no extra proposals', async () => {
    const { request } = await seedRequest();
    assert.equal((await send(request.id)).status, 202);
    const second = await send(request.id);
    assert.equal(second.status, 409);
    assert.equal((await rfqRows(request.id)).length, 2);
    assert.equal(jobs.filter((j) => j.name === JOBS.DELIVER_MESSAGE).length, 2);
  });

  test('rejects a supplier that belongs to another request', async () => {
    const { request } = await seedRequest();
    const { threads: other } = await seedRequest();
    const res = await send(request.id, { requestSupplierIds: [other[0].id] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Not suppliers of this request/);
    assert.equal((await getRequest(request.id)).status, 'SUPPLIERS_FOUND');
  });

  test('rejects a supplier without an email address', async () => {
    const { request, threads } = await seedRequest();
    const gamma = threads.find((t) => t.name === 'Gamma Exports');
    const res = await send(request.id, { requestSupplierIds: [gamma.id] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /No email address for: Gamma Exports/);
    assert.equal((await rfqRows(request.id)).length, 0);
  });

  test('rejects when no supplier can be contacted', async () => {
    const { request } = await seedRequest({ suppliers: [{ name: 'Gamma Exports', email: null, website: 'https://g.example.com', score: 50 }] });
    const res = await send(request.id);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /at least one supplier/);
  });

  test('validates the body and the request id', async () => {
    const { request } = await seedRequest();
    assert.equal((await send(request.id, { requestSupplierIds: ['not-a-uuid'] })).status, 400);
    assert.equal((await send(request.id, { requestSupplierIds: [] })).status, 400);
    assert.equal((await send('00000000-0000-4000-8000-000000000000')).status, 404);
  });
});

describe('send proposals: retries', () => {
  test('running the same delivery job twice sends each proposal once', async () => {
    const { request } = await seedRequest();
    await send(request.id);

    for (const job of takeJobs(JOBS.DELIVER_MESSAGE)) {
      await runJob(job);
      await runJob(job); // duplicate delivery (e.g. pg-boss redelivery)
    }

    assert.equal(transport.sent.length, 2);
    const rows = await rfqRows(request.id);
    assert.ok(rows.every((m) => m.delivery_status === 'SENT' && m.attempts === 1));
  });

  test('a transient failure is retried and delivered exactly once', async () => {
    transport = recordingTransport((m, attempt) => attempt === 1);
    setTransport(transport);
    const { request } = await seedRequest();
    await send(request.id);
    const deliveries = takeJobs(JOBS.DELIVER_MESSAGE);

    for (const job of deliveries) {
      await assert.rejects(runJob(job, { retryCount: 0 }), /SMTP 421/);
    }
    let r = await getRequest(request.id);
    assert.equal(r.status, 'SENDING_PROPOSALS');
    const pending = await rfqRows(request.id);
    assert.ok(pending.every((m) => m.delivery_status === 'PENDING' && m.attempts === 1 && /SMTP 421/.test(m.error)));
    assert.equal(r.events.filter((e) => e.type === 'MESSAGE_RETRYING').length, 2);

    for (const job of deliveries) await runJob(job, { retryCount: 1 });

    r = await getRequest(request.id);
    assert.equal(r.status, 'AWAITING_REPLIES');
    assert.equal(transport.sent.length, 2);
    const rows = await rfqRows(request.id);
    assert.ok(rows.every((m) => m.delivery_status === 'SENT' && m.attempts === 2 && m.error === null));
  });

  test('retrying after a failed send re-uses the same proposals', async () => {
    transport = recordingTransport(() => true);
    setTransport(transport);
    const { request } = await seedRequest();
    await send(request.id);
    for (const job of takeJobs(JOBS.DELIVER_MESSAGE)) await runJob(job, { retryCount: 2 }); // final attempt

    let r = await getRequest(request.id);
    assert.equal(r.status, 'FAILED');
    assert.match(r.error, /No proposals could be delivered \(2 failed\)/);
    const before = (await rfqRows(request.id)).map((m) => m.id);

    transport = recordingTransport();
    setTransport(transport);
    const res = await send(request.id);
    assert.equal(res.status, 202);
    assert.equal(res.body.queued, 2);
    await drain();

    r = await getRequest(request.id);
    assert.equal(r.status, 'AWAITING_REPLIES');
    const afterRows = await rfqRows(request.id);
    assert.deepEqual(afterRows.map((m) => m.id), before);
    assert.ok(afterRows.every((m) => m.delivery_status === 'SENT'));
    assert.equal(transport.sent.length, 2);
  });

  test('a request that failed during discovery cannot jump to sending', async () => {
    const { request } = await seedRequest({ status: 'FAILED' });
    const res = await send(request.id);
    assert.equal(res.status, 409);
  });
});

describe('send proposals: partial failures', () => {
  test('one failed supplier does not block the others', async () => {
    transport = recordingTransport((m) => m.to === 'sales@alpha.example.com');
    setTransport(transport);
    const { request } = await seedRequest();
    await send(request.id);
    for (const job of takeJobs(JOBS.DELIVER_MESSAGE)) await runJob(job, { retryCount: 2 });

    const r = await getRequest(request.id);
    assert.equal(r.status, 'AWAITING_REPLIES');
    const alpha = threadOf(r, 'Alpha Foods');
    assert.equal(alpha.status, 'SEND_FAILED');
    assert.match(alpha.last_error, /SMTP 421/);
    assert.equal(alpha.messages[0].delivery_status, 'FAILED');
    assert.equal(threadOf(r, 'Beta Traders').status, 'CONTACTED');

    const partial = r.events.find((e) => e.type === 'PROPOSALS_PARTIALLY_SENT');
    assert.deepEqual(partial.payload, { sent: 1, failed: 1 });
    assert.ok(r.events.some((e) => e.type === 'PROPOSAL_FAILED' && e.payload.supplier === 'Alpha Foods'));
  });

  test('the request waits until every proposal has settled', async () => {
    transport = recordingTransport((m, attempt) => m.to === 'sales@alpha.example.com' && attempt === 1);
    setTransport(transport);
    const { request } = await seedRequest();
    await send(request.id);
    const [first, second] = takeJobs(JOBS.DELIVER_MESSAGE);

    const alphaJob = (await rfqRows(request.id)).find((m) => m.to_email === 'sales@alpha.example.com');
    const [alpha, beta] = alphaJob.id === first.data.messageId ? [first, second] : [second, first];

    await assert.rejects(runJob(alpha), /SMTP 421/); // alpha will be retried
    await runJob(beta);
    assert.equal((await getRequest(request.id)).status, 'SENDING_PROPOSALS');

    await runJob(alpha, { retryCount: 1 });
    assert.equal((await getRequest(request.id)).status, 'AWAITING_REPLIES');
  });
});
