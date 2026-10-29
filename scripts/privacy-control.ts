import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPool } from '../src/db/pool.js';
import { PrivacyAdmin } from '../src/modules/privacy/admin.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL administrator required');
const pool = createPool(process.env.DATABASE_URL),
  privacy = new PrivacyAdmin(pool);
const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'status' && !args.length)
    console.log(JSON.stringify(await privacy.status(), null, 2));
  else if (command === 'export' && args.length === 2) {
    const data = await privacy.exportRequest(args[0]!);
    const path = resolve(args[1]!);
    await writeFile(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await privacy.markExported(args[0]!);
    console.log(JSON.stringify({ event: 'export_written', path }));
  } else if (command === 'purge' && args.length === 1)
    console.log(JSON.stringify(await privacy.purge(args[0]!)));
  else if (
    command === 'retention' &&
    (args.length === 0 || (args.length === 1 && args[0] === '--apply'))
  )
    console.log(
      JSON.stringify({
        preview: args.length === 0,
        ...(await privacy.retain(100, args[0] === '--apply')),
      }),
    );
  else
    throw new Error(
      'Usage: privacy:control status | export <request-uuid> <new-json-path> | purge <confirmed-user-uuid> | retention [--apply]',
    );
} finally {
  await pool.end();
}
