import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDate, formatMoney } from '../lib/format.js';
import Conversation from './Conversation.jsx';
import StatusBadge from './StatusBadge.jsx';
import { Icon, Spinner } from './ui.jsx';

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const initials = (name = '') =>
  name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || 'S';

const COLLECTING = ['AWAITING_REPLIES', 'NEGOTIATING'];
const WAITING = ['CONTACTED', 'COUNTERED'];

function Section({ title, action, children }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Tile({ label, value }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2.5 ring-1 ring-slate-100 ring-inset">
      <p className="text-[11px] font-medium text-slate-500">{label}</p>
      <p className="tabular mt-0.5 text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}

/** Plain-language status of this negotiation, with a tone for the hint box. */
function negotiationHint(request, supplier) {
  const money = (v) => formatMoney(v, request.currency);
  const price = supplier.current_offer_price;
  const lastCounter = [...(supplier.messages ?? [])].reverse().find((m) => m.kind === 'COUNTER');
  switch (supplier.status) {
    case 'PENDING':
      return ['info', 'Not contacted yet. Select this supplier and send proposals to invite them.'];
    case 'QUEUED':
      return ['info', 'Sending the request for quotation…'];
    case 'CONTACTED':
      return ['info', price == null ? 'Proposal sent. Waiting for their quote.' : 'Waiting for their reply.'];
    case 'COUNTERED':
      return ['info', `Counter-offer sent${lastCounter?.parsed_json?.counter_price ? ` at ${money(lastCounter.parsed_json.counter_price)}` : ''}. Waiting for their reply. The agent counters automatically within your limits.`];
    case 'FINAL_OFFER':
      return price <= request.target_price
        ? ['success', 'Offer meets your target price. You can approve it once the recommendation is ready.']
        : ['success', 'Negotiation finished within your maximum. This offer can be approved.'];
    case 'WALKED_AWAY':
      return ['warn', 'Final price is above your maximum, so this offer is not eligible.'];
    case 'NEEDS_REVIEW':
      return ['warn', 'A reply could not be processed. Use the recovery tools below.'];
    case 'NO_RESPONSE':
      return ['neutral', 'Closed without a quote.'];
    case 'DECLINED':
      return ['neutral', 'The supplier declined to quote.'];
    case 'SEND_FAILED':
      return ['warn', supplier.last_error || 'The proposal could not be delivered.'];
    case 'WON':
      return ['success', 'Approved. The acceptance email was sent to this supplier.'];
    case 'LOST':
      return ['neutral', 'Another supplier was chosen; a regret note was sent.'];
    default:
      return ['neutral', supplier.final_reason ?? ''];
  }
}

const HINT_TONES = {
  info: 'border-brand-100 bg-brand-50/70 text-brand-900 [&_svg]:text-brand-600',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900 [&_svg]:text-emerald-600',
  warn: 'border-amber-200 bg-amber-50 text-amber-900 [&_svg]:text-amber-600',
  neutral: 'border-slate-200 bg-slate-50 text-slate-700 [&_svg]:text-slate-500',
};

/** Recovery tools while quotes are coming in: re-read a reply, type in a quote, or close a silent supplier. */
function RecoveryTools({ request, supplier }) {
  const queryClient = useQueryClient();
  const [showQuote, setShowQuote] = useState(false);
  const [quote, setQuote] = useState({ unit_price: '', delivery_days: '', payment_terms: '' });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['request', request.id] });

  const recheck = useMutation({ mutationFn: () => api.recheckSupplier(request.id, supplier.id), onSuccess: refresh });
  const close = useMutation({ mutationFn: () => api.closeSupplier(request.id, supplier.id), onSuccess: refresh });
  const enter = useMutation({
    mutationFn: () => api.enterQuote(request.id, supplier.id, quote),
    onSuccess: () => {
      setShowQuote(false);
      setQuote({ unit_price: '', delivery_days: '', payment_terms: '' });
      refresh();
    },
  });

  // A lower price arrived after this offer went final; applying it re-ranks the recommendation (no email).
  if (supplier.lower_quote && [...COLLECTING, 'DEAL_RECOMMENDED'].includes(request.status)) {
    return (
      <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
          <Icon name="info" className="size-4 text-amber-600" /> Newer, lower quote not applied
        </h3>
        <p className="mt-1 text-xs text-amber-900">
          {supplier.name} offered <span className="tabular font-semibold">{formatMoney(supplier.lower_quote.unit_price, request.currency)}</span> / {request.unit} on{' '}
          {formatDate(supplier.lower_quote.received_at)}, after their offer was marked final. Apply it so the recommendation and approval use this price. No email is sent.
        </p>
        <button className="btn-primary mt-3 px-3 py-1.5" disabled={recheck.isPending} onClick={() => recheck.mutate()}>
          {recheck.isPending ? <Spinner /> : <Icon name="refresh" />} Apply latest quote
        </button>
        {recheck.error && <p className="field-error">{recheck.error.message}</p>}
      </section>
    );
  }

  if (!COLLECTING.includes(request.status)) return null;
  const needsReview = supplier.status === 'NEEDS_REVIEW';
  const waiting = WAITING.includes(supplier.status);
  if (!needsReview && !waiting) return null;

  const error = recheck.error ?? close.error ?? enter.error;
  const busy = recheck.isPending || close.isPending || enter.isPending;
  const set = (key) => (e) => setQuote((q) => ({ ...q, [key]: e.target.value }));
  const tool = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 ring-inset transition-colors disabled:opacity-50';

  return (
    <section className="rounded-xl border border-brand-200 bg-white p-4">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
        <Icon name="shield" className="size-4 text-brand-600" /> Recovery tools
      </h3>
      <p className="mt-1 text-xs text-slate-500">Use these if a reply was not processed correctly, or the supplier will never reply.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={`${tool} text-brand-700 ring-brand-200 hover:bg-brand-50`} disabled={busy || !needsReview} onClick={() => recheck.mutate()} title={needsReview ? '' : 'Only for suppliers that need review'}>
          {recheck.isPending ? <Spinner className="size-3.5" /> : <Icon name="refresh" className="size-3.5" />} Re-check replies
        </button>
        <button className={`${tool} text-slate-700 ring-slate-300 hover:bg-slate-50`} disabled={busy} onClick={() => setShowQuote((v) => !v)} aria-expanded={showQuote}>
          <Icon name="filePlus" className="size-3.5" /> Enter quote manually
        </button>
        <button
          className={`${tool} text-red-600 ring-red-200 hover:bg-red-50`}
          disabled={busy || !waiting}
          onClick={() => window.confirm(`Mark ${supplier.name} as not responding? Their last offer (if any) is kept.`) && close.mutate()}
        >
          {close.isPending ? <Spinner className="size-3.5" /> : <Icon name="x" className="size-3.5" />} Mark as no response
        </button>
      </div>

      {showQuote && (
        <form
          className="mt-3 grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200 ring-inset"
          onSubmit={(e) => {
            e.preventDefault();
            enter.mutate();
          }}
        >
          <div>
            <label className="field-label text-xs" htmlFor="mq-price">
              Price / {request.unit} ({request.currency})
            </label>
            <input id="mq-price" type="number" min="0" step="any" required className="field-input tabular" value={quote.unit_price} onChange={set('unit_price')} />
          </div>
          <div>
            <label className="field-label text-xs" htmlFor="mq-days">
              Delivery (days)
            </label>
            <input id="mq-days" type="number" min="1" step="1" className="field-input tabular" value={quote.delivery_days} onChange={set('delivery_days')} />
          </div>
          <div>
            <label className="field-label text-xs" htmlFor="mq-terms">
              Payment terms
            </label>
            <input id="mq-terms" className="field-input" placeholder="e.g. Net 30" value={quote.payment_terms} onChange={set('payment_terms')} />
          </div>
          <div className="col-span-3 flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">Treated like the supplier&apos;s reply: the agent counters or accepts within your limits.</p>
            <button className="btn-primary px-3 py-1.5" disabled={busy || !quote.unit_price}>
              {enter.isPending ? <Spinner /> : <Icon name="check" />} Save quote
            </button>
          </div>
        </form>
      )}
      {error && <p className="field-error">{error.fields ? Object.values(error.fields)[0] : error.message}</p>}
    </section>
  );
}

/**
 * Slide-over panel with everything about one supplier on a request: latest quote, negotiation
 * status, actions, recovery tools and the email timeline. Closes on ✕, Esc or a click outside.
 */
export default function SupplierPanel({ request, supplier, onClose }) {
  const queryClient = useQueryClient();
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (!supplier) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [supplier, onClose]);

  const approve = useMutation({
    mutationFn: (name) => api.approveDeal(request.id, supplier.id, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['request', request.id] }),
  });

  if (!supplier) return null;

  const { currency, unit } = request;
  const money = (v) => formatMoney(v, currency);
  const latest = supplier.offers?.at(-1);
  const price = supplier.current_offer_price;
  const saved = price != null && supplier.opening_price > price ? ((supplier.opening_price - price) / supplier.opening_price) * 100 : 0;
  const eligible = request.status === 'DEAL_RECOMMENDED' && (request.recommendation?.ranked ?? []).some((o) => o.requestSupplierId === supplier.id);
  const recommended = eligible && supplier.id === request.recommended_request_supplier_id;
  const [tone, hint] = negotiationHint(request, supplier);

  const onApprove = () => {
    const name = window.prompt(`Approve ${supplier.name} at ${money(price)} per ${unit}?\nAn acceptance email will be sent.\n\nApproved by:`, request.buyer_name ?? '');
    if (name && name.trim().length >= 2) approve.mutate(name.trim());
  };

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`${supplier.name} details`}>
      <div className="animate-fade-in absolute inset-0 bg-slate-900/30 backdrop-blur-[1px]" onClick={onClose} />

      <aside className="animate-slide-in-right absolute inset-y-0 right-0 flex w-[40rem] max-w-full flex-col bg-slate-50 shadow-elevated">
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-slate-200 bg-white px-6 py-5">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-emerald-100 text-sm font-bold text-emerald-800">{initials(supplier.name)}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-slate-900">{supplier.name}</h2>
              <StatusBadge status={supplier.status} kind="thread" />
              {recommended && <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-semibold text-brand-700">Recommended</span>}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
              {supplier.rfq_ref && <span className="font-mono">{supplier.rfq_ref}</span>}
              {supplier.email ? (
                <a href={`mailto:${supplier.email}`} className="flex items-center gap-1 hover:text-brand-700 hover:underline">
                  <Icon name="mail" className="size-3.5" /> {supplier.email}
                </a>
              ) : (
                <span className="font-medium text-amber-700">No email</span>
              )}
              {supplier.website && (
                <a href={supplier.website} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-slate-800 hover:underline">
                  <Icon name="globe" className="size-3.5" /> {hostOf(supplier.website)}
                </a>
              )}
              {supplier.location && <span>{supplier.location}</span>}
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost -mt-1 -mr-2 px-2" aria-label="Close panel" title="Close (Esc)">
            <Icon name="x" className="size-5" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* Latest quote */}
          {latest ? (
            <section className="rounded-xl border-2 border-emerald-300 bg-white p-4 shadow-card">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-900">
                  Latest quote <span className="font-normal text-slate-400">({latest.round === 0 ? 'opening quote' : `after counter ${latest.round}`})</span>
                </p>
                {supplier.offers.length > 1 && (
                  <button type="button" className="text-xs font-semibold text-brand-700 hover:underline" onClick={() => setShowHistory((v) => !v)}>
                    {showHistory ? 'Hide history' : `View all quotes (${supplier.offers.length})`}
                  </button>
                )}
              </div>
              <div className="mt-3 grid grid-cols-[1.2fr_1fr_1fr] gap-4">
                <div className="border-r border-slate-100 pr-4">
                  <p className="tabular text-2xl font-semibold tracking-tight text-slate-900">
                    {money(price)} <span className="text-sm font-medium text-slate-500">/ {unit}</span>
                  </p>
                  <p className="tabular mt-1 text-xs text-slate-500">Total {money(price * request.quantity)}</p>
                  {saved > 0 && <p className="mt-1 text-xs font-semibold text-emerald-700">{saved.toFixed(1)}% below their opening {money(supplier.opening_price)}</p>}
                </div>
                <div className="space-y-2 text-xs">
                  <p className="text-slate-500">
                    Delivery time
                    <span className="block text-sm font-semibold text-slate-900">{latest.delivery_days ? `${latest.delivery_days} days` : '—'}</span>
                  </p>
                  <p className="text-slate-500">
                    Quote validity
                    <span className="block text-sm font-semibold text-slate-900">{latest.valid_until ? `until ${formatDate(latest.valid_until)}` : '—'}</span>
                  </p>
                </div>
                <div className="text-xs text-slate-500">
                  Payment terms
                  <span className="block text-sm font-semibold text-slate-900">{latest.payment_terms ?? '—'}</span>
                </div>
              </div>
              {showHistory && (
                <ol className="mt-3 space-y-1.5 border-t border-slate-100 pt-3">
                  {supplier.offers.map((o) => (
                    <li key={o.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-xs">
                      <span className="text-slate-500">{o.round === 0 ? 'Opening quote' : `After counter ${o.round}`}</span>
                      <span className="tabular font-semibold text-slate-900">
                        {money(o.unit_price)}
                        {o.delivery_days ? <span className="ml-2 font-normal text-slate-500">{o.delivery_days} days</span> : null}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ) : (
            <section className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-5 text-center">
              <p className="text-sm font-medium text-slate-700">No quote yet</p>
              <p className="mt-0.5 text-xs text-slate-500">The latest quote appears here as soon as the supplier replies with a price.</p>
            </section>
          )}

          {/* Negotiation details */}
          <Section title="Negotiation details">
            <div className="grid grid-cols-3 gap-2">
              <Tile label="Counter-offers used" value={`${supplier.rounds_used} / ${request.max_rounds}`} />
              <Tile label="Your target" value={`${money(request.target_price)} / ${unit}`} />
              <Tile label="Your maximum" value={request.max_price != null ? `${money(request.max_price)} / ${unit}` : '—'} />
            </div>
            {hint && (
              <div className={`mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${HINT_TONES[tone]}`}>
                <Icon name="info" className="mt-px size-4 shrink-0" />
                <span>{hint}</span>
              </div>
            )}
          </Section>

          {/* Actions */}
          {eligible && (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
              <button className="btn-primary bg-emerald-600 hover:bg-emerald-700" onClick={onApprove} disabled={approve.isPending}>
                {approve.isPending ? <Spinner /> : <Icon name="check" />} Approve this offer
              </button>
              <p className="text-xs text-emerald-900">Sends the acceptance email (subject to a formal purchase order) and closes the request.</p>
            </div>
          )}
          {approve.isError && <p className="field-error">{approve.error.message}</p>}

          <RecoveryTools request={request} supplier={supplier} />

          {/* Why this supplier */}
          {supplier.ai_reasoning && (
            <Section title="Why this supplier">
              <p className="flex gap-2 rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-slate-200 ring-inset">
                <Icon name="sparkles" className="mt-0.5 size-4 shrink-0 text-brand-500" />
                <span>
                  {supplier.ai_reasoning}
                  {supplier.relevance_score != null && <span className="ml-1 font-medium text-slate-800">(fit {Math.round(supplier.relevance_score)}/100)</span>}
                </span>
              </p>
            </Section>
          )}

          {/* Conversation */}
          <Section title={<>Conversation <span className="font-normal text-slate-400">({supplier.messages?.length ?? 0})</span></>}>
            <Conversation key={supplier.id} messages={supplier.messages} supplierName={supplier.name} />
          </Section>
        </div>
      </aside>
    </div>
  );
}
