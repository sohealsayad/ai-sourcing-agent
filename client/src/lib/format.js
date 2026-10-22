export const formatMoney = (value, currency) =>
  value == null
    ? '—'
    : new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);

export const formatNumber = (value) => (value == null ? '—' : new Intl.NumberFormat().format(value));

export const formatDateTime = (value) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export const formatTime = (value) =>
  new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(value));

/** Formats a date-only 'YYYY-MM-DD' value without shifting it across time zones. */
export const formatDate = (value) =>
  value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value.slice(0, 10)}T00:00:00Z`))
    : '—';

// Statuses where a background job is running and the page should poll.
export const IN_PROGRESS = new Set(['DISCOVERING', 'SENDING_PROPOSALS', 'AWAITING_REPLIES', 'NEGOTIATING']);

/** True while any outbound email (e.g. the acceptance sent after approval) is still being delivered. */
export const hasPendingOutbound = (request) =>
  Boolean(request?.suppliers?.some((s) => s.messages?.some((m) => m.direction === 'outbound' && m.delivery_status === 'PENDING')));
