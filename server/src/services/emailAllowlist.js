// Recipients approved from the UI. They are allowed in addition to EMAIL_ALLOWED_RECIPIENTS (.env).
// Kept in memory so the recipient check stays synchronous; the database is the source of truth.
import { config } from '../config.js';
import { query } from '../db/pool.js';

let approved = new Set();

const normalize = (email) => email.trim().toLowerCase();

/** Loads the approved addresses from the database (call at startup). */
export async function loadAllowlist() {
  const { rows } = await query('SELECT email FROM email_allowlist');
  approved = new Set(rows.map((r) => r.email));
}

export const isUiAllowed = (email) => Boolean(email) && approved.has(normalize(email));

/** Approves an address. Idempotent; returns { email, created } (created=false if it was already approved). */
export async function addAllowed(email, addedBy = 'ui') {
  const value = normalize(email);
  const { rowCount } = await query(
    'INSERT INTO email_allowlist (email, added_by) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
    [value, addedBy],
  );
  approved.add(value);
  return { email: value, created: rowCount > 0 };
}

/** Removes a UI-approved address. Returns false if it was not approved in the UI. */
export async function removeAllowed(email) {
  const value = normalize(email);
  const { rowCount } = await query('DELETE FROM email_allowlist WHERE email = $1', [value]);
  approved.delete(value);
  return rowCount > 0;
}

/** Every allowed address: UI approvals plus .env entries (exact addresses or "@domain"). */
export async function listAllowed() {
  const { rows } = await query('SELECT email, created_at FROM email_allowlist ORDER BY created_at DESC');
  return [
    ...rows.map((r) => ({ email: r.email, source: 'ui', created_at: r.created_at })),
    ...config.email.allowedRecipients.map((email) => ({ email, source: 'env', created_at: null })),
  ];
}

export const allowlistSize = () => approved.size + config.email.allowedRecipients.length;

/** Test hook: forget the in-memory copy (simulates a restart before loadAllowlist()). */
export function resetAllowlistCache() {
  approved = new Set();
}
