import 'dotenv/config';
import { readSecret } from '../config/secrets.js';
import { createPool } from '../db/pool.js';
import { BackupControl } from '../modules/recovery/backup-control.js';

const [command, value, extra] = process.argv.slice(2);
const pool = createPool(readSecret('DATABASE_URL') ?? '');
try {
  if (extra !== undefined) throw new Error();
  const control = new BackupControl(pool);
  if (command === 'expect' && (value === 'on' || value === 'off'))
    await control.change({ enabled: value === 'on' });
  else if (command === 'abandon' && value) await control.change({ abandon: value });
  else throw new Error();
  console.log(JSON.stringify({ event: 'backup_control_updated', launchEnabled: false }));
} catch {
  console.error(
    'Backup control failed. Use expect on|off or abandon <overdue-run-uuid> with administrator credentials.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
