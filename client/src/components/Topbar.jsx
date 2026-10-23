import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { Icon } from './ui.jsx';

const PILL_TONES = {
  live: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  sim: 'bg-amber-50 text-amber-800 ring-amber-200',
  neutral: 'bg-slate-100 text-slate-600 ring-slate-200',
  error: 'bg-red-50 text-red-700 ring-red-200',
};

function Pill({ tone = 'neutral', children, title }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${PILL_TONES[tone]}`}>
      {children}
    </span>
  );
}

const PROVIDERS = { gemini: 'Gemini', anthropic: 'Claude' };

/** Turns /api/health into readable labels; unexpected values are shown as-is rather than guessed. */
function describeHealth(health) {
  const search = health.searchProvider === 'tavily' ? ' + Tavily' : '';
  const ai =
    health.aiMode === 'live'
      ? {
          tone: health.searchProvider === 'none' ? 'neutral' : 'live',
          text: `AI: Live${PROVIDERS[health.aiProvider] ? ` · ${PROVIDERS[health.aiProvider]}` : ''}${search}`,
          title:
            health.searchProvider === 'none'
              ? 'Live AI without web search: suppliers come from the model’s knowledge (not web-verified)'
              : `Suppliers are searched online${search ? ' with Tavily' : ''}; ${health.aiModel ?? 'the AI'} picks the best matches`,
        }
      : health.aiMode === 'mock'
        ? { tone: 'sim', text: 'AI: Mock data', title: 'Suppliers are generated demo data (AI_MODE=mock)' }
        : { tone: 'neutral', text: `AI: ${health.aiMode ?? 'unknown'}`, title: 'Unrecognised AI mode' };
  const email =
    health.emailTransport === 'smtp'
      ? { tone: 'live', text: 'Email: Real · SMTP', title: 'Emails are really sent, only to allow-listed addresses' }
      : health.emailTransport === 'simulated'
        ? { tone: 'sim', text: 'Email: Simulated', title: 'Emails are recorded but never sent' }
        : { tone: 'neutral', text: `Email: ${health.emailTransport ?? 'unknown'}`, title: 'Unrecognised email transport' };
  return [ai, email];
}

function breadcrumbs(pathname) {
  if (pathname === '/new') return [{ to: '/', label: 'Requests' }, { label: 'New request' }];
  if (pathname.startsWith('/requests/')) return [{ to: '/', label: 'Requests' }, { label: 'Request details' }];
  if (pathname === '/') return [{ label: 'Requests' }];
  const pages = { '/suppliers': 'Suppliers', '/quotes': 'Quotes', '/negotiations': 'Negotiations', '/approvals': 'Approvals', '/settings': 'Settings' };
  if (pages[pathname]) return [{ label: pathname === '/settings' ? 'System' : 'Procurement' }, { label: pages[pathname] }];
  return [{ to: '/', label: 'Requests' }, { label: 'Not found' }];
}

/** Sticky bar above every page: sidebar toggle, breadcrumbs and the backend's AI / email mode. */
export default function Topbar({ collapsed, onToggle }) {
  const { pathname } = useLocation();
  const { data: health, isLoading, isError } = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 30_000,
    retry: false,
  });
  const crumbs = breadcrumbs(pathname);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200/80 bg-white/85 px-6 backdrop-blur">
      <button
        type="button"
        onClick={onToggle}
        className="btn-ghost px-2"
        aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-expanded={!collapsed}
        title={`${collapsed ? 'Show' : 'Hide'} sidebar (Ctrl+B)`}
      >
        <Icon name="panelLeft" className="size-5" />
      </button>
      <span className="h-5 w-px bg-slate-200" aria-hidden="true" />

      <nav aria-label="Breadcrumb">
        <ol className="flex items-center gap-2 text-sm">
          {crumbs.map((c, i) => (
            <li key={c.label} className="flex items-center gap-2">
              {c.to ? (
                <Link to={c.to} className="rounded text-slate-500 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none">
                  {c.label}
                </Link>
              ) : (
                <span className="font-medium text-slate-900" aria-current="page">
                  {c.label}
                </span>
              )}
              {i < crumbs.length - 1 && (
                <span className="text-slate-300" aria-hidden="true">
                  /
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>

      <div className="ml-auto flex items-center gap-2" aria-live="polite">
        {isLoading && <Pill>Checking backend…</Pill>}
        {isError && (
          <Pill tone="error" title="Cannot reach /api/health; is `npm run dev` running?">
            API: unavailable
          </Pill>
        )}
        {health &&
          describeHealth(health).map((p) => (
            <Pill key={p.text} tone={p.tone} title={p.title}>
              {p.text}
            </Pill>
          ))}
      </div>
    </header>
  );
}
