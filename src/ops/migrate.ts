import 'dotenv/config';
import { createPool } from '../db/pool.js';
import { readSecret } from '../config/secrets.js';
import { migrate } from '../db/migrate.js';
const url = readSecret('DATABASE_URL');
if (!url) throw new Error('Administrator database secret required');
const pool = createPool(url);
try {
  await migrate(pool, new URL('../../migrations/', import.meta.url));
} catch {
  console.error('Migration failed; inspect migration state with administrator access.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
