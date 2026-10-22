import cors from 'cors';
import express from 'express';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { HttpError } from './errors.js';
import { requestsRouter } from './routes/requests.js';
import { webhooksRouter } from './routes/webhooks.js';

export function createApp() {
  const app = express();
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', async (req, res) => {
    await pool.query('SELECT 1');
    res.json({
      ok: true,
      aiMode: config.ai.mode,
      aiProvider: config.ai.mode === 'live' ? config.ai.provider : 'mock',
      aiModel: config.ai.mode === 'live' ? (config.ai.provider === 'gemini' ? config.ai.gemini.model : config.ai.model) : null,
      emailTransport: config.email.transport,
      allowedRecipients: config.email.allowAnyRecipient ? 'any' : config.email.allowedRecipients.length,
      inboundProvider: config.inbound.provider,
      simulatedSuppliers: config.simulation.suppliers,
    });
  });

  app.use('/api/requests', requestsRouter);
  app.use('/api/webhooks', webhooksRouter);

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        error: 'Validation failed',
        fields: Object.fromEntries(err.issues.map((i) => [i.path.join('.'), i.message])),
      });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
