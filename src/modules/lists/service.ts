import type { PoolClient } from 'pg';
import { listArgs } from '../../contracts/decision.js';
import { actionResult, type ActionResult, type ActionSource } from '../processing/results.js';

export function normalizeListName(name: string): { name: string; key: string } {
  const normalized = name.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!normalized || normalized.length > 200) throw new Error('Invalid normalized list name');
  const key = normalized.toLowerCase();
  if (key.length > 200) throw new Error('Invalid normalized list key');
  return { name: normalized, key };
}
export async function addListItem(
  client: PoolClient,
  source: ActionSource,
  input: unknown,
): Promise<ActionResult> {
  const args = listArgs.parse(input);
  const name = normalizeListName(args.list_name);
  const old = (
    await client.query(
      `SELECT i.*,l.name AS list_name FROM list_items i JOIN lists l ON l.id=i.list_id AND l.user_id=i.user_id
    WHERE i.user_id=$1 AND i.action_key=$2`,
      [source.userId, source.key],
    )
  ).rows[0];
  if (old)
    return actionResult.parse({
      tool: 'add_list_item',
      id: old.id,
      listId: old.list_id,
      listName: old.list_name,
      text: old.text,
      position: old.position,
    });
  await client.query(
    'INSERT INTO lists(user_id,name,name_key) VALUES($1,$2,$3) ON CONFLICT(user_id,name_key) DO NOTHING',
    [source.userId, name.name, name.key],
  );
  const list = (
    await client.query('SELECT id,name FROM lists WHERE user_id=$1 AND name_key=$2 FOR UPDATE', [
      source.userId,
      name.key,
    ])
  ).rows[0];
  const row = (
    await client.query(
      `INSERT INTO list_items(user_id,list_id,source_event_id,plan_version,action_key,text,position)
    SELECT $1,$2,$3,$4,$5,$6,COALESCE(MAX(position),0)+1 FROM list_items WHERE list_id=$2 AND user_id=$1 RETURNING *`,
      [source.userId, list.id, source.eventId, source.version, source.key, args.text],
    )
  ).rows[0];
  return actionResult.parse({
    tool: 'add_list_item',
    id: row.id,
    listId: list.id,
    listName: list.name,
    text: row.text,
    position: row.position,
  });
}
