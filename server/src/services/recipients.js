/**
 * True if `email` is on the allowlist. Entries are exact addresses or "@domain"
 * (that exact domain, not its subdomains). Case-insensitive.
 */
export function isRecipientAllowed(email, allowlist) {
  if (!email) return false;
  const address = email.trim().toLowerCase();
  const domain = `@${address.split('@')[1] ?? ''}`;
  return allowlist.some((entry) => (entry.startsWith('@') ? entry === domain : entry === address));
}
