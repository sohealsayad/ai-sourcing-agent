import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import AllowlistPanel from '../components/AllowlistPanel.jsx';
import { CardHeader, ErrorState, PageHeader, Skeleton } from '../components/ui.jsx';

const PROVIDERS = { gemini: 'Gemini', anthropic: 'Claude', mock: 'Mock data' };
const SEARCH = { tavily: 'Tavily web search', gemini: 'Gemini Google Search', 'claude-web-search': 'Claude web search', none: 'None (AI knowledge only)' };

function Row({ label, value, hint }) {
  return (
    <div className="flex items-start justify-between gap-6 px-5 py-3.5">
      <div>
        <p className="text-sm font-medium text-slate-800">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
      </div>
      <p className="text-right text-sm font-semibold text-slate-900">{value}</p>
    </div>
  );
}

/** Read-only view of the backend configuration (from server/.env) plus the email allowlist. */
export default function SettingsPage() {
  const { data: h, isLoading, error, refetch } = useQuery({ queryKey: ['health'], queryFn: api.health });

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="How the workflow is configured. Values come from server/.env; restart the server after changing them." />

      {isLoading && <Skeleton className="h-64 w-full rounded-xl" />}
      {error && (
        <div className="card">
          <ErrorState title="Cannot reach the API server" message={error.message} onRetry={() => refetch()} />
        </div>
      )}

      {h && (
        <div className="grid grid-cols-2 items-start gap-6">
          <section className="card overflow-hidden">
            <CardHeader icon="sparkles" title="AI & supplier search" />
            <div className="divide-y divide-slate-100">
              <Row label="AI mode" value={h.aiMode === 'live' ? 'Live' : 'Mock'} hint="AI_MODE: mock generates demo suppliers" />
              <Row label="AI provider" value={PROVIDERS[h.aiProvider] ?? h.aiProvider} hint="AI_PROVIDER" />
              <Row label="Model" value={h.aiModel ?? '—'} hint="GEMINI_MODEL / ANTHROPIC_MODEL" />
              <Row label="Web search" value={SEARCH[h.searchProvider] ?? h.searchProvider ?? '—'} hint="SEARCH_PROVIDER / TAVILY_API_KEY" />
            </div>
          </section>

          <section className="card overflow-hidden">
            <CardHeader icon="mail" title="Email" />
            <div className="divide-y divide-slate-100">
              <Row label="Sending" value={h.emailTransport === 'smtp' ? 'Real (SMTP)' : 'Simulated'} hint="EMAIL_TRANSPORT" />
              <Row label="Reading replies" value={h.inboundProvider === 'imap' ? 'IMAP inbox' : 'Webhook / simulator only'} hint="INBOUND_PROVIDER" />
              <Row label="Simulated suppliers" value={h.simulatedSuppliers ? 'On' : 'Off'} hint="SIMULATE_SUPPLIERS" />
              <Row label="Allowed recipients" value={h.allowedRecipients === 'any' ? 'Any address' : h.allowedRecipients} hint=".env list + approved in the UI" />
            </div>
          </section>

          {h.emailTransport === 'smtp' && (
            <section className="card col-span-2 overflow-hidden">
              <AllowlistPanel className="px-5 py-4" />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
