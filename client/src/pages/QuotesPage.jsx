import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { EmptyState, ErrorState, Icon, PageHeader, Skeleton } from '../components/ui.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';

/** Every price a supplier has quoted, newest first, compared with the request's target. */
export default function QuotesPage() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['quotes'], queryFn: api.listQuotes, refetchInterval: 15_000 });
  const [requestFilter, setRequestFilter] = useState('all');
  const [search, setSearch] = useState('');

  const requests = useMemo(() => [...new Map((data ?? []).map((q) => [q.request_id, q.commodity])).entries()], [data]);
  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data ?? [])
      .filter((q) => requestFilter === 'all' || q.request_id === requestFilter)
      .filter((q) => !term || `${q.supplier} ${q.commodity}`.toLowerCase().includes(term));
  }, [data, requestFilter, search]);

  return (
    <div className="space-y-6">
      <PageHeader title="Quotes" description="Every quotation received from suppliers, including revised prices during negotiation." />

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200/80 px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900">Received quotes</h2>
            <p className="mt-0.5 text-xs text-slate-500">{data ? `${rows.length} of ${data.length} shown` : 'Loading…'}</p>
          </div>
          <div className="flex items-center gap-2">
            <select className="field-input w-56" aria-label="Filter by request" value={requestFilter} onChange={(e) => setRequestFilter(e.target.value)}>
              <option value="all">All requests</option>
              {requests.map(([id, commodity]) => (
                <option key={id} value={id}>
                  {commodity}
                </option>
              ))}
            </select>
            <div className="relative w-60">
              <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
              <input type="search" className="field-input pl-9" placeholder="Search supplier" aria-label="Search quotes" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
        </div>

        {isLoading && (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}
        {error && <ErrorState title="Could not load quotes" message={error.message} onRetry={() => refetch()} />}
        {data && !rows.length && <EmptyState icon="receipt" title="No quotes yet" description="Quotes appear here as soon as suppliers reply with a price." />}

        {rows.length > 0 && (
          <table className="w-full table-fixed">
            <colgroup>
              <col />
              <col className="w-48" />
              <col className="w-40" />
              <col className="w-24" />
              <col className="w-56" />
              <col className="w-28" />
              <col className="w-36" />
              <col className="w-40" />
            </colgroup>
            <thead className="border-b border-slate-200/80 bg-slate-50/70">
              <tr>
                <th className="th">Supplier</th>
                <th className="th">Request</th>
                <th className="th text-right">Price / unit</th>
                <th className="th text-right">Delivery</th>
                <th className="th">Payment terms</th>
                <th className="th">Round</th>
                <th className="th">Status</th>
                <th className="th">Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((q) => {
                const vs = ((q.unit_price - q.target_price) / q.target_price) * 100;
                return (
                  <tr key={q.id} onClick={() => navigate(`/requests/${q.request_id}`)} className="cursor-pointer hover:bg-slate-50/80">
                    <td className="td truncate font-medium text-slate-900">{q.supplier}</td>
                    <td className="td">
                      <Link to={`/requests/${q.request_id}`} onClick={(e) => e.stopPropagation()} className="block truncate text-slate-700 hover:text-brand-700 hover:underline">
                        {q.commodity}
                      </Link>
                    </td>
                    <td className="td text-right">
                      <p className="tabular font-semibold text-slate-900">
                        {formatMoney(q.unit_price, q.currency)} <span className="text-xs font-normal text-slate-400">/ {q.unit}</span>
                      </p>
                      <p className={`tabular text-xs ${vs <= 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                        {vs > 0 ? '+' : vs < 0 ? '−' : ''}
                        {Math.abs(vs).toFixed(1)}% vs target
                      </p>
                    </td>
                    <td className="td tabular text-right text-slate-700">{q.delivery_days ? `${q.delivery_days} days` : '—'}</td>
                    <td className="td truncate text-slate-600" title={q.payment_terms ?? ''}>
                      {q.payment_terms ?? '—'}
                    </td>
                    <td className="td text-slate-600">
                      {q.source === 'manual' ? (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200 ring-inset" title="Entered manually by the buyer">
                          Manual
                        </span>
                      ) : q.round === 0 ? (
                        'Opening'
                      ) : (
                        `Counter ${q.round}`
                      )}
                    </td>
                    <td className="td">
                      <StatusBadge status={q.thread_status} kind="thread" />
                    </td>
                    <td className="td tabular text-slate-500">{formatDateTime(q.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
