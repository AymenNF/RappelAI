import 'dotenv/config';
import { z } from 'zod';
import { createPool } from '../src/db/pool.js';
import { assertRuntimeRole, runtimeDatabaseUrl } from '../src/db/runtime.js';
import { WorkQueue } from '../src/modules/processing/leases.js';

const id = z.uuid().safeParse(process.argv[2]);
const actor = process.argv[3];
if (!id.success || !actor || actor.length > 100) {
  throw new Error('Usage: npm run work:retry -- <dead-work-uuid> <operator-label>');
}
const pool = createPool(runtimeDatabaseUrl('worker'));
try {
  await assertRuntimeRole(pool, 'worker');
  const retried = await new WorkQueue(pool).requeueDead(id.data, actor);
  console.log(JSON.stringify({ event: 'operator_retry', workId: id.data, retried }));
  if (!retried) process.exitCode = 1;
} finally {
  await pool.end();
}
