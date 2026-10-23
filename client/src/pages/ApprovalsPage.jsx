import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { EmptyState, ErrorState, Icon, PageHeader, Skeleton } from '../components/ui.jsx';
import { formatDateTime, formatMoney } from '../lib/format.js';

/** Requests waiting for a human decision, plus recently approved deals. */
export default function ApprovalsPage() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['requests'], queryFn: api.listRequests, refetchInterval: 15_000 });
  const pending = (data ?? []).filter((r) => r.status === 'DEAL_RECOMMENDED');
  const approved = (data ?? []).filter((r) => r.status === 'CLOSED').slice(0, 10);

  const best = (r) => r.recommendation?.ranked?.[0];

  return (
    <div className="space-y-6">
      <PageHeader title="Approvals" description="Nothing is agreed with a supplier until you approve it here or on the request." />

      {isLoading && <Skeleton className="h-40 w-full rounded-xl" />}
      {error && (
        <div className="card">
          <ErrorState title="Could not load approvals" message={error.message} onRetry={() => refetch()} />
        </div>
      )}

      {data && (
        <section className="card overflow-hidden">
          <div className="border-b border-slate-200/80 px-5 py-4">
            <h2 className="text-[15px] font-semibold text-slate-900">Waiting for your approval</h2>
            <p className="mt-0.5 text-xs text-slate-500">{pending.length} request{pending.length === 1 ? '' : 's'}</p>
          </div>
          {!pending.length ? (
            <EmptyState icon="badgeCheck" title="Nothing to approve" description="Requests appear here when negotiation has finished and a deal is recommended." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {pending.map((r) => {
                const b = best(r);
                return (
                  <li key={r.id} className="flex items-center gap-4 px-5 py-4">
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-emerald-50 text-emerald-600">
                      <Icon name="sparkles" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-slate-900">{r.commodity}</p>
                      <p className="text-sm text-slate-500">
                        {b ? (
                          <>
                            Recommended <span className="font-medium text-slate-800">{b.name}</span> at{' '}
                            <span className="tabular font-medium text-slate-800">{formatMoney(b.price, r.currency)}</span> / {r.unit} · total{' '}
                            <span className="tabular">{formatMoney(b.total, r.currency)}</span>
                          </>
                        ) : (
                          'Recommendation ready'
                        )}
                      </p>
                    </div>
                    <span className="tabular text-xs text-slate-400">{formatDateTime(r.updated_at)}</span>
                    <Link to={`/requests/${r.id}`} className="btn-primary">
                      Review & approve <Icon name="arrowRight" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {approved.length > 0 && (
        <section className="card overflow-hidden">
          <div className="border-b border-slate-200/80 px-5 py-4">
            <h2 className="text-[15px] font-semibold text-slate-900">Recently approved</h2>
          </div>
          <ul className="divide-y divide-slate-100">
            {approved.map((r) => (
              <li key={r.id} className="flex items-center gap-4 px-5 py-3">
                <Link to={`/requests/${r.id}`} className="min-w-0 flex-1 truncate font-medium text-slate-900 hover:text-brand-700">
                  {r.commodity}
                </Link>
                <span className="text-sm text-slate-500">{r.approved_by ? `by ${r.approved_by}` : ''}</span>
                <span className="tabular text-xs text-slate-400">{r.approved_at ? formatDateTime(r.approved_at) : ''}</span>
                <StatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
