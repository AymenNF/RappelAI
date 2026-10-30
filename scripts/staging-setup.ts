import { mkdir, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
const directory = resolve('.staging-local');
try {
  await access(directory);
  throw new Error('Staging secrets directory already exists; reuse it or rotate deliberately.');
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
await mkdir(directory, { mode: 0o700 });
const password = randomBytes(32).toString('hex');
const files: Record<string, string> = {
  postgres_password: password,
  admin_database_url: `postgresql://memorae:${password}@postgres:5432/memorae_staging`,
  whatsapp_app_secret: randomBytes(32).toString('hex'),
  whatsapp_verify_token: randomBytes(32).toString('hex'),
};
for (const role of ['ingress', 'worker', 'monitor'])
  files[`${role}_database_url`] =
    `postgresql://memorae_stage_${role}:${randomBytes(32).toString('hex')}@postgres:5432/memorae_staging`;
// Parent is private; readable file mounts work for the image's non-root node UID on Linux.
for (const [name, value] of Object.entries(files))
  await writeFile(resolve(directory, name), value + '\n', { flag: 'wx', mode: 0o444 });
console.log(
  'Created private local staging secret files. Values were not printed; do not commit or copy this directory into images.',
);
