import { useState } from 'react';
import StatusBadge from './StatusBadge.jsx';
import { Icon, Spinner } from './ui.jsx';

/** Inline editor for the email used for this supplier on this request (e.g. your test inbox). */
function EmailEditor({ supplier, onSave, onAllow, onDone }) {
  const [value, setValue] = useState(supplier.email_overridden ? supplier.email : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async (email) => {
    setSaving(true);
    setError(null);
    try {
      const res = await onSave(supplier.id, email);
      // With real email, offer to approve an address that is not allowed yet.
      if (email && res?.can_email === false && onAllow) await onAllow(email, supplier.id);
      onDone();
    } catch (err) {
      setError(err.fields?.email ?? err.message);
      setSaving(false);
    }
  };

  return (
    <form
      className="mt-3 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200 ring-inset"
      onSubmit={(e) => {
        e.preventDefault();
        save(value.trim());
      }}
    >
      <label className="mb-1.5 block text-xs font-medium text-slate-600" htmlFor={`email-${supplier.id}`}>
        Email to use for {supplier.name} on this request
      </label>
      <div className="flex items-center gap-2">
        <input
          id={`email-${supplier.id}`}
          type="email"
          autoFocus
          className="field-input max-w-80"
          placeholder="you@example.com"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="btn-primary px-3 py-1.5" disabled={saving || !value.trim()}>
          {saving ? <Spinner /> : <Icon name="check" />} Save
        </button>
        {supplier.email_overridden && (
          <button type="button" className="btn-ghost px-3 py-1.5" disabled={saving} onClick={() => save(null)}>
            Use original
          </button>
        )}
        <button type="button" className="btn-ghost px-3 py-1.5" disabled={saving} onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && <p className="field-error">{error}</p>}
      <p className="field-hint">Only for this request. With real email you will be asked to allow the address if it is not approved yet.</p>
    </form>
  );
}

function ScoreBar({ score }) {
  const value = Math.round(score ?? 0);
  const color = value >= 80 ? 'bg-brand-500' : value >= 60 ? 'bg-amber-400' : 'bg-slate-400';
  return (
    <div className="flex items-center gap-2" title={`AI relevance ${value}/100`}>
      <span className="text-[11px] font-medium text-slate-400">Fit</span>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="tabular w-6 text-right text-xs font-medium text-slate-600">{score == null ? '—' : value}</span>
    </div>
  );
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const initials = (name) =>
  name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

/**
 * Supplier list. With `selectable`, contactable suppliers get a checkbox bound to `selected` (a Set of ids).
 * Prices live in the quotation comparison; details and emails open in the side panel via `onView`.
 */
export default function SupplierTable({ suppliers, selectable = false, selected, onToggle, onView, onSetEmail, onAllowEmail }) {
  const [editingId, setEditingId] = useState(null);
  return (
    <ul className="divide-y divide-slate-100">
      {suppliers.map((s) => {
        // Only suppliers that have not been contacted yet can be selected or given another email.
        const notContacted = s.status === 'PENDING';
        const canSelect = selectable && notContacted && Boolean(s.email) && s.can_email !== false;
        const canEditEmail = Boolean(onSetEmail) && notContacted;
        const isSelected = canSelect && selected.has(s.id);
        return (
          <li key={s.id} className={`px-5 py-4 transition-colors ${isSelected ? 'bg-brand-50/40' : ''}`}>
            <div className="flex gap-4">
              {selectable && notContacted && (
                <input
                  type="checkbox"
                  className="mt-2.5 size-4 shrink-0 rounded accent-brand-600 disabled:opacity-40"
                  checked={isSelected}
                  disabled={!canSelect}
                  onChange={() => onToggle(s.id)}
                  aria-label={`Send proposal to ${s.name}`}
                />
              )}
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-xs font-semibold text-slate-600">
                {initials(s.name) || <Icon name="building" />}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <button type="button" onClick={() => onView(s.id)} className="text-left font-semibold text-slate-900 hover:text-brand-700">
                        {s.name}
                      </button>
                      {s.rfq_ref && (
                        <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-500">{s.rfq_ref}</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-slate-500">
                      {[s.location, s.description].filter(Boolean).join(' · ') || 'No description'}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <StatusBadge status={s.status} kind="thread" />
                    <ScoreBar score={s.relevance_score} />
                  </div>
                </div>

                {s.ai_reasoning && s.status === 'PENDING' && (
                  <p className="mt-3 flex gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600 ring-1 ring-slate-100 ring-inset">
                    <Icon name="sparkles" className="mt-px size-3.5 shrink-0 text-brand-500" />
                    <span>
                      <span className="font-semibold text-slate-700">Why it fits: </span>
                      {s.ai_reasoning}
                    </span>
                  </p>
                )}
                {s.final_reason && (
                  <p className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                    {s.final_reason}
                    {s.status === 'NEEDS_REVIEW' && (
                      <button type="button" onClick={() => onView(s.id)} className="font-semibold text-brand-700 hover:underline">
                        Re-check or enter the quote →
                      </button>
                    )}
                  </p>
                )}
                {s.last_error && s.status === 'SEND_FAILED' && <p className="mt-2 text-xs font-medium text-red-600">{s.last_error}</p>}

                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
                  {s.email ? (
                    <span className="flex items-center gap-1.5">
                      <Icon name="mail" className="size-3.5 text-slate-400" />
                      <a href={`mailto:${s.email}`} className="text-slate-700 hover:text-brand-700 hover:underline">
                        {s.email}
                      </a>
                      {s.email_overridden && (
                        <span
                          className="rounded-full bg-brand-50 px-2 py-0.5 font-medium text-brand-700 ring-1 ring-brand-200 ring-inset"
                          title={`Original: ${s.original_email ?? 'none found'}`}
                        >
                          Your email · original: {s.original_email ?? 'none'}
                        </span>
                      )}
                      {s.can_email === false && (
                        <>
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-800 ring-1 ring-amber-200 ring-inset">
                            Not in email allowlist
                          </span>
                          {onAllowEmail && notContacted && (
                            <button
                              type="button"
                              onClick={() => onAllowEmail(s.email, s.id)}
                              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-semibold text-brand-700 ring-1 ring-brand-200 ring-inset hover:bg-brand-50"
                            >
                              <Icon name="check" className="size-3.5" /> Allow this address
                            </button>
                          )}
                        </>
                      )}
                    </span>
                  ) : (
                    <span className="font-medium text-amber-700">No email found, so this supplier can't be contacted</span>
                  )}
                  {canEditEmail && editingId !== s.id && (
                    <button
                      type="button"
                      onClick={() => setEditingId(s.id)}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-brand-700 hover:bg-brand-50"
                    >
                      <Icon name="mail" className="size-3.5" />
                      {s.email ? 'Change email' : 'Add email'}
                    </button>
                  )}
                  {s.website && (
                    <a href={s.website} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-slate-800 hover:underline">
                      {hostOf(s.website)} ↗
                    </a>
                  )}
                  {s.phone && <span className="text-slate-500">{s.phone}</span>}
                  <button
                    type="button"
                    onClick={() => onView(s.id)}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-brand-700 hover:bg-brand-50"
                  >
                    <Icon name="eye" className="size-3.5" />
                    {s.messages?.length ? `View details & emails (${s.messages.length})` : 'View details'}
                  </button>
                </div>
                {canEditEmail && editingId === s.id && (
                  <EmailEditor supplier={s} onSave={onSetEmail} onAllow={onAllowEmail} onDone={() => setEditingId(null)} />
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
