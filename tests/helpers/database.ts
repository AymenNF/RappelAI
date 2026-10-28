import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

export async function migrateTestSchema(pool: Pool): Promise<void> {
  const directory = new URL('../../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
    // Match the migration runner's transaction boundary, including advisory locks.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(new URL(name, directory), 'utf8'));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
