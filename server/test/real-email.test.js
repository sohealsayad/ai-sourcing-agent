import {
  closeDatabase,
  drain,
  recordingTransport,
  resetDatabase,
  runJob,
  seedRequest,
  setupDatabase,
  startServer,
  takeJobs,
} from './helpers/db.js';

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { config } from '../src/config.js';
import { query } from '../src/db/pool.js';
import { Readable } from 'node:stream';
import { createImapClient, ImapAuthError } from '../src/services/inbound/imap.js';
import { replyText, stripQuotedReply } from '../src/services/inbound/text.js';
import { setTransport } from '../src/services/mailer.js';
import { pollInbox, setInboxClient } from '../src/workflow/inboxPoller.js';
import { JOBS } from '../src/workflow/queue.js';

let api;

before(async () => {
  await setupDatabase();
  api = await startServer();
});

after(async () => {
  await api.close();
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  setTransport();
  config.simulation.suppliers = false; // real-email scenarios: no simulated replies
  config.email.allowedRecipients = [];
  config.email.allowAnyRecipient = false;
  config.inbound.provider = 'none';
});

afterEach(() => {
  setTransport();
  config.email.allowedRecipients = [];
  config.inbound.provider = 'none';
});

const getRequest = async (id) => (await api.get(`/requests/${id}`)).body;
const threadOf = (r, name) => r.suppliers.find((s) => s.name === name);
const count = async (sql, params) => (await query(sql, params)).rowCount;

/** Pretends to be real SMTP: the allowlist applies and messages are not marked simulated. */
function useSmtpLikeTransport(allowed) {
  const transport = recordingTransport(() => false, { simulated: false });
  setTransport(transport);
  config.email.allowedRecipients = allowed;
  return transport;
}

describe('recipient allowlist with real email', () => {
  test('only allow-listed suppliers are selected and emailed; others are flagged', async () => {
    const transport = useSmtpLikeTransport(['sales@alpha.example.com']);
    const { request } = await seedRequest();

    const before = await getRequest(request.id);
    assert.equal(threadOf(before, 'Alpha Foods').can_email, true);
    assert.equal(threadOf(before, 'Beta Traders').can_email, false);
    assert.equal(threadOf(before, 'Gamma Exports').can_email, false);

    const res = await api.post(`/requests/${request.id}/send-proposals`, {});
    assert.equal(res.status, 202);
    assert.equal(res.body.suppliers, 1);
    await drain();

    assert.deepEqual(transport.sent.map((m) => m.to), ['sales@alpha.example.com']);
    const r = await getRequest(request.id);
    assert.equal(r.status, 'AWAITING_REPLIES');
    assert.equal(threadOf(r, 'Alpha Foods').messages[0].simulated, false);
    assert.equal(threadOf(r, 'Beta Traders').status, 'PENDING');
  });

  test('explicitly selecting a blocked supplier is refused', async () => {
    useSmtpLikeTransport(['sales@alpha.example.com']);
    const { request, threads } = await seedRequest();
    const beta = threads.find((t) => t.name === 'Beta Traders');
    const res = await api.post(`/requests/${request.id}/send-proposals`, { requestSupplierIds: [beta.id] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Not allowed to email: Beta Traders <sales@beta\.example\.com>/);
    assert.equal(await count(`SELECT 1 FROM messages`), 0);
  });

  test('refuses to send when no supplier is allow-listed', async () => {
    useSmtpLikeTransport(['someone@else.test']);
    const { request } = await seedRequest();
    const res = await api.post(`/requests/${request.id}/send-proposals`, {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not in EMAIL_ALLOWED_RECIPIENTS/);
  });

  test('a blocked recipient at delivery time fails at once, without retries', async () => {
    const transport = useSmtpLikeTransport(['sales@alpha.example.com', 'sales@beta.example.com']);
    const { request } = await seedRequest();
    await api.post(`/requests/${request.id}/send-proposals`, {});
    config.email.allowedRecipients = ['sales@alpha.example.com']; // beta removed before delivery

    for (const job of takeJobs(JOBS.DELIVER_MESSAGE)) await runJob(job, { retryCount: 0 }); // first attempt only

    const r = await getRequest(request.id);
    const beta = threadOf(r, 'Beta Traders');
    assert.equal(beta.status, 'SEND_FAILED');
    assert.equal(beta.messages[0].delivery_status, 'FAILED');
    assert.equal(beta.messages[0].attempts, 1);
    assert.match(beta.messages[0].error, /Recipient not in allowlist: sales@beta\.example\.com/);
    assert.equal(threadOf(r, 'Alpha Foods').status, 'CONTACTED');
    assert.equal(r.status, 'AWAITING_REPLIES');
    assert.deepEqual(transport.sent.map((m) => m.to), ['sales@alpha.example.com']);
  });
});

describe('adding test suppliers by hand', () => {
  test('adds a Temp Mail supplier that can then be selected', async () => {
    const { request } = await seedRequest();
    const res = await api.post(`/requests/${request.id}/suppliers`, { name: 'Temp Supplier', email: 'Temp1@TempMail.TEST' });
    assert.equal(res.status, 201);
    assert.equal(res.body.can_email, true); // simulated transport: everything is "sendable"

    const r = await getRequest(request.id);
    const added = threadOf(r, 'Temp Supplier');
    assert.equal(added.email, 'temp1@tempmail.test');
    assert.equal(added.status, 'PENDING');
    assert.equal(added.ai_reasoning, 'Added manually');
    assert.ok(r.events.some((e) => e.type === 'SUPPLIER_ADDED' && e.payload.email === 'temp1@tempmail.test'));

    const send = await api.post(`/requests/${request.id}/send-proposals`, { requestSupplierIds: [added.id] });
    assert.equal(send.status, 202);
  });

  test('reports whether the address is allow-listed', async () => {
    useSmtpLikeTransport(['temp1@tempmail.test']);
    const { request } = await seedRequest();
    assert.equal((await api.post(`/requests/${request.id}/suppliers`, { name: 'Allowed', email: 'temp1@tempmail.test' })).body.can_email, true);
    assert.equal((await api.post(`/requests/${request.id}/suppliers`, { name: 'Blocked', email: 'other@tempmail.test' })).body.can_email, false);
  });

  test('rejects duplicates, bad input and the wrong stage; reuses suppliers across requests', async () => {
    const { request } = await seedRequest();
    const body = { name: 'Temp Supplier', email: 'temp1@tempmail.test' };
    assert.equal((await api.post(`/requests/${request.id}/suppliers`, body)).status, 201);
    const dup = await api.post(`/requests/${request.id}/suppliers`, body);
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /already on the request/);
    assert.equal((await api.post(`/requests/${request.id}/suppliers`, { name: 'X', email: 'nope' })).status, 400);

    const { request: other } = await seedRequest();
    assert.equal((await api.post(`/requests/${other.id}/suppliers`, body)).status, 201);
    assert.equal(await count(`SELECT 1 FROM suppliers WHERE email = 'temp1@tempmail.test'`), 1);

    const { request: late } = await seedRequest({ status: 'NEGOTIATING' });
    const wrong = await api.post(`/requests/${late.id}/suppliers`, body);
    assert.equal(wrong.status, 409);
    assert.match(wrong.body.error, /before proposals are sent/);
  });
});

// One allow-listed supplier that has received an RFQ; returns its RFQ reference.
async function contactedSupplier() {
  const { request } = await seedRequest({ suppliers: [{ name: 'Alpha Foods', email: 'sales@alpha.example.com', score: 90 }] });
  await api.post(`/requests/${request.id}/send-proposals`, {});
  await drain();
  const r = await getRequest(request.id);
  return { requestId: request.id, ref: threadOf(r, 'Alpha Foods').rfq_ref };
}

const quoteEmail = (ref, text = 'Price: USD 1,000.00 per tonne\nDelivery: within 20 days\nPayment terms: Net 30') => ({
  from: 'sales@alpha.example.com',
  subject: `Re: ${ref}: Basmati rice`,
  text,
});

describe('duplicate supplier replies', () => {
  test('the same email posted twice (no Message-ID) creates one quote and one round', async () => {
    const { requestId, ref } = await contactedSupplier();
    const first = await api.post('/webhooks/email', quoteEmail(ref));
    assert.deepEqual(first.body, { matched: true, duplicate: false });
    await drain(); // quote 1000 > target → counter-offer, round 1

    const again = await api.post('/webhooks/email', quoteEmail(ref));
    assert.deepEqual(again.body, { matched: true, duplicate: true });
    const reformatted = await api.post('/webhooks/email', quoteEmail(ref, 'Price: USD 1,000.00 per tonne   \r\nDelivery: within 20 days\r\nPayment terms: Net 30\r\n'));
    assert.equal(reformatted.body.duplicate, true, 'line endings and trailing spaces do not defeat the dedupe');
    await drain();

    const r = await getRequest(requestId);
    const alpha = threadOf(r, 'Alpha Foods');
    assert.equal(alpha.rounds_used, 1);
    assert.equal(alpha.offers.length, 1);
    assert.equal(alpha.messages.filter((m) => m.kind === 'REPLY').length, 1);
    assert.equal(alpha.messages.filter((m) => m.kind === 'COUNTER').length, 1);
  });

  test('a reply received before our counter is not treated as the answer to it', async () => {
    const { requestId, ref } = await contactedSupplier();
    await api.post('/webhooks/email', quoteEmail(ref));
    await drain();

    // A second, different reply that crossed with our counter-offer (received just before it).
    const { rows: [thread] } = await query(`SELECT id FROM request_suppliers WHERE request_id = $1`, [requestId]);
    const { rows: [counter] } = await query(`SELECT created_at FROM messages WHERE request_supplier_id = $1 AND kind = 'COUNTER'`, [thread.id]);
    const { rows: [stale] } = await query(
      `INSERT INTO messages (request_supplier_id, direction, kind, subject, body, delivery_status, idempotency_key, created_at)
       VALUES ($1, 'inbound', 'REPLY', 'Re: RFQ', 'Price: USD 980.00 per tonne', 'RECEIVED', 'stale-test', $2::timestamptz - interval '1 second')
       RETURNING id`,
      [thread.id, counter.created_at],
    );
    await runJob({ id: 'stale', name: JOBS.PROCESS_REPLY, data: { messageId: stale.id, requestId } });

    const r = await getRequest(requestId);
    const alpha = threadOf(r, 'Alpha Foods');
    assert.equal(alpha.rounds_used, 1);
    assert.equal(alpha.offers.length, 1);
    assert.equal(alpha.status, 'COUNTERED');
    assert.ok(r.events.some((e) => e.type === 'LATE_REPLY_IGNORED' && e.payload.reason === 'stale'));
  });

  test('the same Message-ID via webhook and inbox poller is stored once', async () => {
    const { ref } = await contactedSupplier();
    await api.post('/webhooks/email', { ...quoteEmail(ref), messageId: '<reply-1@alpha.example.com>' });

    const fake = fakeImap([
      imapMessage({ uid: 1, messageId: '<reply-1@alpha.example.com>', from: 'sales@alpha.example.com', subject: `Re: ${ref}`, text: 'different text, same email' }),
    ]);
    useFakeInbox(fake);
    const result = await pollInbox();
    assert.equal(result.ingested, 0);
    assert.equal(await count(`SELECT 1 FROM messages WHERE direction = 'inbound'`), 1);
  });
});

// ---------------------------------------------------------------------------
// IMAP poller: the real createImapClient code against a fake ImapFlow (no mail server)

/** A message as the fake server stores it: envelope fields, bodyStructure and part contents. */
function imapMessage({ uid, messageId, from, subject, text, html, singlePart = false }) {
  if (singlePart) {
    return { uid, messageId, from, subject, parts: { 1: text }, bodyStructure: { type: 'text/plain' } };
  }
  const childNodes = [];
  const parts = {};
  if (text) {
    childNodes.push({ part: '1', type: 'text/plain' });
    parts['1'] = text;
  }
  if (html) {
    const part = String(childNodes.length + 1);
    childNodes.push({ part, type: 'text/html' });
    parts[part] = html;
  }
  childNodes.push({ part: String(childNodes.length + 1), type: 'application/pdf', disposition: 'attachment' });
  return { uid, messageId, from, subject, parts, bodyStructure: { type: 'multipart/mixed', childNodes } };
}

function fakeImap(messages, { uidValidity = 42n } = {}) {
  const state = { connections: [], searches: [], fetches: 0, downloads: 0, logouts: 0, releases: 0, lockedPath: null, failure: null };
  const find = (uid) => messages.find((m) => m.uid === Number(uid));

  class FakeImapFlow {
    constructor(options) {
      this.options = options;
      this.mailbox = false;
      state.connections.push(options);
    }
    async connect() {
      if (state.failure === 'auth') throw Object.assign(new Error('Invalid credentials (Failure)'), { authenticationFailed: true });
      if (state.failure === 'network') throw Object.assign(new Error('getaddrinfo ENOTFOUND imap.test'), { code: 'ENOTFOUND' });
    }
    async getMailboxLock(path) {
      state.lockedPath = path;
      this.mailbox = { path, uidValidity };
      return { release: () => state.releases++ };
    }
    async search(criteria, options) {
      state.searches.push({ criteria, options });
      return messages.map((m) => m.uid);
    }
    async fetchOne(uid, query, options) {
      state.fetches++;
      assert.equal(options.uid, true);
      const m = find(uid);
      return { uid: m.uid, envelope: { messageId: m.messageId, subject: m.subject, from: [{ name: 'Sender', address: m.from }] }, bodyStructure: m.bodyStructure };
    }
    async download(uid, part, options) {
      state.downloads++;
      assert.equal(options.uid, true);
      return { meta: {}, content: Readable.from([Buffer.from(find(uid).parts[part], 'utf8')]) };
    }
    async logout() {
      state.logouts++;
    }
  }
  return { FakeImapFlow, state, fail: (kind) => (state.failure = kind) };
}

const IMAP_SETTINGS = { host: 'imap.test', port: 993, secure: true, user: 'buyer@gmail.test', pass: 'app-password', mailbox: 'INBOX', sinceDays: 7 };

function useFakeInbox(fake) {
  config.inbound.provider = 'imap';
  setInboxClient(createImapClient({ ...IMAP_SETTINGS, ImapFlowImpl: fake.FakeImapFlow }));
}

describe('IMAP inbox poller', () => {
  test('feeds real replies into the workflow once and skips unmatched mail', async () => {
    const { requestId, ref } = await contactedSupplier();
    const fake = fakeImap([
      imapMessage({ uid: 11, messageId: '<spam@x.test>', from: 'spam@x.test', subject: 'Hello', text: 'Buy now' }),
      imapMessage({
        uid: 12,
        messageId: '<r1@alpha.example.com>',
        from: 'Sales@Alpha.Example.com',
        subject: `Re: ${ref}: Basmati rice`,
        // The quoted history below the reply must not be parsed as part of the supplier's answer.
        text: 'Price: USD 845.00 per tonne\r\nDelivery: within 12 days\r\nPayment terms: Net 30\r\n\r\nOn Wed, 22 Oct 2026 at 10:00, Buyer <buyer@gmail.test> wrote:\r\n> we would like to propose USD 700.00 per tonne',
      }),
    ]);
    useFakeInbox(fake);

    assert.deepEqual(await pollInbox(), { checked: 2, ingested: 1 });

    // Signs in with the SMTP account, reads INBOX, only recent mail not sent by us.
    assert.deepEqual(fake.state.connections[0], { host: 'imap.test', port: 993, secure: true, auth: { user: 'buyer@gmail.test', pass: 'app-password' }, logger: false });
    assert.equal(fake.state.lockedPath, 'INBOX');
    const { criteria, options } = fake.state.searches[0];
    assert.deepEqual(criteria.not, { from: 'buyer@gmail.test' });
    assert.ok(Math.abs(Date.now() - 7 * 86_400_000 - criteria.since.getTime()) < 60_000, 'searches the last 7 days');
    assert.equal(options.uid, true);
    assert.equal(fake.state.logouts, 1);
    assert.equal(fake.state.releases, 1);

    await drain();
    const r = await getRequest(requestId);
    assert.equal(r.status, 'DEAL_RECOMMENDED'); // 845 ≤ target 850
    const alpha = threadOf(r, 'Alpha Foods');
    assert.equal(alpha.current_offer_price, 845);
    const replyMsg = alpha.messages.find((m) => m.kind === 'REPLY');
    assert.equal(replyMsg.simulated, false);
    assert.doesNotMatch(replyMsg.body, /700\.00/);

    const cursor = (await query(`SELECT provider, external_id, matched FROM inbound_cursor ORDER BY external_id`)).rows;
    assert.deepEqual(cursor, [
      { provider: 'imap', external_id: '42:11', matched: false },
      { provider: 'imap', external_id: '42:12', matched: true },
    ]);

    assert.deepEqual(await pollInbox(), { checked: 2, ingested: 0 });
    assert.equal(fake.state.fetches, 2, 'already-seen messages are not fetched again');
    assert.equal(fake.state.downloads, 2);
    assert.equal(fake.state.logouts, 2, 'each poll closes its connection');
  });

  test('reads HTML-only and single-part messages', async () => {
    const fake = fakeImap([
      imapMessage({ uid: 1, messageId: '<h@x>', from: 'a@b.test', subject: 'html', html: '<p>Price: USD 1.00 per kg</p><p>Tom &amp; Co</p>' }),
      imapMessage({ uid: 2, messageId: '<p@x>', from: 'a@b.test', subject: 'plain', text: 'Price: USD 2.00 per kg', singlePart: true }),
    ]);
    const client = createImapClient({ ...IMAP_SETTINGS, ImapFlowImpl: fake.FakeImapFlow });
    const emails = await client.session(async ({ list, get }) => Promise.all((await list()).map((s) => get(s.id))));

    assert.deepEqual(emails.map((e) => e.externalId), ['42:2', '42:1'], 'newest first');
    assert.equal(emails[0].body, 'Price: USD 2.00 per kg');
    assert.equal(emails[1].body, 'Price: USD 1.00 per kg\nTom & Co');
    assert.equal(emails[1].messageId, '<h@x>');
  });

  test('a failed login explains how to fix it; other connection errors are reported', async () => {
    const fake = fakeImap([]);
    useFakeInbox(fake);
    fake.fail('auth');
    await assert.rejects(pollInbox(), (err) => err instanceof ImapAuthError && /App Password/.test(err.message) && /buyer@gmail\.test/.test(err.message));
    assert.equal(fake.state.lockedPath, null, 'no mailbox is opened without a session');

    fake.fail('network');
    await assert.rejects(pollInbox(), /IMAP connection to imap\.test:993 failed: getaddrinfo ENOTFOUND/);
  });

  test('does nothing unless INBOUND_PROVIDER=imap', async () => {
    assert.deepEqual(await pollInbox(), { checked: 0, ingested: 0 });
  });
});

describe('reply text helpers', () => {
  test('strip quoted history and normalise line endings', () => {
    assert.equal(stripQuotedReply('We accept.\n\nOn Mon, 1 Jan 2026, X <x@y> wrote:\n> old text'), 'We accept.');
    assert.equal(stripQuotedReply('Line one\n> quoted\nLine two'), 'Line one\nLine two');
    assert.equal(replyText('Hi\r\nThere\r\n'), 'Hi\nThere');
    assert.equal(replyText('> only quoted text'), '> only quoted text', 'falls back to the full text');
  });
});
