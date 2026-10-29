import { readConfig } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { assertRuntimeRole, runtimeDatabaseUrl } from '../db/runtime.js';
import { PostgresIngressStore } from '../db/ingress-store.js';
import { buildApp } from './app.js';
import { databaseSink, RuntimeTelemetry } from '../modules/telemetry/runtime.js';

const config = readConfig();
const pool = createPool(runtimeDatabaseUrl('ingress'));
await assertRuntimeRole(pool, 'ingress').catch(async (error: unknown) => {
  await pool.end();
  throw error;
});
const telemetry = new RuntimeTelemetry('api', databaseSink(pool));
const app = buildApp(config, new PostgresIngressStore(pool), telemetry);
const flush = async () => {
  if (!(await telemetry.flush()))
    app.log.warn({ event: 'telemetry_flush_failed' }, 'Telemetry unavailable');
};
let timer: ReturnType<typeof setInterval> | undefined;
pool.on('error', () => app.log.error('Database connection failure'));
app.addHook('onClose', async () => {
  if (timer) clearInterval(timer);
  await flush();
  await pool.end();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close();
  });
}
try {
  await app.listen({ host: config.HOST, port: config.PORT });
  await flush();
  timer = setInterval(() => {
    void flush();
  }, 15000);
  timer.unref();
} catch {
  app.log.error('API startup failed; check port and configuration');
  await app.close();
  process.exitCode = 1;
}
