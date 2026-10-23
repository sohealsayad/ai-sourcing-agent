import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { loadAllowlist } from './services/emailAllowlist.js';
import { boss, startQueue } from './workflow/queue.js';
import { startInboxPoller } from './workflow/inboxPoller.js';
import { startWorker } from './workflow/worker.js';

// Apply any pending migrations first, so new code never runs against an old schema.
await migrate();
await loadAllowlist();
await startQueue();
if (config.runWorker) {
  await startWorker();
  startInboxPoller();
}

const server = createApp().listen(config.port, () => {
  console.log(
    `API on http://localhost:${config.port} (AI mode: ${config.ai.mode}, email: ${config.email.transport}, ` +
      `simulated suppliers: ${config.simulation.suppliers})`,
  );
});

async function shutdown() {
  server.close();
  await boss.stop({ graceful: true, timeout: 10_000 });
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
