import { config } from '../config.js';
import { query } from '../db/pool.js';
import { ingestInboundEmail } from '../services/inbound.js';
import { createImapClient, ImapAuthError } from '../services/inbound/imap.js';

const PROVIDER = 'imap';
// After a failed login, wait before trying again so the account is not locked by repeated attempts.
const AUTH_FAILURE_PAUSE_MS = 5 * 60 * 1000;
let client = null;

/** Test hook: inject an inbox client (e.g. one built with a fake ImapFlow). */
export function setInboxClient(next) {
  client = next;
}

const getClient = () => (client ??= createImapClient(config.inbound.imap));

/**
 * Reads new mail from our Reply-To inbox (IMAP) and hands each email to ingestInboundEmail(),
 * the same entry point the webhook uses. Every message is handled once (inbound_cursor);
 * if we crash before recording it, the next poll re-ingests it and the Message-ID dedupe drops it.
 */
export async function pollInbox() {
  if (config.inbound.provider !== PROVIDER) return { checked: 0, ingested: 0 };

  return getClient().session(async ({ list, get }) => {
    const summaries = await list();
    let ingested = 0;

    for (const summary of [...summaries].reverse()) {
      const seen = await query('SELECT 1 FROM inbound_cursor WHERE provider = $1 AND external_id = $2', [PROVIDER, summary.id]);
      if (seen.rowCount) continue;

      const email = await get(summary.id);
      const result = await ingestInboundEmail({ from: email.from, subject: email.subject, body: email.body, messageId: email.messageId });
      await query(
        'INSERT INTO inbound_cursor (provider, external_id, matched) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [PROVIDER, summary.id, result.matched],
      );
      if (!result.matched) console.warn(`[inbox] mail from ${email.from} ("${email.subject}") matches no RFQ; skipped`);
      if (result.messageId) ingested++;
    }
    return { checked: summaries.length, ingested };
  });
}

/** Polls every INBOUND_POLL_SECONDS. Never overlaps itself and pauses after a failed login. */
export function startInboxPoller() {
  if (config.inbound.provider !== PROVIDER) return () => {};

  let running = false;
  let pausedUntil = 0;
  const tick = async () => {
    if (running || Date.now() < pausedUntil) return;
    running = true;
    try {
      const { ingested } = await pollInbox();
      if (ingested) console.log(`[inbox] ${ingested} new supplier repl${ingested === 1 ? 'y' : 'ies'}`);
    } catch (err) {
      if (err instanceof ImapAuthError) pausedUntil = Date.now() + AUTH_FAILURE_PAUSE_MS;
      console.error('[inbox]', err.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, config.inbound.pollSeconds * 1000);
  tick();
  const { user, host, mailbox } = config.inbound.imap;
  console.log(`[inbox] polling ${user} ${mailbox} on ${host} every ${config.inbound.pollSeconds}s`);
  return () => clearInterval(timer);
}
