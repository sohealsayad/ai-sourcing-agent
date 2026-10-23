import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '../components/ui.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';

const TABS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'waiting', label: 'Waiting for quote', match: (n) => ['QUEUED', 'CONTACTED'].includes(n.status) },
  { key: 'countered', label: 'Countered', match: (n) => n.status === 'COUNTERED' },
  { key: 'final', label: 'Final offers', match: (n) => n.status === 'FINAL_OFFER' },
  { key: 'closed', label: 'Closed', match: (n) => ['DECLINED', 'NO_RESPONSE', 'WALKED_AWAY', 'NEEDS_REVIEW', 'SEND_FAILED'].includes(n.status) },
];

/** Live supplier conversations on open requests: where each negotiation stands. */
export default function NegotiationsPage() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['negotiations'], queryFn: api.listNegotiations, refetchInterval: 10_000 });
  const [tab, setTab] = useState('all');

  const counts = useMemo(() => Object.fromEntries(TABS.map((t) => [t.key, (data ?? []).filter(t.match).length])), [data]);
  const rows = useMemo(() => (data ?? []).filter(TABS.find((t) => t.key === tab).match), [data, tab]);

  return (
    <div className="space-y-6">
      <PageHeader title="Negotiations" description="Supplier conversations on open requests. The agent counters automatically within your target and maximum." />

      <section className="card overflow-hidden">
        <div className="flex items-center gap-1 border-b border-slate-200/80 bg-slate-50/60 px-5 py-3" role="tablist" aria-label="Filter negotiations">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ${
                tab === t.key ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              {t.label}
              <span className="tabular rounded-full bg-slate-100 px-1.5 text-xs text-slate-500">{data ? counts[t.key] : '–'}</span>
            </button>
          ))}
        </div>

        {isLoading && (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}
        {error && <ErrorState title="Could not load negotiations" message={error.message} onRetry={() => refetch()} />}
        {data && !rows.length && <EmptyState icon="messages" title="No negotiations here" description="Contacted suppliers on open requests appear here." />}

        {rows.length > 0 && (
          <table className="w-full table-fixed">
            <colgroup>
              <col />
              <col className="w-48" />
              <col className="w-28" />
              <col className="w-52" />
              <col className="w-36" />
              <col className="w-36" />
              <col className="w-40" />
            </colgroup>
            <thead className="border-b border-slate-200/80 bg-slate-50/70">
              <tr>
                <th className="th">Supplier</th>
                <th className="th">Request</th>
                <th className="th text-right">Rounds</th>
                <th className="th text-right">Opening → current</th>
                <th className="th text-right">Target</th>
                <th className="th">Status</th>
                <th className="th">Last update</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((n) => (
                <tr key={n.id} onClick={() => navigate(`/requests/${n.request_id}`)} className="cursor-pointer hover:bg-slate-50/80">
                  <td className="td">
                    <p className="truncate font-medium text-slate-900">{n.supplier}</p>
                    <p className="truncate text-xs text-slate-500">{n.email ?? 'No email'}</p>
                  </td>
                  <td className="td truncate text-slate-700">{n.commodity}</td>
                  <td className="td tabular text-right">
                    {n.rounds_used} / {n.max_rounds}
                  </td>
                  <td className="td tabular text-right">
                    {n.current_offer_price == null ? (
                      <span className="text-slate-400">No quote yet</span>
                    ) : (
                      <>
                        {n.opening_price !== n.current_offer_price && <span className="mr-1.5 text-xs text-slate-400 line-through">{formatMoney(n.opening_price, n.currency)}</span>}
                        <span className="font-semibold text-slate-900">{formatMoney(n.current_offer_price, n.currency)}</span>
                      </>
                    )}
                  </td>
                  <td className="td tabular text-right text-slate-600">{formatMoney(n.target_price, n.currency)}</td>
                  <td className="td">
                    <StatusBadge status={n.status} kind="thread" />
                  </td>
                  <td className="td tabular text-slate-500">{formatDateTime(n.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
