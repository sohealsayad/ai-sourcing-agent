import { useState } from 'react';
import { formatDateTime } from '../lib/format.js';
import { Icon } from './ui.jsx';

const KIND_LABELS = {
  RFQ: 'Request for quotation',
  COUNTER: 'Counter-offer',
  ACCEPTANCE: 'Acceptance',
  REGRET: 'Regret note',
  REPLY: 'Supplier reply',
};

const DELIVERY = {
  PENDING: ['Sending…', 'bg-brand-50 text-brand-700'],
  SENT: ['Sent', 'bg-emerald-50 text-emerald-700'],
  FAILED: ['Failed', 'bg-red-50 text-red-700'],
  RECEIVED: ['Received', 'bg-sky-50 text-sky-700'],
};

const initials = (name = '') =>
  name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || 'S';

/** One-line preview: the subject for our emails, otherwise the first meaningful line of the body. */
function preview(m) {
  if (m.direction === 'outbound' && m.subject) return m.subject;
  const line = m.body
    .split('\n')
    .map((l) => l.trim())
    // Skip greetings and heading lines such as "Quote entered manually by the buyer:".
    .find((l) => l && !/^(dear|hi|hello)\b/i.test(l) && !l.endsWith(':'));
  return line ?? m.body.trim();
}

/**
 * Email thread as a vertical timeline: our emails (brand) and supplier replies (green),
 * each collapsible; the latest message is highlighted and open by default.
 */
export default function Conversation({ messages, supplierName }) {
  const latestId = messages?.at(-1)?.id;
  const [open, setOpen] = useState(() => new Set(latestId ? [latestId] : []));
  const toggle = (id) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  if (!messages?.length) {
    return <p className="rounded-xl border border-dashed border-slate-200 px-4 py-3 text-sm text-slate-500">No emails yet. Proposals appear here once they are sent.</p>;
  }

  return (
    <ol className="relative space-y-3">
      <span className="absolute top-4 bottom-4 left-[15px] w-px bg-slate-200" aria-hidden="true" />
      {messages.map((m) => {
        const outbound = m.direction === 'outbound';
        // A quote the buyer typed in is stored like a reply, but it is the buyer's entry, not the supplier's email.
        const manual = m.source === 'buyer_manual' || (!m.source && m.parsed_json?.manual === true);
        const byBuyer = outbound || manual;
        const latest = m.id === latestId;
        const isOpen = open.has(m.id);
        const [label, chip] = manual
          ? ['Not sent · recorded by you', 'bg-amber-50 text-amber-800']
          : (DELIVERY[m.delivery_status] ?? [m.delivery_status, 'bg-slate-100 text-slate-600']);
        const kindLabel = manual ? 'Manual quote' : (KIND_LABELS[m.kind] ?? m.kind);
        const kindColor = manual ? 'text-amber-700' : outbound ? 'text-brand-700' : 'text-emerald-700';
        return (
          <li key={m.id} className="relative flex gap-3">
            <span
              className={`relative z-10 grid size-8 shrink-0 place-items-center rounded-full text-[10px] font-bold ring-4 ring-white ${
                manual ? 'bg-amber-100 text-amber-800' : outbound ? 'bg-brand-600 text-white' : 'bg-emerald-100 text-emerald-800'
              }`}
              aria-hidden="true"
            >
              {byBuyer ? 'YOU' : initials(supplierName)}
            </span>

            <div
              className={`min-w-0 flex-1 rounded-xl border bg-white transition-shadow ${
                latest ? 'border-emerald-300 shadow-card ring-1 ring-emerald-100' : 'border-slate-200'
              }`}
            >
              <button
                type="button"
                onClick={() => toggle(m.id)}
                aria-expanded={isOpen}
                className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                    <span className="font-semibold text-slate-900">{byBuyer ? 'You' : 'Supplier'}</span>
                    <span className="text-slate-400">·</span>
                    <span className={`font-medium ${kindColor}`}>{kindLabel}</span>
                    {outbound && m.kind === 'COUNTER' && (
                      <span className="rounded-full bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-600">Proposed · awaiting supplier</span>
                    )}
                    {latest && <span className="rounded-full bg-emerald-50 px-1.5 py-px text-[10px] font-semibold text-emerald-700 uppercase">Latest</span>}
                  </span>
                  <span className="mt-0.5 block truncate text-[13px] text-slate-600">{preview(m)}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="tabular text-[11px] text-slate-400">{formatDateTime(m.sent_at ?? m.created_at)}</span>
                  <span className="flex items-center gap-1">
                    <span className={`rounded-full px-1.5 py-px text-[10px] font-medium ${chip}`}>
                      {label}
                      {m.simulated && m.delivery_status === 'SENT' ? ' · simulated' : ''}
                    </span>
                    <Icon name="chevronDown" className={`size-4 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  </span>
                </span>
              </button>

              {isOpen && (
                <div className="border-t border-slate-100 px-3.5 py-3">
                  {m.subject && <p className="mb-1.5 text-[13px] font-medium text-slate-800">{m.subject}</p>}
                  <pre className="max-h-80 overflow-auto font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-slate-600">{m.body}</pre>
                  {m.attempts > 1 && <p className="mt-2 text-[11px] text-slate-400">{m.attempts} delivery attempts</p>}
                  {m.error && m.delivery_status !== 'SENT' && <p className="mt-2 text-xs font-medium text-red-600">{m.error}</p>}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
