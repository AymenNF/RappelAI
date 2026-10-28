import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createPool } from '../src/db/pool.js';
import { UsageControl } from '../src/modules/usage/control.js';
import { UsageService } from '../src/modules/usage/service.js';
import { z } from 'zod';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL administrator required');
const pool = createPool(process.env.DATABASE_URL);
const control = new UsageControl(pool);
const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'status' && args.length === 0)
    console.log(JSON.stringify(await control.status(), null, 2));
  else if ((command === 'pause' || command === 'resume') && args.length === 1)
    await control.switch(command === 'resume', args[0]!);
  else if (command === 'limits' && args.length === 3)
    await control.limits(args[0]!, args[1]!, args[2]!);
  else if (command === 'user-limit' && args.length === 3)
    await control.userLimit(args[0]!, args[1]!, args[2]!);
  else if (command === 'rate' && args.length === 2)
    await control.rate(JSON.parse(await readFile(args[0]!, 'utf8')), args[1]!);
  else if (command === 'reconcile' && args.length === 4) {
    const tokens = z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(0).max(2147483647));
    await new UsageService(pool).reconcile(
      z.uuid().parse(args[0]),
      tokens.parse(args[1]),
      tokens.parse(args[2]),
      args[3]!,
    );
  } else
    throw new Error(
      'Usage: usage:control status | pause/resume <note> | limits <global-micros> <default-user-micros> <note> | user-limit <uuid> <micros> <note> | rate <json-path> <note> | reconcile <uuid> <input-tokens> <output-tokens> <evidence-note>',
    );
  if (command !== 'status')
    console.log(JSON.stringify({ event: 'usage_control_updated', command }));
} finally {
  await pool.end();
}
