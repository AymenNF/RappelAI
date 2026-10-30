import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { readSecret } from '../config/secrets.js';
import { createPool } from '../db/pool.js';
import { RecoveryControl } from '../modules/recovery/control.js';
const pool = createPool(readSecret('DATABASE_URL') ?? '');
const control = new RecoveryControl(pool);
const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'status' && !args.length) console.log(JSON.stringify(await control.status()));
  else if (command === 'overlay' && args.length === 1) {
    await writeFile(args[0]!, JSON.stringify(await control.overlay(), null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log('Wrote a new private deletion overlay.');
  } else if (command === 'quarantine' && args.length === 2)
    console.log(
      JSON.stringify(
        await control.quarantine(JSON.parse(await readFile(args[0]!, 'utf8')), args[1]!),
      ),
    );
  else if (command === 'release' && args.length === 1) {
    await control.release(JSON.parse(await readFile(args[0]!, 'utf8')));
    console.log('Released restore quarantine; spending remains paused.');
  } else throw new Error('Invalid recovery command');
} catch {
  console.error(
    'Recovery command failed. Require administrator access, isolated target and valid evidence. Use status | overlay <new-file> | quarantine <overlay-file> <expected-system-id> | release <review-file>.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
