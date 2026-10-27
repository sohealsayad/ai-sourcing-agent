import { createHash, timingSafeEqual } from 'node:crypto';

// Compare fixed-length digests so the check takes the same time whatever the guess.
const digest = (value) => createHash('sha256').update(String(value)).digest();

// Health (status badges, uptime checks) and webhooks (own secret) stay reachable without the password.
const OPEN_PATHS = [/^\/health$/, /^\/webhooks\//];

/**
 * Express middleware for /api: requires the shared password in the X-App-Password header.
 * With no password configured it lets everything through (local development).
 */
export function requirePassword(password) {
  const expected = password ? digest(password) : null;
  return (req, res, next) => {
    if (!expected || OPEN_PATHS.some((re) => re.test(req.path))) return next();
    const given = req.get('x-app-password');
    if (given && timingSafeEqual(digest(given), expected)) return next();
    res.status(401).json({ error: 'Password required', passwordRequired: true });
  };
}
