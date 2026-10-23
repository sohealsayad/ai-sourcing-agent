// Must be imported before anything from src/: points the app at a separate test
// database (<your db>_test) and forces the offline, simulated configuration.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(serverDir, '.env') });

if (!process.env.DATABASE_URL) {
  throw new Error('Integration tests need DATABASE_URL in server/.env (a "<name>_test" database is used).');
}

const url = new URL(process.env.DATABASE_URL);
if (!url.pathname.endsWith('_test')) url.pathname = `${url.pathname}_test`;
process.env.DATABASE_URL = url.toString();

process.env.AI_MODE = 'mock';
// Never let real email or inbox settings from server/.env leak into tests.
process.env.EMAIL_TRANSPORT = 'simulated';
process.env.EMAIL_ALLOWED_RECIPIENTS = '';
process.env.EMAIL_ALLOW_ANY_RECIPIENT = 'false';
process.env.INBOUND_PROVIDER = 'none';
// Never call real search services from tests.
process.env.SEARCH_PROVIDER = 'none';
process.env.TAVILY_API_KEY = '';
process.env.SIMULATE_SUPPLIERS = 'true';
process.env.SIM_REPLY_DELAY_SECONDS = '0';
process.env.REPLY_TIMEOUT_SECONDS = '45';
