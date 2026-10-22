import { useState } from 'react';
import { formatDateTime } from '../lib/format.js';
import StatusBadge from './StatusBadge.jsx';
import { Icon } from './ui.jsx';

function ScoreBar({ score }) {
  const value = Math.round(score ?? 0);
  const color = value >= 80 ? 'bg-brand-500' : value >= 60 ? 'bg-amber-400' : 'bg-slate-400';
  return (
    <div className="flex items-center gap-2" title={`AI relevance ${value}/100`}>
      <span className="text-[11px] font-medium text-slate-400">Fit</span>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="tabular w-6 text-right text-xs font-medium text-slate-600">{score == null ? '—' : value}</span>
    </div>
  );
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const initials = (name) =>
  name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

const KIND_LABELS = {
  RFQ: 'Request for quotation',
  COUNTER: 'Counter-offer',
  ACCEPTANCE: 'Acceptance',
  REGRET: 'Regret note',
  REPLY: 'Supplier reply',
};

const DELIVERY = {
  PENDING: ['Sending…', 'text-brand-600'],
  SENT: ['Sent', 'text-emerald-600'],
  FAILED: ['Failed', 'text-red-600'],
  RECEIVED: ['Received', 'text-slate-500'],
};

function Message({ m }) {
  const outbound = m.direction === 'outbound';
  const [expanded, setExpanded] = useState(false);
  const [label, cls] = DELIVERY[m.delivery_status] ?? [m.delivery_status, 'text-slate-500'];
  const long = m.body.length > 600;

  return (
    <li className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`w-full max-w-[85%] rounded-2xl border px-4 py-3 ${
          outbound ? 'rounded-tr-sm border-brand-100 bg-brand-50/60' : 'rounded-tl-sm border-slate-200 bg-white'
        }`}
      >
        <div className="flex items-center justify-between gap-3 text-[11px]">
          <span className={`font-semibold tracking-wide uppercase ${outbound ? 'text-brand-700' : 'text-slate-600'}`}>
            {outbound ? 'You' : 'Supplier'} · {KIND_LABELS[m.kind] ?? m.kind}
          </span>
          <span className="flex items-center gap-2 text-slate-400">
            <span className={`font-medium ${cls}`}>
              {label}
              {m.simulated && m.delivery_status === 'SENT' ? ' (simulated)' : ''}
              {m.attempts > 1 ? ` · ${m.attempts} attempts` : ''}
            </span>
            <span className="tabular">{formatDateTime(m.sent_at ?? m.created_at)}</span>
          </span>
        </div>
        {m.subject && <p className="mt-2 text-sm font-medium text-slate-800">{m.subject}</p>}
        <pre
          className={`mt-1.5 font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-slate-600 ${
            long && !expanded ? 'max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]' : ''
          }`}
        >
          {m.body}
        </pre>
        {long && (
          <button type="button" className="mt-1 text-xs font-medium text-brand-700 hover:underline" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show less' : 'Show full message'}
          </button>
        )}
        {m.error && m.delivery_status !== 'SENT' && <p className="mt-2 text-xs font-medium text-red-600">{m.error}</p>}
      </div>
    </li>
  );
}

/**
 * Supplier list. With `selectable`, contactable suppliers get a checkbox bound to `selected` (a Set of ids).
 * Prices are shown in the quotation comparison, not repeated here.
 */
export default function SupplierTable({ suppliers, selectable = false, selected, onToggle }) {
  const [open, setOpen] = useState(() => new Set());
  const toggleOpen = (id) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <ul className="divide-y divide-slate-100">
      {suppliers.map((s) => {
        const canSelect = selectable && Boolean(s.email) && s.can_email !== false;
        const isSelected = canSelect && selected.has(s.id);
        const isOpen = open.has(s.id);
        return (
          <li key={s.id} className={`px-5 py-4 transition-colors ${isSelected ? 'bg-brand-50/40' : ''}`}>
            <div className="flex gap-4">
              {selectable && (
                <input
                  type="checkbox"
                  className="mt-2.5 size-4 shrink-0 rounded accent-brand-600 disabled:opacity-40"
                  checked={isSelected}
                  disabled={!canSelect}
                  onChange={() => onToggle(s.id)}
                  aria-label={`Send proposal to ${s.name}`}
                />
              )}
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-xs font-semibold text-slate-600">
                {initials(s.name) || <Icon name="building" />}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <h3 className="font-semibold text-slate-900">{s.name}</h3>
                      {s.rfq_ref && (
                        <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500">{s.rfq_ref}</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-slate-500">
                      {[s.location, s.description].filter(Boolean).join(' · ') || 'No description'}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <StatusBadge status={s.status} kind="thread" />
                    <ScoreBar score={s.relevance_score} />
                  </div>
                </div>

                {s.ai_reasoning && s.status === 'PENDING' && (
                  <p className="mt-3 flex gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600 ring-1 ring-slate-100 ring-inset">
                    <Icon name="sparkles" className="mt-px size-3.5 shrink-0 text-brand-500" />
                    <span>
                      <span className="font-semibold text-slate-700">Why it fits: </span>
                      {s.ai_reasoning}
                    </span>
                  </p>
                )}
                {s.final_reason && <p className="mt-2 text-xs text-slate-500">{s.final_reason}</p>}
                {s.last_error && s.status === 'SEND_FAILED' && <p className="mt-2 text-xs font-medium text-red-600">{s.last_error}</p>}

                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
                  {s.email ? (
                    <span className="flex items-center gap-1.5">
                      <Icon name="mail" className="size-3.5 text-slate-400" />
                      <a href={`mailto:${s.email}`} className="text-slate-700 hover:text-brand-700 hover:underline">
                        {s.email}
                      </a>
                      {s.can_email === false && (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-800 ring-1 ring-amber-200 ring-inset">
                          Not in email allowlist
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="font-medium text-amber-700">No email found, so this supplier can't be contacted</span>
                  )}
                  {s.website && (
                    <a href={s.website} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-slate-800 hover:underline">
                      {hostOf(s.website)} ↗
                    </a>
                  )}
                  {s.phone && <span className="text-slate-500">{s.phone}</span>}
                  {s.messages?.length > 0 && (
                    <button
                      type="button"
                      onClick={() => toggleOpen(s.id)}
                      className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-slate-700 hover:bg-slate-100"
                    >
                      {isOpen ? 'Hide conversation' : `Conversation (${s.messages.length})`}
                      <Icon name="chevronDown" className={`size-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                    </button>
                  )}
                </div>

                {isOpen && (
                  <ol className="mt-4 space-y-3 rounded-xl bg-slate-50/80 p-4 ring-1 ring-slate-100 ring-inset">
                    {s.messages.map((m) => (
                      <Message key={m.id} m={m} />
                    ))}
                  </ol>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
