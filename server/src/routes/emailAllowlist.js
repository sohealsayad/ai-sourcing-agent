import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { HttpError, NotFoundError } from '../errors.js';
import { addAllowed, listAllowed, removeAllowed } from '../services/emailAllowlist.js';
import { logEvent } from '../workflow/stateMachine.js';

// Approving recipients from the UI: an explicit, logged action, so real email still never goes to
// an address nobody approved. Entries from EMAIL_ALLOWED_RECIPIENTS (.env) are read-only here.
export const emailAllowlistRouter = Router();

const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const AllowSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  requestId: z.string().uuid().optional(),
});

emailAllowlistRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    res.json({ entries: await listAllowed(), transport: config.email.transport, allowAny: config.email.allowAnyRecipient });
  }),
);

emailAllowlistRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const { email, requestId } = AllowSchema.parse(req.body ?? {});
    const result = await addAllowed(email);
    if (requestId) {
      // Show the approval on the request it was made from (ignore unknown ids).
      await logEvent(pool, requestId, 'RECIPIENT_ALLOWED', { email }).catch(() => {});
    }
    res.status(result.created ? 201 : 200).json(result);
  }),
);

emailAllowlistRouter.delete(
  '/:email',
  asyncRoute(async (req, res) => {
    const email = decodeURIComponent(req.params.email).trim().toLowerCase();
    if (await removeAllowed(email)) return res.json({ email, removed: true });
    if (config.email.allowedRecipients.includes(email)) {
      throw new HttpError(409, `${email} is defined in EMAIL_ALLOWED_RECIPIENTS (.env); remove it there`);
    }
    throw new NotFoundError(`${email} is not on the allowlist`);
  }),
);
