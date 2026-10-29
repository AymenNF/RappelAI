import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db/pool.js';
import { QuotaControl } from '../src/modules/quotas/control.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL administrator required');
const pool = createPool(process.env.DATABASE_URL),
  control = new QuotaControl(pool);
const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'status' && !args.length)
    console.log(JSON.stringify(await control.status(), null, 2));
  else if (command === 'limits' && args.length === 2)
    await control.change(JSON.parse(await readFile(args[0]!, 'utf8')), args[1]!);
  else if ((command === 'block' || command === 'unblock') && args.length === 2)
    await control.change(null, args[1]!, args[0]!, command === 'block');
  else
    throw new Error(
      'Usage: quota:control status | limits <json-path> <note> | block/unblock <user-uuid> <note>',
    );
  if (command !== 'status')
    console.log(JSON.stringify({ event: 'quota_control_updated', command }));
} finally {
  await pool.end();
}
