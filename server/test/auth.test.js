import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import express from 'express';

// config.js requires a DATABASE_URL; these tests never connect.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { buildConfig } = await import('../src/config.js');
const { requirePassword } = await import('../src/auth.js');

const LIVE = {
  DATABASE_URL: 'postgres://x/y',
  NODE_ENV: 'production',
  APP_PASSWORD: 'open-sesame',
  AI_MODE: 'live',
  AI_PROVIDER: 'gemini',
  GEMINI_API_KEY: 'key',
  SEARCH_PROVIDER: 'none',
  EMAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'me@example.com',
  SMTP_PASS: 'secret',
  EMAIL_FROM: 'me@example.com',
  EMAIL_ALLOWED_RECIPIENTS: 'supplier@tempmail.test',
};

describe('buildConfig: production', () => {
  test('accepts a live, password-protected setup', () => {
    const cfg = buildConfig(LIVE);
    assert.equal(cfg.production, true);
    assert.equal(cfg.appPassword, 'open-sesame');
  });

  test('refuses mock mode, simulated email or suppliers, and a missing password', () => {
    assert.throws(() => buildConfig({ ...LIVE, AI_MODE: 'mock' }), /requires AI_MODE=live/);
    assert.throws(() => buildConfig({ ...LIVE, EMAIL_TRANSPORT: 'simulated' }), /requires EMAIL_TRANSPORT=smtp/);
    assert.throws(() => buildConfig({ ...LIVE, SIMULATE_SUPPLIERS: 'true' }), /requires SIMULATE_SUPPLIERS=false/);
    assert.throws(() => buildConfig({ ...LIVE, APP_PASSWORD: '' }), /requires APP_PASSWORD/);
  });

  test('local runs keep mock mode and need no password', () => {
    const cfg = buildConfig({ DATABASE_URL: 'postgres://x/y', AI_MODE: 'mock' });
    assert.equal(cfg.production, false);
    assert.equal(cfg.appPassword, '');
  });
});

async function serve(password) {
  const app = express();
  app.use('/api', requirePassword(password));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.post('/api/webhooks/email', (req, res) => res.json({ ok: true }));
  app.get('/api/requests', (req, res) => res.json([]));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return { server, call: (path, headers = {}, method = 'GET') => fetch(base + path, { method, headers }) };
}

describe('requirePassword', () => {
  test('rejects missing or wrong passwords and accepts the right one', async () => {
    const { server, call } = await serve('open-sesame');
    try {
      const missing = await call('/requests');
      assert.equal(missing.status, 401);
      assert.deepEqual(await missing.json(), { error: 'Password required', passwordRequired: true });
      assert.equal((await call('/requests', { 'X-App-Password': 'wrong' })).status, 401);
      assert.equal((await call('/requests', { 'X-App-Password': 'open-sesame' })).status, 200);
    } finally {
      server.close();
    }
  });

  test('health and webhooks stay open', async () => {
    const { server, call } = await serve('open-sesame');
    try {
      assert.equal((await call('/health')).status, 200);
      assert.equal((await call('/webhooks/email', {}, 'POST')).status, 200);
    } finally {
      server.close();
    }
  });

  test('without a password everything is open', async () => {
    const { server, call } = await serve('');
    try {
      assert.equal((await call('/requests')).status, 200);
    } finally {
      server.close();
    }
  });
});
