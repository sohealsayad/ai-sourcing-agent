import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { EmptyState, ErrorState, Icon, PageHeader, Skeleton, StatCard } from '../components/ui.jsx';
import { formatDateTime, formatMoney, formatNumber, IN_PROGRESS } from '../lib/format.js';

const ACTIVE = new Set([...IN_PROGRESS, 'SUPPLIERS_FOUND']);

function LoadingTable() {
  return (
    <div className="divide-y divide-slate-100">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-6 px-5 py-4">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-28" />
          </div>
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-5 w-28 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export default function RequestList() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['requests'],
    queryFn: api.listRequests,
    refetchInterval: (query) => (query.state.data?.some((r) => IN_PROGRESS.has(r.status)) ? 4000 : false),
  });

  const count = (pred) => (data ? data.filter(pred).length : '—');

  return (
    <div className="space-y-8">
      <PageHeader
        title="Sourcing requests"
        description="Every request runs as an automated workflow: AI finds suppliers, sends proposals and negotiates. You approve the final deal."
      />

      <div className="grid grid-cols-4 gap-5">
        <StatCard label="Total requests" value={count(() => true)} icon="layers" />
        <StatCard label="In progress" value={count((r) => ACTIVE.has(r.status))} hint="Finding, contacting or negotiating" icon="activity" tone="brand" />
        <StatCard label="Awaiting approval" value={count((r) => r.status === 'DEAL_RECOMMENDED')} hint="Ready for your decision" icon="clock" tone="amber" />
        <StatCard label="Deals approved" value={count((r) => r.status === 'CLOSED')} icon="badgeCheck" tone="emerald" />
      </div>

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200/80 px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900">All requests</h2>
            <p className="mt-0.5 text-xs text-slate-500">Most recent first</p>
          </div>
          <Link to="/new" className="btn-secondary">
            <Icon name="plus" /> New request
          </Link>
        </div>

        {isLoading && <LoadingTable />}
        {error && <ErrorState title="Could not load requests" message={error.message} onRetry={() => refetch()} />}

        {data?.length === 0 && (
          <EmptyState
            icon="inbox"
            title="No requests yet"
            description="Create a request with a commodity, location, quantity and target price to start finding suppliers."
            action={
              <Link to="/new" className="btn-primary">
                <Icon name="plus" /> Create your first request
              </Link>
            }
          />
        )}

        {data?.length > 0 && (
          <table className="w-full">
            <thead className="border-b border-slate-200/80 bg-slate-50/70">
              <tr>
                <th className="th">Commodity</th>
                <th className="th text-right">Quantity</th>
                <th className="th text-right">Target / unit</th>
                <th className="th text-right">Suppliers</th>
                <th className="th">Status</th>
                <th className="th">Created</th>
                <th className="th w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((r) => (
                <tr key={r.id} onClick={() => navigate(`/requests/${r.id}`)} className="group cursor-pointer transition-colors hover:bg-slate-50/80">
                  <td className="td">
                    <Link to={`/requests/${r.id}`} className="font-medium text-slate-900 group-hover:text-brand-700" onClick={(e) => e.stopPropagation()}>
                      {r.commodity}
                    </Link>
                    <p className="mt-0.5 text-xs text-slate-500">{r.location}</p>
                  </td>
                  <td className="td tabular text-right text-slate-700">
                    {formatNumber(r.quantity)} <span className="text-slate-400">{r.unit}</span>
                  </td>
                  <td className="td tabular text-right font-medium text-slate-900">{formatMoney(r.target_price, r.currency)}</td>
                  <td className="td tabular text-right text-slate-700">{r.supplier_count}</td>
                  <td className="td">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="td tabular whitespace-nowrap text-slate-500">{formatDateTime(r.created_at)}</td>
                  <td className="td text-slate-300 group-hover:text-brand-600">
                    <Icon name="arrowRight" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
