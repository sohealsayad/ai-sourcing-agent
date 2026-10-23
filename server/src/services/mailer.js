// Outbound email transport.
//  - "simulated" (default): messages are recorded in the database but never leave the server.
//  - "smtp": real delivery through nodemailer, restricted to EMAIL_ALLOWED_RECIPIENTS unless
//    EMAIL_ALLOW_ANY_RECIPIENT=true. Recipients are never rewritten or redirected.
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { isUiAllowed } from './emailAllowlist.js';
import { isRecipientAllowed } from './recipients.js';

/** A failure that retrying cannot fix (e.g. a blocked recipient). */
export class PermanentDeliveryError extends Error {}

const simulatedTransport = {
  name: 'simulated',
  simulated: true,
  async send({ idempotencyKey }) {
    return { externalId: `sim_${idempotencyKey}` };
  },
};

/**
 * nodemailer options for one message. The Message-ID is derived from the idempotency key,
 * so a resend of the same outbox row carries the same Message-ID (receivers can dedupe it).
 */
export function buildMailOptions({ to, subject, body, idempotencyKey, rfqRef }, emailConfig) {
  const domain = emailConfig.from.match(/@([^>\s]+)/)?.[1] ?? 'sourcing-desk.local';
  return {
    from: emailConfig.from,
    to,
    ...(emailConfig.replyTo && { replyTo: emailConfig.replyTo }),
    subject,
    text: body,
    messageId: `<${idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '.')}@${domain}>`,
    headers: {
      'X-Sourcing-Idempotency-Key': idempotencyKey,
      ...(rfqRef && { 'X-RFQ-Ref': rfqRef }),
    },
  };
}

/** SMTP transport; `transporter` can be injected (tests use nodemailer's jsonTransport). */
export function createSmtpTransport(emailConfig, transporter) {
  const tx =
    transporter ??
    nodemailer.createTransport({
      host: emailConfig.smtp.host,
      port: emailConfig.smtp.port,
      secure: emailConfig.smtp.secure,
      auth: { user: emailConfig.smtp.user, pass: emailConfig.smtp.pass },
    });
  return {
    name: 'smtp',
    simulated: false,
    async send(message) {
      const info = await tx.sendMail(buildMailOptions(message, emailConfig));
      return { externalId: info.messageId };
    },
  };
}

let transport = config.email.transport === 'smtp' ? createSmtpTransport(config.email) : simulatedTransport;

/** Test hook: swap in a fake transport (pass nothing to restore the simulated default). */
export function setTransport(next) {
  transport = next ?? simulatedTransport;
}

export const isSimulatedTransport = () => Boolean(transport.simulated);

/** Whether this address may be emailed with the current transport and allowlist. */
export function recipientAllowed(email) {
  if (!email) return false;
  if (transport.simulated || config.email.allowAnyRecipient) return true;
  // Allowed via .env (EMAIL_ALLOWED_RECIPIENTS) or approved from the UI.
  return isRecipientAllowed(email, config.email.allowedRecipients) || isUiAllowed(email);
}

/** Sends one email. Resolves to { externalId }; throws on failure. */
export function sendEmail(message) {
  if (!recipientAllowed(message.to)) {
    return Promise.reject(new PermanentDeliveryError(`Recipient not in allowlist: ${message.to}`));
  }
  return transport.send(message);
}
