import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { EmptyState, ErrorState, Icon, PageHeader, Skeleton, StatCard } from '../components/ui.jsx';
import { formatDateTime, formatMoney, formatNumber, IN_PROGRESS } from '../lib/format.js';
import { matchesStatusFilter, STATUS_FILTERS } from '../lib/status.js';

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

const SORTERS = {
  created: (r) => new Date(r.created_at).getTime(),
  target: (r) => Number(r.target_price),
};

/** Column header that toggles sorting; shows the direction and exposes it via aria-sort. */
function SortHeader({ label, column, sort, onSort, align = 'left' }) {
  const active = sort.key === column;
  return (
    <th className={`th ${align === 'right' ? 'text-right' : ''}`} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 rounded uppercase hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none ${
          active ? 'text-slate-900' : ''
        }`}
      >
        {label}
        <span aria-hidden="true" className={active ? 'text-brand-600' : 'text-slate-300'}>
          {active ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  );
}

export default function RequestList() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['requests'],
    queryFn: api.listRequests,
    refetchInterval: (query) => (query.state.data?.some((r) => IN_PROGRESS.has(r.status)) ? 4000 : false),
  });

  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  // Default: newest first (same order the API returns).
  const [sort, setSort] = useState({ key: 'created', dir: 'desc' });

  const counts = useMemo(
    () => Object.fromEntries(STATUS_FILTERS.map((f) => [f.key, (data ?? []).filter((r) => matchesStatusFilter(r.status, f.key)).length])),
    [data],
  );

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const value = SORTERS[sort.key];
    return (data ?? [])
      .filter((r) => matchesStatusFilter(r.status, statusFilter))
      .filter((r) => !term || `${r.commodity} ${r.location}`.toLowerCase().includes(term))
      .sort((a, b) => {
        const [x, y] = [value(a), value(b)];
        // Missing or non-numeric values always sort last.
        if (!Number.isFinite(x)) return Number.isFinite(y) ? 1 : 0;
        if (!Number.isFinite(y)) return -1;
        return sort.dir === 'asc' ? x - y : y - x;
      });
  }, [data, statusFilter, search, sort]);

  const toggleSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'created' ? 'desc' : 'asc' }));
  const clearFilters = () => {
    setSearch('');
    setStatusFilter('all');
  };
  const kpi = (key) => (data ? counts[key] : '—');
  const filtering = statusFilter !== 'all' || search.trim() !== '';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sourcing requests"
        description="Every request runs as an automated workflow: AI finds suppliers, sends proposals and negotiates. You approve the final deal."
      />

      <div className="grid grid-cols-4 gap-5">
        <StatCard label="Total requests" value={kpi('all')} hint="Show all" icon="layers" onClick={() => setStatusFilter('all')} active={statusFilter === 'all'} />
        <StatCard
          label="In progress"
          value={kpi('active')}
          hint="Finding, contacting or negotiating"
          icon="activity"
          tone="brand"
          onClick={() => setStatusFilter('active')}
          active={statusFilter === 'active'}
        />
        <StatCard
          label="Awaiting approval"
          value={kpi('approval')}
          hint="Ready for your decision"
          icon="clock"
          tone="amber"
          onClick={() => setStatusFilter('approval')}
          active={statusFilter === 'approval'}
        />
        <StatCard
          label="Deals approved"
          value={kpi('approved')}
          hint="Closed with an approved supplier"
          icon="badgeCheck"
          tone="emerald"
          onClick={() => setStatusFilter('approved')}
          active={statusFilter === 'approved'}
        />
      </div>

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200/80 px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900">All requests</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {data ? `${rows.length} of ${data.length} shown` : 'Loading…'}
            </p>
          </div>
          <Link to="/new" className="btn-secondary">
            <Icon name="plus" /> New request
          </Link>
        </div>

        {/* Toolbar: status tabs + search */}
        <div className="flex items-center justify-between gap-4 border-b border-slate-200/80 bg-slate-50/60 px-5 py-3">
          <div role="tablist" aria-label="Filter by status" className="flex flex-wrap gap-1">
            {STATUS_FILTERS.map((f) => {
              const active = statusFilter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setStatusFilter(f.key)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none ${
                    active ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  {f.label}
                  <span className={`tabular rounded-full px-1.5 text-xs ${active ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-500'}`}>
                    {data ? counts[f.key] : '–'}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="relative w-full max-w-72 shrink-0">
            <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search commodity or location"
              aria-label="Search requests by commodity or location"
              className="field-input pr-9"
              style={{ paddingLeft: '2.5rem' }}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Clear search"
                title="Clear search"
                className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <Icon name="x" className="size-3.5" />
              </button>
            )}
          </div>
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

        {data?.length > 0 && rows.length === 0 && (
          <EmptyState
            icon="search"
            title="No requests match"
            description={
              search.trim()
                ? `Nothing matches “${search.trim()}”${statusFilter !== 'all' ? ' with this status filter' : ''}.`
                : 'No requests have this status yet.'
            }
            action={
              filtering && (
                <button type="button" className="btn-secondary" onClick={clearFilters}>
                  Clear filters
                </button>
              )
            }
          />
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] table-fixed">
            <colgroup>
              <col className="w-64" />
              <col className="w-36" />
              <col className="w-44" />
              <col className="w-28" />
              <col className="w-64" />
              <col className="w-48" />
              <col className="w-10" />
            </colgroup>
            <thead className="border-b border-slate-200/80 bg-slate-50/70">
              <tr>
                <th className="th">Commodity</th>
                <th className="th text-right">Quantity</th>
                <SortHeader label="Target / unit" column="target" sort={sort} onSort={toggleSort} align="right" />
                <th className="th text-right">Suppliers</th>
                <th className="th">Status</th>
                <SortHeader label="Created" column="created" sort={sort} onSort={toggleSort} />
                <th className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                const failed = r.status === 'FAILED';
                return (
                  <tr
                    key={r.id}
                    onClick={() => navigate(`/requests/${r.id}`)}
                    className="group cursor-pointer transition-colors focus-within:bg-slate-50 hover:bg-slate-50/80"
                  >
                    <td className="td">
                      <Link
                        to={`/requests/${r.id}`}
                        title={r.commodity}
                        className="block truncate rounded font-medium text-slate-900 group-hover:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.commodity}
                      </Link>
                      <p className="mt-0.5 truncate text-xs text-slate-500" title={r.location}>
                        {r.location}
                      </p>
                    </td>
                    <td className="td tabular text-right whitespace-nowrap text-slate-700">
                      {formatNumber(r.quantity)} <span className="text-slate-400">{r.unit}</span>
                    </td>
                    <td className="td tabular text-right font-medium whitespace-nowrap text-slate-900">{formatMoney(r.target_price, r.currency)}</td>
                    <td className="td tabular text-right text-slate-700">{r.supplier_count ?? '—'}</td>
                    <td className="td">
                      <StatusBadge status={r.status} />
                      {failed && (
                        // Full text stays in the DOM for screen readers; visually truncated with a hover tooltip.
                        <p className="mt-1 truncate text-xs text-red-600" title={r.error || 'No reason recorded'}>
                          {r.error || 'No reason recorded'}
                        </p>
                      )}
                    </td>
                    <td className="td tabular whitespace-nowrap text-slate-500">{formatDateTime(r.created_at)}</td>
                    <td className="td text-slate-300 group-hover:text-brand-600">
                      <Icon name="arrowRight" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </div>
  );
}
