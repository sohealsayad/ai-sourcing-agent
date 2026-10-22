import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { Icon, Spinner } from './ui.jsx';

function Figure({ label, value, sub, tone }) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className={`tabular mt-1 text-xl font-semibold tracking-tight ${tone ?? 'text-slate-900'}`}>{value}</dd>
      {sub && <dd className="mt-0.5 text-xs text-slate-500">{sub}</dd>}
    </div>
  );
}

/** Savings of a unit price against the target, for the whole quantity. */
function vsTarget(price, request) {
  const amount = (request.target_price - price) * request.quantity;
  const pct = ((request.target_price - price) / request.target_price) * 100;
  return { amount, pct, saved: amount >= 0 };
}

/** Step 7: the human decision. Nothing binding is sent until someone approves here. */
export default function ApprovalPanel({ request }) {
  const queryClient = useQueryClient();
  const ranked = request.recommendation?.ranked ?? [];
  const [choice, setChoice] = useState(request.recommended_request_supplier_id);
  const [name, setName] = useState(request.buyer_name ?? '');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['request', request.id] });

  const approve = useMutation({ mutationFn: () => api.approveDeal(request.id, choice, name.trim()), onSettled: refresh });
  const reject = useMutation({ mutationFn: () => api.rejectDeals(request.id, name.trim()), onSettled: refresh });
  const { currency, unit } = request;

  if (request.status === 'CLOSED') {
    const winner = request.suppliers.find((s) => s.id === request.approved_request_supplier_id);
    const price = winner?.current_offer_price;
    const acceptance = winner?.messages.find((m) => m.kind === 'ACCEPTANCE');
    const sent = acceptance?.delivery_status === 'SENT';
    const t = vsTarget(price, request);
    return (
      <section className="card overflow-hidden">
        <div className="flex items-center gap-3 border-b border-emerald-100 bg-gradient-to-r from-emerald-50 to-white px-6 py-4">
          <span className="grid size-9 place-items-center rounded-full bg-emerald-600 text-white">
            <Icon name="badgeCheck" className="size-5" />
          </span>
          <div>
            <p className="text-xs font-semibold tracking-wide text-emerald-700 uppercase">Deal approved</p>
            <h2 className="text-lg font-semibold text-slate-900">{winner?.name}</h2>
          </div>
        </div>
        <dl className="grid grid-cols-5 gap-6 px-6 py-5">
          <Figure label="Unit price" value={formatMoney(price, currency)} sub={`per ${unit}`} />
          <Figure label="Total" value={formatMoney(price * request.quantity, currency)} sub={`${request.quantity} ${unit}`} />
          <Figure
            label={t.saved ? 'Saved vs target' : 'Over target'}
            value={formatMoney(Math.abs(t.amount), currency)}
            sub={`${Math.abs(t.pct).toFixed(1)}% ${t.saved ? 'below' : 'above'} target`}
            tone={t.saved ? 'text-emerald-700' : 'text-amber-700'}
          />
          <Figure label="Approved by" value={request.approved_by} sub={formatDateTime(request.approved_at)} />
          <div>
            <dt className="text-xs font-medium text-slate-500">Acceptance email</dt>
            <dd className={`mt-1.5 inline-flex items-center gap-2 text-sm font-semibold ${sent ? 'text-emerald-700' : 'text-brand-700'}`}>
              {sent ? <Icon name="check" /> : <Spinner className="size-3.5" />}
              {sent ? 'Sent' : 'Sending…'}
            </dd>
            {acceptance?.simulated && <dd className="mt-0.5 text-xs text-slate-500">Simulated</dd>}
          </div>
        </dl>
        <p className="border-t border-slate-100 bg-slate-50/60 px-6 py-3 text-xs text-slate-500">
          The acceptance states that the order becomes binding once a formal purchase order is issued. Other suppliers who quoted received a polite
          regret note.
        </p>
      </section>
    );
  }

  if (request.status === 'NO_DEAL' || request.status === 'CANCELLED') {
    const noDeal = request.status === 'NO_DEAL';
    return (
      <section className="card flex items-start gap-4 px-6 py-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-500">
          <Icon name={noDeal ? 'alert' : 'x'} className="size-5" />
        </span>
        <div>
          <p className="font-semibold text-slate-900">{noDeal ? 'No deal reached' : 'All offers rejected'}</p>
          <p className="mt-1 text-sm text-slate-600">
            {noDeal ? request.error : 'The request was cancelled. Suppliers who quoted have been notified.'}
          </p>
        </div>
      </section>
    );
  }

  if (request.status !== 'DEAL_RECOMMENDED' || !ranked.length) return null;

  const best = ranked[0];
  const chosen = ranked.find((o) => o.requestSupplierId === choice) ?? best;
  const canSubmit = name.trim().length >= 2 && !approve.isPending && !reject.isPending;
  const error = approve.error ?? reject.error;
  const t = vsTarget(best.price, request);

  const confirmApprove = () => {
    const total = formatMoney(chosen.total, currency);
    if (window.confirm(`Approve ${chosen.name} at ${formatMoney(chosen.price, currency)} per ${unit} (total ${total})?\n\nAn acceptance email will be sent.`)) {
      approve.mutate();
    }
  };
  const confirmReject = () => {
    if (window.confirm('Reject all offers? Suppliers who quoted will be notified and the request will be cancelled.')) reject.mutate();
  };

  return (
    <section className="card overflow-hidden ring-1 ring-brand-200">
      <div className="flex items-start justify-between gap-6 border-b border-brand-100 bg-gradient-to-r from-brand-50 to-white px-6 py-5">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-brand-700 uppercase">
            <Icon name="sparkles" className="size-3.5" /> Your approval is needed
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">
            Recommended: {best.name} at {formatMoney(best.price, currency)} per {unit}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">{request.recommendation.reason}</p>
        </div>
        <span className="tabular shrink-0 rounded-lg bg-white px-3 py-2 text-center shadow-card ring-1 ring-slate-200">
          <span className="block text-[11px] font-medium text-slate-500">Score</span>
          <span className="block text-lg font-semibold text-slate-900">{best.score.toFixed(1)}</span>
        </span>
      </div>

      <div className="space-y-6 px-6 py-5">
        <dl className="grid grid-cols-4 gap-6">
          <Figure label="Total" value={formatMoney(best.total, currency)} sub={`${request.quantity} ${unit}`} />
          <Figure
            label={t.saved ? 'Saved vs target' : 'Over target'}
            value={formatMoney(Math.abs(t.amount), currency)}
            sub={`${Math.abs(t.pct).toFixed(1)}% ${t.saved ? 'below' : 'above'} target`}
            tone={t.saved ? 'text-emerald-700' : 'text-amber-700'}
          />
          <Figure label="Saved vs opening quote" value={`${best.savingsVsOpening.toFixed(1)}%`} sub={`from ${formatMoney(best.openingPrice, currency)}`} />
          <Figure label="Delivery" value={best.deliveryDays ? `${best.deliveryDays} days` : '—'} sub={best.paymentTerms} />
        </dl>

        {ranked.length > 1 && (
          <fieldset>
            <legend className="field-label">Approve which offer?</legend>
            <div className="grid grid-cols-2 gap-3">
              {ranked.map((o) => {
                const active = choice === o.requestSupplierId;
                return (
                  <label
                    key={o.requestSupplierId}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl px-4 py-3 ring-1 transition ring-inset ${
                      active ? 'bg-brand-50/60 ring-2 ring-brand-500' : 'ring-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <input type="radio" name="offer" className="accent-brand-600" checked={active} onChange={() => setChoice(o.requestSupplierId)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-medium text-slate-900">{o.name}</span>
                        {o === best && (
                          <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-medium text-brand-700">Recommended</span>
                        )}
                      </span>
                      <span className="tabular block text-xs text-slate-500">
                        {formatMoney(o.price, currency)} · {o.deliveryDays ?? '—'} days · score {o.score.toFixed(1)}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}

        <div className="flex items-end gap-3 border-t border-slate-100 pt-5">
          <div className="w-72">
            <label className="field-label" htmlFor="approver">
              Approved by
            </label>
            <input id="approver" className="field-input" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <p className="flex-1 pb-2 text-xs text-slate-500">
            Nothing has been agreed yet. Approving sends an acceptance email (subject to a formal purchase order) to the chosen supplier.
          </p>
          <button className="btn-danger" onClick={confirmReject} disabled={!canSubmit}>
            Reject all
          </button>
          <button className="btn-primary" onClick={confirmApprove} disabled={!canSubmit}>
            {approve.isPending ? <Spinner /> : <Icon name="check" />}
            {approve.isPending ? 'Approving…' : `Approve ${chosen.name}`}
          </button>
        </div>
        {error && <p className="text-sm font-medium text-red-600">{error.message}</p>}
      </div>
    </section>
  );
}
