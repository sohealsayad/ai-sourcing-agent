import { Icon } from './ui.jsx';

const STEPS = [
  { label: 'Request', hint: 'Requirement captured', statuses: ['DRAFT'] },
  { label: 'Find suppliers', hint: 'AI supplier search', statuses: ['DISCOVERING'] },
  { label: 'Send proposals', hint: 'RFQs to suppliers', statuses: ['SUPPLIERS_FOUND', 'SENDING_PROPOSALS'] },
  { label: 'Collect quotes', hint: 'Supplier replies', statuses: ['AWAITING_REPLIES'] },
  { label: 'Negotiate', hint: 'Bounded counter-offers', statuses: ['NEGOTIATING'] },
  { label: 'Approve deal', hint: 'Human decision', statuses: ['DEAL_RECOMMENDED', 'NO_DEAL', 'CANCELLED'] },
];

const stepIndexOf = (status) => STEPS.findIndex((s) => s.statuses.includes(status));
const STOPPED = new Set(['FAILED', 'NO_DEAL', 'CANCELLED']);
// Nothing is running in these states: the workflow waits for the buyer (choose suppliers, approve a deal).
const WAITING_FOR_BUYER = new Set(['SUPPLIERS_FOUND', 'DEAL_RECOMMENDED']);

export default function WorkflowStepper({ status, events = [] }) {
  const stopped = STOPPED.has(status);
  // When failed, highlight the stage the request was in when it failed.
  const failedFrom =
    status === 'FAILED'
      ? [...events].reverse().find((e) => e.type === 'STATUS_CHANGED' && e.payload.to === 'FAILED')?.payload.from
      : null;
  const current = status === 'FAILED' ? Math.max(stepIndexOf(failedFrom), 1) : stepIndexOf(status);
  const done = status === 'CLOSED';

  return (
    <ol className="grid grid-cols-6">
      {STEPS.map((step, i) => {
        const complete = done || i < current;
        const active = !done && i === current;
        const circle = complete
          ? 'bg-brand-600 text-white ring-brand-600'
          : active && stopped
            ? 'bg-red-600 text-white ring-red-600'
            : active
              ? 'bg-white text-brand-700 ring-2 ring-brand-600 shadow-[0_0_0_4px_var(--color-brand-100)]'
              : 'bg-white text-slate-400 ring-slate-300';

        return (
          <li key={step.label} className="relative flex flex-col items-center text-center">
            {i > 0 && (
              <span
                className={`absolute top-4 right-[calc(50%+1.25rem)] left-[calc(-50%+1.25rem)] h-0.5 -translate-y-1/2 rounded-full ${
                  complete || active ? 'bg-brand-600' : 'bg-slate-200'
                }`}
              />
            )}
            <span className={`relative z-10 grid size-8 place-items-center rounded-full text-xs font-semibold ring-1 ring-inset ${circle}`}>
              {complete ? <Icon name="check" className="size-4" /> : active && stopped ? <Icon name="x" className="size-4" /> : i + 1}
            </span>
            <span className={`mt-2.5 text-sm font-medium ${active || complete ? 'text-slate-900' : 'text-slate-400'}`}>{step.label}</span>
            <span className={`text-xs ${active ? (stopped ? 'text-red-600' : 'text-brand-700') : 'text-slate-400'}`}>
              {active ? (stopped ? 'Stopped' : WAITING_FOR_BUYER.has(status) ? 'Your action' : 'In progress') : step.hint}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
