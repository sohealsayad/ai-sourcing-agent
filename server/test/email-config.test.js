import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import nodemailer from 'nodemailer';

// config.js requires a DATABASE_URL; these tests never connect.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { buildConfig, parseList } = await import('../src/config.js');
const { isRecipientAllowed } = await import('../src/services/recipients.js');
const { buildMailOptions, createSmtpTransport } = await import('../src/services/mailer.js');

const BASE = { DATABASE_URL: 'postgres://x/y', AI_MODE: 'mock' };
const SMTP = {
  ...BASE,
  EMAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'me@example.com',
  SMTP_PASS: 'secret',
  EMAIL_FROM: 'Sourcing Desk <me@example.com>',
  EMAIL_ALLOWED_RECIPIENTS: 'supplier1@tempmail.test, @suppliers.test',
};

describe('buildConfig: email', () => {
  test('defaults to the simulated transport with simulated suppliers', () => {
    const cfg = buildConfig(BASE);
    assert.equal(cfg.email.transport, 'simulated');
    assert.equal(cfg.simulation.suppliers, true);
    assert.equal(cfg.inbound.provider, 'none');
  });

  test('smtp: parses settings and turns simulated suppliers off by default', () => {
    const cfg = buildConfig(SMTP);
    assert.equal(cfg.email.transport, 'smtp');
    assert.deepEqual(cfg.email.allowedRecipients, ['supplier1@tempmail.test', '@suppliers.test']);
    assert.equal(cfg.email.smtp.port, 587);
    assert.equal(cfg.email.smtp.secure, false);
    assert.equal(cfg.simulation.suppliers, false);
    assert.equal(buildConfig({ ...SMTP, SMTP_PORT: '465' }).email.smtp.secure, true);
    assert.equal(buildConfig({ ...SMTP, SIMULATE_SUPPLIERS: 'true' }).simulation.suppliers, true);
  });

  test('smtp requires host, credentials and a sender', () => {
    assert.throws(() => buildConfig({ ...SMTP, SMTP_HOST: '', SMTP_PASS: '' }), /requires SMTP_HOST, SMTP_PASS/);
    assert.throws(() => buildConfig({ ...SMTP, EMAIL_FROM: '' }), /EMAIL_FROM/);
  });

  test('smtp requires an allowlist unless any recipient is explicitly allowed', () => {
    assert.throws(() => buildConfig({ ...SMTP, EMAIL_ALLOWED_RECIPIENTS: '' }), /requires EMAIL_ALLOWED_RECIPIENTS/);
    const live = buildConfig({ ...SMTP, AI_MODE: 'live', ANTHROPIC_API_KEY: 'k', EMAIL_ALLOWED_RECIPIENTS: '', EMAIL_ALLOW_ANY_RECIPIENT: 'true' });
    assert.equal(live.email.allowAnyRecipient, true);
  });

  test('allowing any recipient is refused in mock (test) mode', () => {
    assert.throws(() => buildConfig({ ...SMTP, EMAIL_ALLOW_ANY_RECIPIENT: 'true' }), /not allowed with AI_MODE=mock/);
  });

  test('rejects unknown transports and providers (gmail OAuth and mail.tm are no longer supported)', () => {
    assert.throws(() => buildConfig({ ...BASE, EMAIL_TRANSPORT: 'sendmail' }), /EMAIL_TRANSPORT must be one of/);
    assert.throws(() => buildConfig({ ...BASE, INBOUND_PROVIDER: 'gmail' }), /INBOUND_PROVIDER must be one of none, imap/);
    assert.throws(() => buildConfig({ ...BASE, INBOUND_PROVIDER: 'mailtm' }), /INBOUND_PROVIDER must be one of/);
  });

  test('imap inbound is off by default and reuses the SMTP credentials when enabled', () => {
    assert.equal(buildConfig(SMTP).inbound.provider, 'none', 'SMTP alone does not turn on reply polling');
    assert.throws(() => buildConfig({ ...BASE, INBOUND_PROVIDER: 'imap' }), /INBOUND_PROVIDER=imap .* requires SMTP_USER, SMTP_PASS/);

    const cfg = buildConfig({ ...SMTP, INBOUND_PROVIDER: 'imap' });
    assert.deepEqual(cfg.inbound.imap, {
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      user: 'me@example.com',
      pass: 'secret',
      mailbox: 'INBOX',
      sinceDays: 7,
    });
    const custom = buildConfig({ ...SMTP, INBOUND_PROVIDER: 'imap', IMAP_HOST: 'imap.zoho.com', IMAP_PORT: '143', IMAP_SECURE: 'false', IMAP_MAILBOX: 'Suppliers', INBOUND_SINCE_DAYS: '3' });
    assert.deepEqual(
      [custom.inbound.imap.host, custom.inbound.imap.port, custom.inbound.imap.secure, custom.inbound.imap.mailbox, custom.inbound.imap.sinceDays],
      ['imap.zoho.com', 143, false, 'Suppliers', 3],
    );
  });

  test('lists every problem at once', () => {
    assert.throws(() => buildConfig({ EMAIL_TRANSPORT: 'smtp' }), (err) => {
      assert.match(err.message, /DATABASE_URL/);
      assert.match(err.message, /SMTP_HOST/);
      assert.match(err.message, /EMAIL_ALLOWED_RECIPIENTS/);
      return true;
    });
  });

  test('parseList splits on commas, semicolons and spaces', () => {
    assert.deepEqual(parseList(' A@x.com;b@y.com  @Z.com '), ['a@x.com', 'b@y.com', '@z.com']);
    assert.deepEqual(parseList(undefined), []);
  });
});

describe('recipient allowlist', () => {
  const allow = ['supplier1@tempmail.test', '@suppliers.test'];

  test('allows exact addresses case-insensitively', () => {
    assert.equal(isRecipientAllowed('supplier1@tempmail.test', allow), true);
    assert.equal(isRecipientAllowed(' Supplier1@TempMail.TEST ', allow), true);
  });

  test('allows any address on an @domain entry, but not subdomains', () => {
    assert.equal(isRecipientAllowed('anyone@suppliers.test', allow), true);
    assert.equal(isRecipientAllowed('x@eu.suppliers.test', allow), false);
  });

  test('blocks everything else', () => {
    assert.equal(isRecipientAllowed('supplier2@tempmail.test', allow), false);
    assert.equal(isRecipientAllowed('sales@real-company.com', allow), false);
    assert.equal(isRecipientAllowed('', allow), false);
    assert.equal(isRecipientAllowed('supplier1@tempmail.test', []), false);
  });
});

describe('SMTP mail options', () => {
  const emailConfig = { from: 'Sourcing Desk <me@example.com>', replyTo: 'replies@inbox.test' };
  const message = {
    to: 'supplier1@tempmail.test',
    subject: 'RFQ-ABCDEF12-01: Request for quotation',
    body: 'Hello',
    idempotencyKey: 'rfq:3f1c',
    rfqRef: 'RFQ-ABCDEF12-01',
  };

  test('sends to the real supplier address with Reply-To, stable Message-ID and RFQ header', () => {
    const opts = buildMailOptions(message, emailConfig);
    assert.equal(opts.to, 'supplier1@tempmail.test'); // never redirected
    assert.equal(opts.from, emailConfig.from);
    assert.equal(opts.replyTo, 'replies@inbox.test');
    assert.equal(opts.messageId, '<rfq.3f1c@example.com>');
    assert.equal(opts.headers['X-RFQ-Ref'], 'RFQ-ABCDEF12-01');
    assert.deepEqual(buildMailOptions(message, emailConfig), opts, 'same outbox row → same Message-ID');
  });

  test('omits Reply-To when not configured', () => {
    assert.equal('replyTo' in buildMailOptions(message, { from: 'me@example.com' }), false);
  });

  test('the smtp transport hands the message to nodemailer (jsonTransport, nothing sent)', async () => {
    const smtp = createSmtpTransport(emailConfig, nodemailer.createTransport({ jsonTransport: true }));
    assert.equal(smtp.simulated, false);
    const { externalId } = await smtp.send(message);
    assert.equal(externalId, '<rfq.3f1c@example.com>');
  });
});
