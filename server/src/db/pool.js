import pg from 'pg';
import { config } from '../config.js';

// Return NUMERIC columns as JS numbers instead of strings (prices/quantities fit comfortably).
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

// Keep DATE columns as 'YYYY-MM-DD'. The default parses them as local midnight, which
// shifts the day when formatted in UTC (e.g. 15 Dec becomes 14 Dec in UTC+5:30).
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export const query = (text, params) => pool.query(text, params);

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
