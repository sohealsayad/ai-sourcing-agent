import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { Icon } from './ui.jsx';

/**
 * Addresses approved for real email: UI approvals (removable) and EMAIL_ALLOWED_RECIPIENTS entries.
 * Used inline on a request (with `onClose`) and on the Settings page.
 */
export default function AllowlistPanel({ onClose, className = 'border-b border-slate-200/80 bg-slate-50/70 px-5 py-3' }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['allowlist'], queryFn: api.listAllowedRecipients });
  const remove = useMutation({
    mutationFn: api.removeAllowedRecipient,
    meta: { success: (_res, email) => `${email} removed. Real emails to it are blocked again.` },
    onSettled: () =>
      Promise.all(['allowlist', 'request', 'health'].map((key) => queryClient.invalidateQueries({ queryKey: [key] }))),
  });
  const entries = data?.entries ?? [];

  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-800">Allowed recipients for real email</p>
        {onClose && (
          <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={onClose} aria-label="Close allowed recipients">
            <Icon name="x" className="size-3.5" />
          </button>
        )}
      </div>
      {isLoading && <p className="text-xs text-slate-500">Loading…</p>}
      {error && <p className="field-error">{error.message}</p>}
      {data?.allowAny && <p className="mb-2 text-xs font-medium text-amber-700">EMAIL_ALLOW_ANY_RECIPIENT is on: every address can be emailed.</p>}
      {data && !entries.length && <p className="text-xs text-slate-500">No addresses yet. Use “Allow this address” on a supplier.</p>}
      <ul className="flex flex-wrap gap-2">
        {entries.map((e) => (
          <li key={`${e.source}:${e.email}`} className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs ring-1 ring-slate-200 ring-inset">
            <span className="text-slate-700">{e.email}</span>
            {e.source === 'env' ? (
              <span className="text-slate-400">from .env</span>
            ) : (
              <button
                type="button"
                className="grid size-4 place-items-center rounded-full text-slate-400 hover:bg-red-50 hover:text-red-600"
                onClick={() => remove.mutate(e.email)}
                disabled={remove.isPending}
                aria-label={`Remove ${e.email}`}
                title="Remove: real emails to this address will be blocked again"
              >
                <Icon name="x" className="size-3" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {remove.isError && <p className="field-error">{remove.error.message}</p>}
    </div>
  );
}
