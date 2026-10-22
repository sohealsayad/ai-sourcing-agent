// Helpers for turning a received email body into the text the reply parser should read.

export const htmlToText = (html) =>
  (html ?? '')
    .replace(/<(br|\/p|\/div)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();

/**
 * Drops the quoted earlier conversation ("On … wrote:" and "> " lines), so prices from our
 * own counter-offer, quoted below the reply, are never read as the supplier's price.
 */
export function stripQuotedReply(text) {
  const cut = text.search(/^On .+wrote:\s*$/m);
  const head = cut >= 0 ? text.slice(0, cut) : text;
  return head
    .split('\n')
    .filter((line) => !line.startsWith('>'))
    .join('\n')
    .trim();
}

/** Normalised reply text; falls back to the full text if everything was quoted. */
export function replyText(raw) {
  const text = (raw ?? '').replace(/\r\n?/g, '\n');
  return stripQuotedReply(text) || text.trim();
}
