import type { Pool, PoolClient } from 'pg';
import { assertRuntimeRole } from './runtime.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** userId must come from authenticated server context, never a request/model field. */
export async function withTenant<T>(
  pool: Pool,
  userId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!uuid.test(userId)) throw new Error('Invalid authenticated tenant ID');
  await assertRuntimeRole(pool, 'tenant');
  const client = await pool.connect();
  let discard = false;
  try {
    // Clear accidental session-level leftovers before installing transaction-local context.
    await client.query("SELECT set_config('app.user_id','',false)");
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    // Also clear if trusted callback code accidentally changed session scope.
    try {
      await client.query("SELECT set_config('app.user_id','',false)");
    } catch {
      discard = true;
    }
    client.release(discard);
  }
}
