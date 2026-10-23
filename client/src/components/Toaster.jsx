import { useSyncExternalStore } from 'react';
import { Icon } from './ui.jsx';

// Tiny toast store: no dependency, callable from anywhere (including the react-query MutationCache).
let toasts = [];
let nextId = 1;
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());

export function dismissToast(id) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Shows a toast: tone is 'success' | 'error' | 'info'. Errors stay longer. */
export function toast(message, tone = 'success') {
  if (!message) return;
  const id = nextId++;
  toasts = [...toasts.slice(-3), { id, message, tone }];
  emit();
  setTimeout(() => dismissToast(id), tone === 'error' ? 7000 : 4000);
}

const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const TONES = {
  success: ['check', 'text-emerald-600'],
  error: ['alert', 'text-red-600'],
  info: ['info', 'text-brand-600'],
};

/** Bottom-right stack of toasts; errors are announced assertively to screen readers. */
export default function Toaster() {
  const items = useSyncExternalStore(subscribe, () => toasts);
  return (
    <div className="pointer-events-none fixed right-6 bottom-6 z-[60] flex w-96 flex-col gap-2">
      {items.map((t) => {
        const [icon, color] = TONES[t.tone] ?? TONES.info;
        return (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className="animate-slide-in-right pointer-events-auto flex items-start gap-3 rounded-xl bg-white px-4 py-3 text-sm text-slate-800 shadow-elevated ring-1 ring-slate-200"
          >
            <Icon name={icon} className={`mt-0.5 size-4 shrink-0 ${color}`} />
            <p className="min-w-0 flex-1">{t.message}</p>
            <button type="button" onClick={() => dismissToast(t.id)} className="text-slate-400 hover:text-slate-700" aria-label="Dismiss">
              <Icon name="x" className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
