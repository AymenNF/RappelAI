import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db/pool.js';
import { DeliveryRecovery } from '../src/modules/whatsapp/recovery.js';

const [command, ...args] = process.argv.slice(2);
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL administrator required');
const pool = createPool(process.env.DATABASE_URL);
try {
  const control = new DeliveryRecovery(pool);
  if (command === 'status' && args.length === 0)
    console.log(JSON.stringify(await control.status(), null, 2));
  else if (command === 'reconcile' && args.length === 2) {
    await control.reconcile(args[0]!, JSON.parse(await readFile(args[1]!, 'utf8')));
    console.log(JSON.stringify({ event: 'delivery_reconciled', attemptId: args[0] }));
  } else
    throw new Error(
      'Usage: delivery:control status | reconcile <attempt-uuid> <decision-json-path>',
    );
} finally {
  await pool.end();
}
