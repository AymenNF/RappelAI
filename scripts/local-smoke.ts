import { readConfig } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { PostgresIngressStore } from '../src/db/ingress-store.js';
import { buildApp } from '../src/api/app.js';

const config = readConfig();
const pool = createPool(config.DATABASE_URL);
const app = buildApp({ ...config, LOG_LEVEL: 'silent' }, new PostgresIngressStore(pool));
try {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  for (const path of ['/health/live', '/health/ready']) {
    const response = await fetch(address + path);
    if (response.status !== 200) throw new Error(`${path}: ${response.status}`);
  }
  console.log('Local API + PostgreSQL smoke passed: liveness/readiness 200. Test server closed.');
} finally {
  await app.close();
  await pool.end();
}
