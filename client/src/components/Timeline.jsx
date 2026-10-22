import { formatMoney, formatTime } from '../lib/format.js';

const KIND_LABELS = { RFQ: 'Proposal', COUNTER: 'Counter-offer', ACCEPTANCE: 'Acceptance', REGRET: 'Regret note' };

const STATUS_LABELS = {
  DISCOVERING: 'Finding suppliers',
  SUPPLIERS_FOUND: 'Suppliers found',
  SENDING_PROPOSALS: 'Sending proposals',
  AWAITING_REPLIES: 'Awaiting replies',
  NEGOTIATING: 'Negotiating',
  DEAL_RECOMMENDED: 'Needs approval',
  CLOSED: 'Deal approved',
  NO_DEAL: 'No deal',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed',
};

const DECISIONS = {
  ACCEPT: 'Offer accepted, pending your approval',
  FINAL: 'Negotiation finished',
  WALK_AWAY: 'Walked away',
  COUNTER: 'Countered',
};

function describe(event, currency) {
  const p = event.payload ?? {};
  const money = (v) => formatMoney(v, currency);
  switch (event.type) {
    case 'SUPPLIER_ADDED':
      return { title: `${p.supplier} added`, detail: `${p.email}${p.canEmail ? '' : ' · not in email allowlist'}` };
    case 'REPLY_RECEIVED':
      return { title: `Reply from ${p.supplier}`, detail: p.simulated ? 'Simulated supplier' : null };
    case 'QUOTE_RECEIVED':
      return {
        title: `${p.supplier} quoted ${money(p.price)}`,
        detail: [p.round === 0 ? 'Opening quote' : `After counter ${p.round}`, p.deliveryDays && `${p.deliveryDays} days delivery`]
          .filter(Boolean)
          .join(' · '),
      };
    case 'NEGOTIATION_DECISION':
      return {
        title: p.action === 'COUNTER' ? `Countered ${p.supplier} at ${money(p.counterPrice)}` : `${p.supplier}: ${DECISIONS[p.action]}`,
        detail: p.reason,
        tone: p.action === 'WALK_AWAY' ? 'warn' : undefined,
      };
    case 'SUPPLIER_DECLINED':
      return { title: `${p.supplier} declined to quote`, tone: 'warn' };
    case 'REPLY_TIMEOUT':
      return { title: `No reply from ${p.supplier}`, detail: p.outcome === 'NO_RESPONSE' ? 'Closed without a quote' : 'Their last offer stands', tone: 'warn' };
    case 'REPLY_NEEDS_REVIEW':
      return { title: `Couldn't read ${p.supplier}'s reply`, detail: 'Needs manual review', tone: 'warn' };
    case 'LATE_REPLY_IGNORED':
      return { title: `Late reply from ${p.supplier} ignored`, detail: `Thread was already ${p.threadStatus.toLowerCase().replace(/_/g, ' ')}` };
    case 'DEAL_RECOMMENDED':
      return { title: `Recommended ${p.supplier} at ${money(p.price)}`, detail: `Score ${p.score} · ${p.offers} eligible offer${p.offers === 1 ? '' : 's'}` };
    case 'DEAL_APPROVED':
      return { title: `Deal approved by ${p.approvedBy}`, detail: `${p.supplier} at ${money(p.price)} · total ${money(p.total)}` };
    case 'DEALS_REJECTED':
      return { title: `All offers rejected by ${p.rejectedBy}`, detail: p.reason, tone: 'warn' };
    case 'REQUEST_CREATED':
      return { title: 'Request created', detail: `${p.commodity} · ${p.location}` };
    case 'STATUS_CHANGED':
      return {
        title: `Moved to ${STATUS_LABELS[p.to] ?? p.to}`,
        detail: p.error ?? (p.sent !== undefined ? `${p.sent} sent, ${p.failed} failed` : null),
        tone: p.to === 'FAILED' ? 'error' : undefined,
      };
    case 'DISCOVERY_STARTED':
      return { title: 'AI supplier search started', detail: p.attempt > 1 ? `Attempt ${p.attempt}` : null };
    case 'SUPPLIERS_DISCOVERED':
      return {
        title: `${p.count} supplier${p.count === 1 ? '' : 's'} found`,
        detail:
          p.mode === 'mock'
            ? 'Mock AI mode (no API key)'
            : p.searchQueries?.length
              ? `Searched: ${p.searchQueries.map((q) => `“${q}”`).join(', ')}`
              : null,
      };
    case 'PROPOSALS_QUEUED':
      return {
        title: `${p.retry ? 'Retrying' : 'Sending'} proposals to ${p.count} supplier${p.count === 1 ? '' : 's'}`,
        detail: p.suppliers?.join(', '),
      };
    case 'MESSAGE_SENT':
      return {
        title: `${KIND_LABELS[p.kind] ?? 'Email'} sent to ${p.supplier}`,
        detail: p.simulated ? 'Simulated, not actually emailed' : p.to,
      };
    case 'MESSAGE_RETRYING':
      return { title: `Delivery to ${p.supplier} failed, retrying`, detail: p.error, tone: 'warn' };
    case 'PROPOSAL_FAILED':
    case 'MESSAGE_FAILED':
      return { title: `Could not deliver to ${p.supplier}`, detail: `${p.error} (after ${p.attempts} attempts)`, tone: 'error' };
    case 'PROPOSALS_PARTIALLY_SENT':
      return { title: 'Some proposals failed', detail: `${p.sent} delivered, ${p.failed} failed`, tone: 'warn' };
    case 'JOB_FAILED':
      return { title: `Attempt ${p.attempt} failed${p.final ? '' : ', retrying'}`, detail: p.error, tone: 'error' };
    default:
      return { title: event.type.charAt(0) + event.type.slice(1).toLowerCase().replace(/_/g, ' '), detail: p.detail };
  }
}

const DOT = {
  error: 'bg-red-500 ring-red-100',
  warn: 'bg-amber-400 ring-amber-100',
  default: 'bg-brand-500 ring-brand-100',
};

export default function Timeline({ events, currency }) {
  if (!events.length) return <p className="px-5 py-6 text-sm text-slate-500">No activity yet.</p>;

  // Newest first, so live progress is visible without scrolling.
  return (
    <ol className="max-h-[44rem] overflow-y-auto px-5 py-4">
      {[...events].reverse().map((e, i, all) => {
        const { title, detail, tone } = describe(e, currency);
        return (
          <li key={e.id} className="relative flex gap-3 pb-5 last:pb-0">
            {i < all.length - 1 && <span className="absolute top-4 bottom-0 left-[4.5px] w-px bg-slate-200" />}
            <span className={`relative mt-1.5 size-2.5 shrink-0 rounded-full ring-4 ${DOT[tone] ?? DOT.default}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <p className={`text-sm leading-snug font-medium ${tone === 'error' ? 'text-red-700' : 'text-slate-800'}`}>{title}</p>
                <time className="tabular shrink-0 text-[11px] text-slate-400">{formatTime(e.created_at)}</time>
              </div>
              {detail && <p className="mt-0.5 text-xs leading-relaxed break-words text-slate-500">{detail}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
