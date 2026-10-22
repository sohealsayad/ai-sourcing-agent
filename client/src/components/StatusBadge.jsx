// Tone → [pill classes, dot colour]
const TONES = {
  neutral: ['bg-slate-100 text-slate-700 ring-slate-200', 'bg-slate-400'],
  muted: ['bg-slate-50 text-slate-500 ring-slate-200', 'bg-slate-300'],
  info: ['bg-sky-50 text-sky-700 ring-sky-200', 'bg-sky-500'],
  brand: ['bg-brand-50 text-brand-700 ring-brand-200', 'bg-brand-500'],
  violet: ['bg-violet-50 text-violet-700 ring-violet-200', 'bg-violet-500'],
  warn: ['bg-amber-50 text-amber-800 ring-amber-200', 'bg-amber-500'],
  success: ['bg-emerald-50 text-emerald-700 ring-emerald-200', 'bg-emerald-500'],
  danger: ['bg-red-50 text-red-700 ring-red-200', 'bg-red-500'],
  solid: ['bg-emerald-600 text-white ring-emerald-600', 'bg-white'],
};

const REQUEST = {
  DRAFT: ['Draft', 'neutral'],
  DISCOVERING: ['Finding suppliers', 'info'],
  SUPPLIERS_FOUND: ['Suppliers found', 'brand'],
  SENDING_PROPOSALS: ['Sending proposals', 'brand'],
  AWAITING_REPLIES: ['Awaiting replies', 'warn'],
  NEGOTIATING: ['Negotiating', 'violet'],
  DEAL_RECOMMENDED: ['Needs approval', 'success'],
  CLOSED: ['Deal approved', 'solid'],
  NO_DEAL: ['No deal', 'neutral'],
  CANCELLED: ['Cancelled', 'muted'],
  FAILED: ['Failed', 'danger'],
};

const THREAD = {
  PENDING: ['Not contacted', 'muted'],
  QUEUED: ['Sending', 'brand'],
  CONTACTED: ['Awaiting quote', 'warn'],
  COUNTERED: ['Counter sent', 'violet'],
  SEND_FAILED: ['Send failed', 'danger'],
  DECLINED: ['Declined', 'neutral'],
  NO_RESPONSE: ['No response', 'neutral'],
  FINAL_OFFER: ['Final offer', 'brand'],
  WALKED_AWAY: ['Above max', 'warn'],
  NEEDS_REVIEW: ['Needs review', 'warn'],
  WON: ['Won', 'solid'],
  LOST: ['Not selected', 'muted'],
};

const LIVE = new Set(['DISCOVERING', 'SENDING_PROPOSALS', 'AWAITING_REPLIES', 'NEGOTIATING', 'QUEUED', 'CONTACTED', 'COUNTERED']);

export default function StatusBadge({ status, kind = 'request' }) {
  const [label, tone] = (kind === 'thread' ? THREAD : REQUEST)[status] ?? [status, 'neutral'];
  const [pill, dot] = TONES[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${pill}`}>
      <span className={`size-1.5 rounded-full ${dot} ${LIVE.has(status) ? 'animate-pulse' : ''}`} />
      {label}
    </span>
  );
}
