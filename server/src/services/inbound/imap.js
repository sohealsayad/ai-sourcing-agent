// Reads supplier replies from our Reply-To mailbox over IMAP (imapflow), signing in with the
// same account as SMTP: for Gmail, SMTP_USER plus the App Password in SMTP_PASS.
import { ImapFlow } from 'imapflow';
import { htmlToText, replyText } from './text.js';

export class ImapAuthError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Depth-first search of an imapflow bodyStructure for the first part of a MIME type. */
function findPart(node, type) {
  if (!node) return null;
  if (node.type === type && !node.disposition?.startsWith?.('attachment')) return node;
  for (const child of node.childNodes ?? []) {
    const found = findPart(child, type);
    if (found) return found;
  }
  return null;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * IMAP client for the inbox poller. `session(fn)` opens one connection per poll and passes
 * `list()` (ids of recent mail, newest first) and `get(id)` (one email, ready for ingestion).
 * `ImapFlowImpl` is injectable so tests can run without a mail server.
 */
export function createImapClient({ host, port, secure, user, pass, mailbox = 'INBOX', sinceDays = 7, ImapFlowImpl = ImapFlow }) {
  return {
    async session(fn) {
      const client = new ImapFlowImpl({ host, port, secure, auth: { user, pass }, logger: false });
      try {
        await client.connect();
      } catch (err) {
        if (err.authenticationFailed) {
          throw new ImapAuthError(
            `IMAP login to ${host} failed for ${user}; check SMTP_USER / SMTP_PASS (for Gmail: an App Password, with IMAP access enabled)`,
          );
        }
        throw new Error(`IMAP connection to ${host}:${port} failed: ${err.message}`);
      }

      const lock = await client.getMailboxLock(mailbox);
      try {
        // A UID is only unique together with the mailbox's UIDVALIDITY, so both form the id.
        const validity = String(client.mailbox?.uidValidity ?? '0');

        const list = async () => {
          const since = new Date(Date.now() - sinceDays * DAY_MS);
          // Skip mail we sent ourselves (e.g. when Reply-To is the sending account).
          const uids = (await client.search({ since, not: { from: user } }, { uid: true })) || [];
          return [...uids].sort((a, b) => b - a).map((uid) => ({ id: `${validity}:${uid}` }));
        };

        const get = async (id) => {
          const uid = Number(id.split(':').pop());
          const msg = await client.fetchOne(String(uid), { envelope: true, bodyStructure: true }, { uid: true });
          const plain = findPart(msg.bodyStructure, 'text/plain');
          const html = plain ? null : findPart(msg.bodyStructure, 'text/html');
          const part = plain ?? html;
          let raw = '';
          if (part) {
            // For a single-part message the body is part "1".
            const { content } = await client.download(String(uid), part.part ?? '1', { uid: true });
            raw = await streamToString(content);
            if (!plain) raw = htmlToText(raw);
          }
          return {
            externalId: id,
            messageId: msg.envelope?.messageId ?? null,
            from: msg.envelope?.from?.[0]?.address?.toLowerCase() ?? null,
            subject: msg.envelope?.subject ?? '',
            body: replyText(raw),
          };
        };

        return await fn({ list, get });
      } finally {
        lock.release();
        await client.logout().catch(() => {});
      }
    },
  };
}
