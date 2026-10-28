import { readConfig } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { PostgresIngressStore } from '../db/ingress-store.js';
import { buildApp } from './app.js';

const config = readConfig();
const pool = createPool(config.DATABASE_URL);
const app = buildApp(config, new PostgresIngressStore(pool));
pool.on('error', () => app.log.error('Database connection failure'));
app.addHook('onClose', async () => {
  await pool.end();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close();
  });
}
try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch {
  app.log.error('API startup failed; check port and configuration');
  await app.close();
  process.exitCode = 1;
}
