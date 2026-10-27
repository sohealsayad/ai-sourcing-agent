import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { EmptyState, ErrorState, Icon, PageHeader, Skeleton, StatCard } from '../components/ui.jsx';
import { formatDateTime } from '../lib/format.js';

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Every supplier found or added across requests, with how often it was contacted, quoted and chosen. */
export default function SuppliersPage() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['suppliers'], queryFn: api.listSuppliers });
  const [search, setSearch] = useState('');

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data ?? []).filter((s) => !term || `${s.name} ${s.email ?? ''} ${s.location ?? ''}`.toLowerCase().includes(term));
  }, [data, search]);
  const sum = (key) => (data ? data.reduce((n, s) => n + s[key], 0) : '—');

  return (
    <div className="space-y-6">
      <PageHeader title="Suppliers" description="All suppliers found by AI search or added by hand, across every request." />

      <div className="grid grid-cols-4 gap-5">
        <StatCard label="Suppliers" value={data ? data.length : '—'} icon="users" />
        <StatCard label="Contacted" value={sum('contacted')} hint="Proposals sent" icon="send" tone="brand" />
        <StatCard label="Quoted" value={sum('quoted')} hint="Replied with a price" icon="receipt" tone="amber" />
        <StatCard label="Won" value={sum('won')} hint="Approved deals" icon="badgeCheck" tone="emerald" />
      </div>

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200/80 px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-slate-900">Supplier directory</h2>
            <p className="mt-0.5 text-xs text-slate-500">{data ? `${rows.length} of ${data.length} shown` : 'Loading…'}</p>
          </div>
          <div className="relative w-72">
            <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
            <input type="search" className="field-input pl-9!" placeholder="Search name, email or location" aria-label="Search suppliers" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        {isLoading && (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}
        {error && <ErrorState title="Could not load suppliers" message={error.message} onRetry={() => refetch()} />}
        {data && !rows.length && <EmptyState icon="users" title={data.length ? 'No suppliers match' : 'No suppliers yet'} description={data.length ? 'Try another search.' : 'Suppliers appear here once a request finds or adds them.'} />}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] table-fixed">
            <colgroup>
              <col className="w-[28%]" />
              <col className="w-[24%]" />
              <col className="w-24" />
              <col className="w-24" />
              <col className="w-24" />
              <col className="w-20" />
              <col className="w-44" />
            </colgroup>
            <thead className="border-b border-slate-200/80 bg-slate-50/70">
              <tr>
                <th className="th">Supplier</th>
                <th className="th">Contact</th>
                <th className="th text-right">Requests</th>
                <th className="th text-right">Contacted</th>
                <th className="th text-right">Quoted</th>
                <th className="th text-right">Won</th>
                <th className="th">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((s) => (
                <tr
                  key={s.id}
                  onClick={() => s.latest_request_id && navigate(`/requests/${s.latest_request_id}?supplier=${s.latest_thread_id}`)}
                  className={s.latest_request_id ? 'cursor-pointer hover:bg-slate-50/80' : ''}
                  title={s.latest_request_id ? 'Open this supplier in its latest request' : undefined}
                >
                  <td className="td">
                    <p className="truncate font-medium text-slate-900" title={s.name}>
                      {s.name}
                    </p>
                    <p className="truncate text-xs text-slate-500">{s.location ?? '—'}</p>
                  </td>
                  <td className="td">
                    <p className="truncate text-slate-700" title={s.email ?? ''}>
                      {s.email ?? <span className="text-amber-700">No email</span>}
                    </p>
                    {s.website && (
                      <a href={s.website} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="truncate text-xs text-slate-500 hover:underline">
                        {hostOf(s.website)} ↗
                      </a>
                    )}
                  </td>
                  <td className="td tabular text-right">{s.requests}</td>
                  <td className="td tabular text-right">{s.contacted}</td>
                  <td className="td tabular text-right">{s.quoted}</td>
                  <td className="td tabular text-right font-semibold text-emerald-700">{s.won || '—'}</td>
                  <td className="td tabular text-slate-500">{s.last_activity ? formatDateTime(s.last_activity) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>
    </div>
  );
}
