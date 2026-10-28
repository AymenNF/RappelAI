import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const contents = template
  .replace('replace-with-meta-app-secret', randomBytes(32).toString('hex'))
  .replace('replace-with-random-verification-token', randomBytes(32).toString('hex'));
try {
  await writeFile(new URL('../.env', import.meta.url), contents, { flag: 'wx', mode: 0o600 });
  console.log(
    'Created .env with random LOCAL webhook secrets. Replace app secret before connecting Meta.',
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env already exists; preserved without changes.');
}
