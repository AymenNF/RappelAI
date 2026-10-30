import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
export async function migrate(pool: Pool, directory: URL) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('memorae:migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
    const dir = directory;
    const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const name of files) {
      const sql = await readFile(new URL(name, dir), 'utf8');
      const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      const previous = await client.query(
        'SELECT checksum FROM schema_migrations WHERE name = $1',
        [name],
      );
      if (previous.rowCount) {
        if (previous.rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [
          name,
          checksum,
        ]);
        await client.query('COMMIT');
        console.log(`Applied ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('memorae:migrations'))");
    client.release();
  }
}
