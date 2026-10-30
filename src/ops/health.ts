import { readSecret } from '../config/secrets.js';
import { createPool } from '../db/pool.js';
const component = process.argv[2];
if (!['worker', 'monitor'].includes(component ?? '')) throw new Error('Invalid health component');
const pool = createPool(
  readSecret(component === 'worker' ? 'WORKER_DATABASE_URL' : 'MONITOR_DATABASE_URL') ?? '',
);
try {
  const result =
    component === 'worker'
      ? await pool.query("SELECT component_healthy('worker') AS healthy")
      : await pool.query(
          "SELECT EXISTS(SELECT 1 FROM monitoring_snapshot WHERE observed_at>clock_timestamp()-interval '60 seconds') AS healthy",
        );
  process.exitCode = result.rows[0].healthy ? 0 : 1;
} catch {
  process.exitCode = 1;
} finally {
  await pool.end();
}
