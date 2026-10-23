import { formatMoney } from '../lib/format.js';
import StatusBadge from './StatusBadge.jsx';
import { CardHeader } from './ui.jsx';

/** Every quote in one table: latest vs opening price, gap to target, total, terms, rounds and score. */
export default function QuoteComparison({ request, onView }) {
  const { currency, target_price: target, max_price: max, quantity, recommendation, unit } = request;
  const scores = new Map((recommendation?.ranked ?? []).map((o) => [o.requestSupplierId, o]));
  const approved = request.status === 'CLOSED';
  const highlightId = approved ? request.approved_request_supplier_id : request.recommended_request_supplier_id;

  const rows = request.suppliers
    .filter((s) => s.current_offer_price != null)
    .map((s) => ({ ...s, latest: s.offers?.at(-1), scored: scores.get(s.id) }))
    .sort((a, b) => (b.scored?.score ?? -1) - (a.scored?.score ?? -1) || a.current_offer_price - b.current_offer_price);

  if (!rows.length) return null;

  return (
    <section className="card overflow-hidden">
      <CardHeader
        icon="layers"
        title="Quotation comparison"
        description={`${rows.length} quote${rows.length === 1 ? '' : 's'} · prices per ${unit}`}
        actions={
          <div className="flex items-center gap-4 text-xs text-slate-500">
            <span>
              Target <span className="tabular font-semibold text-slate-900">{formatMoney(target, currency)}</span>
            </span>
            {max != null && (
              <span>
                Max <span className="tabular font-semibold text-slate-900">{formatMoney(max, currency)}</span>
              </span>
            )}
          </div>
        }
      />
      <table className="w-full">
        <thead className="border-b border-slate-200/80 bg-slate-50/70">
          <tr>
            <th className="th">Supplier</th>
            <th className="th text-right">Price / {unit}</th>
            <th className="th text-right">vs target</th>
            <th className="th text-right">Total</th>
            <th className="th">Terms</th>
            <th className="th text-right">Rounds</th>
            <th className="th text-right">Score</th>
            <th className="th">Status</th>
            <th className="th w-16" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((s) => {
            const price = s.current_offer_price;
            const saved = s.opening_price && s.opening_price > price ? ((s.opening_price - price) / s.opening_price) * 100 : 0;
            const vsTarget = ((price - target) / target) * 100;
            const highlight = s.id === highlightId;
            const vsTone = vsTarget <= 0 ? 'text-emerald-700' : max != null && price > max ? 'text-red-600' : 'text-amber-700';
            return (
              <tr key={s.id} className={highlight ? 'bg-brand-50/50' : 'hover:bg-slate-50/60'}>
                <td className="td">
                  <div className="flex items-center gap-2">
                    {highlight && <span className="h-8 w-1 rounded-full bg-brand-500" />}
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900">{s.name}</p>
                      {highlight && !approved && <p className="text-xs font-medium text-brand-700">Recommended</p>}
                    </div>
                  </div>
                </td>
                <td className="td text-right">
                  <p className="tabular font-semibold text-slate-900">{formatMoney(price, currency)}</p>
                  {saved > 0 && (
                    <p className="tabular text-xs text-slate-500">
                      <span className="line-through">{formatMoney(s.opening_price, currency)}</span>
                      <span className="ml-1.5 font-medium text-emerald-700">{saved.toFixed(1)}% off</span>
                    </p>
                  )}
                </td>
                <td className={`td tabular text-right font-medium ${vsTone}`}>
                  {vsTarget > 0 ? '+' : vsTarget < 0 ? '−' : ''}
                  {Math.abs(vsTarget).toFixed(1)}%
                </td>
                <td className="td tabular text-right text-slate-700">{formatMoney(price * quantity, currency)}</td>
                <td className="td">
                  <p className="text-slate-700">{s.latest?.delivery_days ? `${s.latest.delivery_days} days` : '—'}</p>
                  <p className="max-w-48 truncate text-xs text-slate-500" title={s.latest?.payment_terms ?? ''}>
                    {s.latest?.payment_terms ?? '—'}
                  </p>
                </td>
                <td className="td tabular text-right text-slate-700">{s.rounds_used}</td>
                <td className="td tabular text-right font-semibold text-slate-900">{s.scored ? s.scored.score.toFixed(1) : '—'}</td>
                <td className="td">
                  <StatusBadge status={s.status} kind="thread" />
                </td>
                <td className="td text-right">
                  <button type="button" onClick={() => onView(s.id)} className="btn-ghost px-2.5 py-1 text-xs text-brand-700">
                    View
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
