import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import AllowlistPanel from '../components/AllowlistPanel.jsx';
import ApprovalPanel from '../components/ApprovalPanel.jsx';
import QuoteComparison from '../components/QuoteComparison.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import SupplierPanel from '../components/SupplierPanel.jsx';
import SupplierTable from '../components/SupplierTable.jsx';
import Timeline from '../components/Timeline.jsx';
import { toast } from '../components/Toaster.jsx';
import { CardHeader, EmptyState, ErrorState, Icon, Notice, PageHeader, Skeleton, Spinner } from '../components/ui.jsx';
import WorkflowStepper from '../components/WorkflowStepper.jsx';
import { formatDate, formatDateTime, formatMoney, formatNumber, hasPendingOutbound, IN_PROGRESS } from '../lib/format.js';

function Detail({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="tabular text-right text-sm font-medium text-slate-900">{value}</dd>
    </div>
  );
}

function DiscoveringPlaceholder() {
  return (
    <div className="px-5 py-12 text-center">
      <span className="mx-auto grid size-12 place-items-center rounded-full bg-brand-50 text-brand-600">
        <Spinner className="size-5" />
      </span>
      <p className="mt-4 font-semibold text-slate-900">Searching for suppliers…</p>
      <p className="mt-1 text-sm text-slate-500">AI is looking for suppliers and checking their contact details. This usually takes under a minute.</p>
      <div className="mx-auto mt-6 max-w-xl space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg p-3 ring-1 ring-slate-100 ring-inset">
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LoadingDetail() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-4 w-96" />
      </div>
      <Skeleton className="h-28 w-full rounded-xl" />
      <div className="grid grid-cols-[1fr_22rem] gap-6">
        <Skeleton className="h-96 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    </div>
  );
}

/**
 * Adds a supplier by hand, e.g. a Temp Mail test address. With real email, ticking
 * "Allow sending" approves the address in the same step (that tick is the explicit approval).
 */
function AddSupplierForm({ requestId, realEmail, onAdded, onAllow }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [allow, setAllow] = useState(true);
  const add = useMutation({
    mutationFn: async () => {
      const address = email.trim();
      if (realEmail && allow) await api.allowRecipient(address, requestId);
      return { ...(await api.addSupplier(requestId, { name: name.trim(), email: address })), email: address };
    },
    meta: { success: (res) => `Supplier added (${res.email}).` },
    onSuccess: (res) => {
      setName('');
      setEmail('');
      onAdded(res.id, res.can_email);
    },
  });
  const fieldError = add.error?.fields && Object.values(add.error.fields)[0];
  const addedBlocked = add.isSuccess && add.data.can_email === false;

  return (
    <form
      className="border-b border-slate-200/80 bg-slate-50/70 px-5 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <div className="flex items-center gap-2">
        <span className="mr-1 text-sm font-medium text-slate-600">Add a supplier</span>
        <input id="add-supplier-name" aria-label="Supplier name" className="field-input max-w-56" placeholder="Supplier name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          aria-label="Supplier email"
          type="email"
          className="field-input max-w-72"
          placeholder="sales@supplier.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button className="btn-secondary" disabled={add.isPending || !name.trim() || !email.trim()}>
          {add.isPending ? <Spinner /> : <Icon name="plus" />}
          {add.isPending ? 'Adding…' : 'Add'}
        </button>
        {realEmail && (
          <label className="ml-1 flex items-center gap-1.5 text-xs font-medium text-slate-600" title="Real emails will be sent to this address">
            <input type="checkbox" className="size-4 accent-brand-600" checked={allow} onChange={(e) => setAllow(e.target.checked)} />
            Allow sending to this address
          </label>
        )}
      </div>
      {add.isError && <p className="field-error">{fieldError ?? add.error.message}</p>}
      {addedBlocked && (
        <p className="mt-1.5 flex items-center gap-2 text-xs font-medium text-amber-700">
          Added, but this address is not approved for real email yet.
          <button type="button" className="font-semibold text-brand-700 hover:underline" onClick={async () => (await onAllow(add.data.email, add.data.id)) && add.reset()}>
            Allow it now
          </button>
        </p>
      )}
    </form>
  );
}

export default function RequestDetail() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  // null = untouched, which means "every supplier with an email".
  const [selection, setSelection] = useState(null);
  // Supplier shown in the side panel (request_suppliers id), or null when closed.
  // ?supplier=<id> (from the Suppliers page) opens that panel on arrival.
  const [searchParams, setSearchParams] = useSearchParams();
  const [panelId, setPanelId] = useState(() => searchParams.get('supplier'));
  const closePanel = useCallback(() => {
    setPanelId(null);
    setSearchParams({}, { replace: true });
  }, [setSearchParams]);
  const [showAllowlist, setShowAllowlist] = useState(false);
  const [hideNoEmailHint, setHideNoEmailHint] = useState(false);

  const { data: r, isLoading, error, refetch } = useQuery({
    queryKey: ['request', id],
    queryFn: () => api.getRequest(id),
    // Keep refreshing while a job runs, and while an email (e.g. the acceptance) is still being delivered.
    refetchInterval: (query) => {
      const data = query.state.data;
      return IN_PROGRESS.has(data?.status) || hasPendingOutbound(data) ? 3000 : false;
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['request', id] });

  const rediscover = useMutation({
    mutationFn: () => api.rediscover(id),
    meta: { success: 'Searching for suppliers again…' },
    onSuccess: () => {
      setSelection(null);
      refresh();
    },
  });

  const sendProposals = useMutation({
    mutationFn: (ids) => api.sendProposals(id, ids),
    meta: { success: (_res, ids) => (ids?.length ? `Sending proposals to ${ids.length} supplier${ids.length === 1 ? '' : 's'}…` : 'Sending proposals…') },
    onSuccess: () => setSelection(null),
    onSettled: refresh,
  });

  // Real email only: approve an address from the UI after an explicit confirmation.
  const allowEmail = useCallback(
    async (email, threadId) => {
      if (!window.confirm(`Real emails will be sent to ${email}.\n\nAllow sending to this address?`)) return false;
      await api.allowRecipient(email, id);
      toast(`Real emails to ${email} are now allowed.`);
      if (threadId) setSelection((prev) => new Set([...(prev ?? []), threadId]));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['request', id] }),
        queryClient.invalidateQueries({ queryKey: ['allowlist'] }),
        queryClient.invalidateQueries({ queryKey: ['health'] }),
      ]);
      return true;
    },
    [id, queryClient],
  );

  const setSupplierEmail = useCallback(
    async (threadId, email) => {
      const res = await api.updateSupplierEmail(id, threadId, email);
      toast(email ? `Email for this request set to ${email}.` : 'Supplier email reset to the original address.');
      // Pre-select a supplier that can now be emailed.
      if (res.can_email) setSelection((prev) => new Set([...(prev ?? []), threadId]));
      await queryClient.invalidateQueries({ queryKey: ['request', id] });
      return res;
    },
    [id, queryClient],
  );

  if (isLoading) return <LoadingDetail />;
  if (error) {
    return (
      <div className="card">
        {error.status === 404 ? (
          <EmptyState
            icon="search"
            title="Request not found"
            description="This request does not exist or was removed."
            action={
              <Link to="/" className="btn-secondary">
                Back to requests
              </Link>
            }
          />
        ) : (
          <ErrorState title="Could not load this request" message={error.message} onRetry={() => refetch()} />
        )}
      </div>
    );
  }

  const choosing = r.status === 'SUPPLIERS_FOUND';
  // While quotes are coming in, more (not yet contacted) suppliers can still be invited.
  const inviting = r.status === 'AWAITING_REPLIES' || r.status === 'NEGOTIATING';
  const editable = choosing || inviting;

  const contactable = r.suppliers.filter((s) => s.status === 'PENDING' && s.email && s.can_email !== false);
  // First send: everyone contactable is pre-selected. Late invites: nothing until you choose.
  const selected = new Set(
    [...(selection ?? (choosing ? contactable.map((s) => s.id) : []))].filter((sid) => contactable.some((s) => s.id === sid)),
  );
  const toggle = (supplierId) => {
    const next = new Set(selected);
    next.has(supplierId) ? next.delete(supplierId) : next.add(supplierId);
    setSelection(next);
  };

  const failedSending = r.status === 'FAILED' && r.suppliers.some((s) => s.selected && ['SEND_FAILED', 'QUEUED'].includes(s.status));
  const canRediscover = choosing || (r.status === 'FAILED' && !failedSending);
  const busy = sendProposals.isPending || rediscover.isPending;
  const actionError = sendProposals.error ?? rediscover.error;
  const contacted = r.suppliers.filter((s) => s.selected);
  const quoted = r.suppliers.filter((s) => s.current_offer_price != null);
  // Suppliers were found, but the web had no public email for any of them: explain what to do next.
  const notContacted = r.suppliers.filter((s) => s.status === 'PENDING');
  const noEmailFound = choosing && notContacted.length > 0 && notContacted.every((s) => !s.email);
  const focusAddSupplier = () => {
    const input = document.getElementById('add-supplier-name');
    input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input?.focus({ preventScroll: true });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link to="/" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900">
            <Icon name="arrowLeft" /> Requests
          </Link>
        }
        title={r.commodity}
        badge={<StatusBadge status={r.status} />}
        description={r.specifications}
        meta={
          <>
            <span>
              {formatNumber(r.quantity)} {r.unit} to {r.location}
            </span>
            <span>Target {formatMoney(r.target_price, r.currency)} / {r.unit}</span>
            <span>Created {formatDateTime(r.created_at)}</span>
          </>
        }
      />

      {r.simulation && (
        <Notice tone="info" icon={<Icon name="info" className="size-5 shrink-0" />}>
          <span className="font-semibold">Simulation mode.</span> Emails are generated and recorded but never actually sent; supplier replies are
          simulated.
        </Notice>
      )}

      <div className="card px-6 py-6">
        <WorkflowStepper status={r.status} events={r.events} />
      </div>

      {r.status === 'FAILED' && r.error && (
        <Notice tone="error" icon={<Icon name="alert" className="size-5 shrink-0" />}>
          <span className="font-semibold">Workflow stopped: </span>
          {r.error}
        </Notice>
      )}

      {(r.status === 'AWAITING_REPLIES' || r.status === 'NEGOTIATING') && (
        <Notice tone="brand" icon={<Spinner className="size-4 text-brand-600" />}>
          {r.status === 'AWAITING_REPLIES' ? (
            <>
              <span className="font-semibold">Waiting for supplier quotes.</span> {quoted.length} of {contacted.length} supplier
              {contacted.length === 1 ? '' : 's'} have quoted so far.
            </>
          ) : (
            <>
              <span className="font-semibold">Negotiating</span> with up to {r.max_rounds} counter-offer{r.max_rounds === 1 ? '' : 's'} per supplier.
              Nothing is agreed without your approval.
            </>
          )}
        </Notice>
      )}

      {['DEAL_RECOMMENDED', 'CLOSED', 'NO_DEAL', 'CANCELLED'].includes(r.status) && <ApprovalPanel key={r.status} request={r} />}

      <QuoteComparison request={r} onView={setPanelId} />

      <div className="grid grid-cols-[1fr_22rem] items-start gap-6">
        <section className="card overflow-hidden">
          <CardHeader
            icon="building"
            title="Suppliers"
            description={
              r.suppliers.length
                ? choosing
                  ? `${selected.size} of ${contactable.length} contactable supplier${contactable.length === 1 ? '' : 's'} selected`
                  : inviting && contactable.length
                    ? `${r.suppliers.length} found · ${contacted.length} contacted · select more to invite`
                    : `${r.suppliers.length} found · ${contacted.length} contacted`
                : null
            }
            actions={
              <>
                {!r.simulation && (
                  <button className="btn-ghost" onClick={() => setShowAllowlist((v) => !v)} aria-expanded={showAllowlist}>
                    <Icon name="mail" /> Allowed recipients
                  </button>
                )}
                {canRediscover && (
                  <button className="btn-secondary" onClick={() => rediscover.mutate()} disabled={busy}>
                    {rediscover.isPending ? <Spinner /> : <Icon name="refresh" />}
                    {r.status === 'FAILED' ? 'Retry search' : 'Search again'}
                  </button>
                )}
                {choosing && (
                  <button className="btn-primary" onClick={() => sendProposals.mutate([...selected])} disabled={busy || selected.size === 0}>
                    {sendProposals.isPending ? <Spinner /> : <Icon name="send" />}
                    {sendProposals.isPending ? 'Sending…' : `Send proposals to ${selected.size} supplier${selected.size === 1 ? '' : 's'}`}
                  </button>
                )}
                {inviting && contactable.length > 0 && (
                  <button className="btn-primary" onClick={() => sendProposals.mutate([...selected])} disabled={busy || selected.size === 0}>
                    {sendProposals.isPending ? <Spinner /> : <Icon name="send" />}
                    {sendProposals.isPending ? 'Sending…' : `Send proposals to ${selected.size} more supplier${selected.size === 1 ? '' : 's'}`}
                  </button>
                )}
                {failedSending && (
                  <button className="btn-primary" onClick={() => sendProposals.mutate(undefined)} disabled={busy}>
                    {sendProposals.isPending ? <Spinner /> : <Icon name="refresh" />}
                    Retry sending
                  </button>
                )}
              </>
            }
          />

          {r.status === 'SENDING_PROPOSALS' && (
            <div className="flex items-center gap-2 border-b border-brand-100 bg-brand-50/70 px-5 py-2.5 text-sm font-medium text-brand-800">
              <Spinner /> Delivering proposals…
            </div>
          )}
          {showAllowlist && !r.simulation && <AllowlistPanel onClose={() => setShowAllowlist(false)} />}
          {noEmailFound && !hideNoEmailHint && (
            <div className="border-b border-amber-200 bg-amber-50 px-5 py-4" role="status">
              <div className="flex items-start gap-3">
                <Icon name="info" className="mt-0.5 size-5 shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-amber-900">
                    None of the {notContacted.length === 1 ? 'supplier' : `${notContacted.length} suppliers`} found has a public email address
                  </p>
                  <p className="mt-0.5 text-sm text-amber-800">
                    You can add an email manually (from their website or phone), add your own supplier, or search again to find more suppliers.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" className="btn-secondary" onClick={focusAddSupplier}>
                      <Icon name="plus" /> Add supplier manually
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => rediscover.mutate()} disabled={busy}>
                      {rediscover.isPending ? <Spinner /> : <Icon name="refresh" />} Search again
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className="grid size-7 shrink-0 place-items-center rounded-md text-amber-700 hover:bg-amber-100"
                  onClick={() => setHideNoEmailHint(true)}
                  aria-label="Dismiss"
                >
                  <Icon name="x" className="size-4" />
                </button>
              </div>
            </div>
          )}
          {actionError && (
            <div className="flex items-center gap-2 border-b border-red-100 bg-red-50 px-5 py-2.5 text-sm text-red-700">
              <Icon name="alert" /> {actionError.message}
            </div>
          )}
          {editable && (
            <AddSupplierForm
              requestId={r.id}
              realEmail={!r.simulation}
              onAllow={allowEmail}
              onAdded={(threadId, canEmail) => {
                // Keep the current selection and include the new supplier if it can be emailed.
                if (canEmail) setSelection(new Set([...selected, threadId]));
                refresh();
              }}
            />
          )}

          {r.status === 'DISCOVERING' ? (
            <DiscoveringPlaceholder />
          ) : r.suppliers.length ? (
            <SupplierTable
              suppliers={r.suppliers}
              selectable={editable}
              selected={selected}
              onToggle={toggle}
              onView={setPanelId}
              onSetEmail={editable ? setSupplierEmail : undefined}
              onAllowEmail={editable && !r.simulation ? allowEmail : undefined}
            />
          ) : (
            <EmptyState icon="building" title="No suppliers yet" description="Run the search again or add a supplier by hand." />
          )}
        </section>

        <aside className="space-y-6">
          <section className="card overflow-hidden">
            <CardHeader icon="info" title="Request details" />
            <dl className="divide-y divide-slate-100 px-5 py-1">
              <Detail label="Delivery to" value={r.location} />
              <Detail label="Quantity" value={`${formatNumber(r.quantity)} ${r.unit}`} />
              <Detail label="Target / unit" value={formatMoney(r.target_price, r.currency)} />
              <Detail label="Max / unit" value={formatMoney(r.max_price, r.currency)} />
              <Detail label="Target total" value={formatMoney(r.target_price * r.quantity, r.currency)} />
              <Detail label="Needed by" value={formatDate(r.deadline)} />
              <Detail label="Negotiation rounds" value={r.max_rounds} />
              {r.buyer_name && <Detail label="Buyer" value={r.buyer_name} />}
            </dl>
          </section>

          <section className="card overflow-hidden">
            <CardHeader icon="activity" title="Activity" description={`${r.events.length} events · newest first`} />
            <Timeline events={r.events} currency={r.currency} />
          </section>
        </aside>
      </div>

      {/* Live data: the panel re-renders as polling brings new quotes and emails. */}
      <SupplierPanel request={r} supplier={r.suppliers.find((s) => s.id === panelId)} onClose={closePanel} />
    </div>
  );
}
