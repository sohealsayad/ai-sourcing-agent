import { Router } from 'express';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { ingestInboundEmail } from '../services/inbound.js';
import { InboundEmailSchema } from '../validation/request.js';

export const webhooksRouter = Router();

/**
 * Inbound supplier email, in the shape an email provider's inbound-parse webhook would post.
 * Also handy for testing by hand with curl. Requires X-Webhook-Secret when one is configured.
 */
webhooksRouter.post('/email', async (req, res, next) => {
  try {
    if (config.email.inboundWebhookSecret && req.get('X-Webhook-Secret') !== config.email.inboundWebhookSecret) {
      throw new HttpError(401, 'Invalid webhook secret');
    }
    const { from, subject, text, messageId } = InboundEmailSchema.parse(req.body ?? {});
    // Duplicates (same Message-ID, or same sender/subject/body) are detected inside ingestInboundEmail.
    const result = await ingestInboundEmail({ from, subject, body: text, messageId });
    res.status(202).json({ matched: result.matched, duplicate: Boolean(result.duplicate) });
  } catch (err) {
    next(err);
  }
});
