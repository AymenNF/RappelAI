import type { PoolClient } from 'pg';
import { hasOnboarded, type IdentityState } from '../identity/onboarding.js';
import {
  listRequest,
  matching,
  matchKey,
  preview,
  type ListRequest,
  type ListCommand,
} from './commands.js';

type List = { id: string; name: string; reference: string; revision: number };
type Item = { id: string; text: string; position: number; completed: boolean; revision: number };
type Result = {
  outcome: string;
  reply: string;
  listId?: string;
  itemId?: string;
  choiceId?: string;
  result?: unknown;
};
const help =
  'LISTS; LIST "Grocery"; ITEM "Grocery" #2; EDIT ITEM "Grocery" "milk" TO "oat milk"; DONE ITEM "Grocery" #2. Edits/completion show a choice to confirm: CHOOSE LIST <reference> <number>.';
const stale = (): Result => ({
  outcome: 'stale',
  reply: 'That list choice is unavailable or out of date. Send the original command again.',
});

async function offer(
  client: PoolClient,
  userId: string,
  request: ListRequest,
  options: { list: List; item?: Item }[],
  kind: 'lists' | 'items',
): Promise<Result> {
  if (options.length > 5)
    return {
      outcome: 'clarify',
      reply:
        'More than five matches. Use an exact list name/reference and an item number from LIST to narrow your request. Nothing was changed.',
    };
  await client.query(
    "UPDATE list_choices SET status='superseded' WHERE user_id=$1 AND status='pending'",
    [userId],
  );
  const choice = (
    await client.query(
      `INSERT INTO list_choices(user_id,kind,request,consent_grant_at,timezone_confirmed_at)
    SELECT id,$2,$3,consent_at,timezone_confirmed_at FROM users WHERE id=$1 RETURNING id,reference`,
      [userId, kind, request],
    )
  ).rows[0];
  for (const [index, option] of options.entries())
    await client.query(
      `INSERT INTO list_choice_options(user_id,choice_id,ordinal,list_id,list_revision,item_id,item_revision)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        userId,
        choice.id,
        index + 1,
        option.list.id,
        option.list.revision,
        option.item?.id ?? null,
        option.item?.revision ?? null,
      ],
    );
  const title =
    kind === 'lists'
      ? 'Which list did you mean?'
      : request.operation === 'edit'
        ? `Choose the item to change to: ${request.text}`
        : 'Choose the item to mark done:';
  const lines = options.map(
    (o, i) =>
      `${i + 1}. ${kind === 'lists' ? `${preview(o.list.name)} (@${o.list.reference})` : `#${o.item!.position} [${o.item!.completed ? 'done' : 'open'}] ${preview(o.item!.text)}`}`,
  );
  return {
    outcome: 'clarify',
    choiceId: choice.id,
    reply: `${title}\n${lines.join('\n')}\nNothing changed yet. Reply CHOOSE LIST ${choice.reference} <number> within 15 minutes.${kind === 'items' ? ` Read full text with ITEM @${options[0]!.list.reference} #<item number>.` : ''}`,
  };
}

async function withinList(
  client: PoolClient,
  userId: string,
  list: List,
  request: ListRequest,
): Promise<Result> {
  if (request.operation === 'read') {
    const rows = (
      await client.query<Item>(
        'SELECT id,text,position,completed,revision FROM list_items WHERE user_id=$1 AND list_id=$2 AND position>$3 ORDER BY position LIMIT 11',
        [userId, list.id, request.after],
      )
    ).rows;
    const page = rows.slice(0, 10);
    return {
      outcome: 'read',
      listId: list.id,
      reply: `${preview(list.name, 200)} (@${list.reference})\n${page.length ? page.map((i) => `#${i.position} [${i.completed ? 'done' : 'open'}] ${preview(i.text)}`).join('\n') : request.after ? 'No more items.' : 'This list is empty.'}\nRead full text: ITEM @${list.reference} #<number>.${rows.length > 10 ? `\nMore: LIST @${list.reference} AFTER ${page.at(-1)!.position}` : ''}`,
    };
  }
  let rows: Item[];
  if (typeof request.selector === 'number')
    rows = (
      await client.query<Item>(
        'SELECT id,text,position,completed,revision FROM list_items WHERE user_id=$1 AND list_id=$2 AND position=$3',
        [userId, list.id, request.selector],
      )
    ).rows;
  else {
    const all = (
      await client.query<Item>(
        'SELECT id,text,position,completed,revision FROM list_items WHERE user_id=$1 AND list_id=$2 ORDER BY position LIMIT 1001',
        [userId, list.id],
      )
    ).rows;
    if (all.length > 1000)
      return {
        outcome: 'clarify',
        listId: list.id,
        reply: `This list is too large for a name search. Read LIST @${list.reference} and use an item number. Nothing was changed.`,
      };
    rows = matching(all, request.selector!, (i) => i.text);
  }
  if (!rows.length)
    return {
      outcome: 'not_found',
      listId: list.id,
      reply:
        'No matching item in that list. Use LIST to check its item numbers. Nothing was changed.',
    };
  if (request.operation === 'item') {
    const item = rows[0]!;
    return {
      outcome: 'read',
      listId: list.id,
      itemId: item.id,
      reply: `${preview(list.name, 200)} — #${item.position} [${item.completed ? 'done' : 'open'}]\n${item.text}`,
    };
  }
  return offer(
    client,
    userId,
    request,
    rows.map((item) => ({ list, item })),
    'items',
  );
}

async function resolve(client: PoolClient, userId: string, request: ListRequest): Promise<Result> {
  const exact = (
    await client.query<List>(
      `SELECT id,name,reference,revision FROM lists WHERE user_id=$1 AND ${request.byReference ? 'reference' : 'name_key'}=$2 FOR UPDATE`,
      [userId, request.byReference ? request.list.slice(1) : matchKey(request.list)],
    )
  ).rows[0];
  if (exact) return withinList(client, userId, exact, request);
  if (request.byReference)
    return { outcome: 'not_found', reply: 'No matching list. Use LISTS to see your saved lists.' };
  const all = (
    await client.query<List>(
      'SELECT id,name,reference,revision FROM lists WHERE user_id=$1 ORDER BY name_key,id LIMIT 1001',
      [userId],
    )
  ).rows;
  if (all.length > 1000)
    return {
      outcome: 'clarify',
      reply:
        'Too many lists for a name search. Use LISTS and a list reference. Nothing was changed.',
    };
  const matches = matching(all, request.list, (l) => l.name);
  if (!matches.length)
    return { outcome: 'not_found', reply: 'No matching list. Use LISTS to see your saved lists.' };
  return offer(
    client,
    userId,
    request,
    matches.map((list) => ({ list })),
    'lists',
  );
}

async function choose(
  client: PoolClient,
  userId: string,
  reference: string,
  ordinal: number,
): Promise<Result> {
  const choice = (
    await client.query(
      `SELECT c.* FROM list_choices c JOIN users u ON u.id=c.user_id
    WHERE c.user_id=$1 AND c.reference=$2 AND c.status='pending' AND c.expires_at>clock_timestamp()
      AND c.consent_grant_at=u.consent_at AND c.timezone_confirmed_at=u.timezone_confirmed_at FOR UPDATE OF c`,
      [userId, reference],
    )
  ).rows[0];
  if (!choice) return stale();
  const option = (
    await client.query(
      'SELECT * FROM list_choice_options WHERE user_id=$1 AND choice_id=$2 AND ordinal=$3',
      [userId, choice.id, ordinal],
    )
  ).rows[0];
  if (!option) return stale();
  const list = (
    await client.query<List>(
      'SELECT id,name,reference,revision FROM lists WHERE user_id=$1 AND id=$2 FOR UPDATE',
      [userId, option.list_id],
    )
  ).rows[0];
  // Query freshness after the list lock too: append may hold it without the user lock.
  const fresh = (
    await client.query(
      'SELECT expires_at>clock_timestamp() AS fresh FROM list_choices WHERE id=$1',
      [choice.id],
    )
  ).rows[0].fresh;
  if (!list || list.revision !== option.list_revision || !fresh) {
    await client.query("UPDATE list_choices SET status='invalidated' WHERE id=$1", [choice.id]);
    return stale();
  }
  const request = listRequest.parse(choice.request);
  await client.query("UPDATE list_choices SET status='consumed' WHERE id=$1", [choice.id]);
  if (choice.kind === 'lists') {
    const result = await withinList(client, userId, list, request);
    return { ...result, choiceId: result.choiceId ?? choice.id };
  }
  const item = (
    await client.query<Item>(
      'SELECT id,text,position,completed,revision FROM list_items WHERE user_id=$1 AND list_id=$2 AND id=$3 FOR UPDATE',
      [userId, list.id, option.item_id],
    )
  ).rows[0];
  if (!item || item.revision !== option.item_revision) return stale();
  if (request.operation !== 'edit' && request.operation !== 'complete')
    throw new Error('Invalid list mutation choice');
  const text = request.operation === 'edit' ? request.text! : item.text;
  const completed = request.operation === 'complete' ? true : item.completed;
  if (text === item.text && completed === item.completed)
    return {
      outcome: 'noop',
      choiceId: choice.id,
      listId: list.id,
      itemId: item.id,
      reply: `#${item.position} is already ${completed ? 'done' : 'saved with that text'}. Nothing changed.`,
    };
  const updated = (
    await client.query<Item>(
      'UPDATE list_items SET text=$4,completed=$5 WHERE user_id=$1 AND list_id=$2 AND id=$3 AND revision=$6 RETURNING id,text,position,completed,revision',
      [userId, list.id, item.id, text, completed, item.revision],
    )
  ).rows[0];
  if (!updated) throw new Error('List item changed while locked');
  // A saved add confirmation must not describe an item whose content has since changed.
  await client.query(
    "UPDATE reply_intents SET status='suppressed' WHERE user_id=$1 AND event_id=(SELECT source_event_id FROM list_items WHERE user_id=$1 AND id=$2) AND status='pending'",
    [userId, item.id],
  );
  return {
    outcome: request.operation === 'edit' ? 'edited' : 'completed',
    choiceId: choice.id,
    listId: list.id,
    itemId: item.id,
    reply:
      request.operation === 'edit'
        ? `Updated #${item.position} in ${preview(list.name, 200)} to:\n${updated.text}${updated.completed ? '\nIt remains marked done.' : ''}`
        : `Marked #${item.position} in ${preview(list.name, 200)} done: ${preview(updated.text)}`,
    result: {
      before: { text: item.text, completed: item.completed, revision: item.revision },
      after: { text: updated.text, completed: updated.completed, revision: updated.revision },
    },
  };
}

/** Atomic with identity result and work acknowledgement. Only trusted sender-derived IDs enter here. */
export async function applyListCommand(
  client: PoolClient,
  eventId: string,
  userId: string,
  command: ListCommand,
): Promise<string> {
  const user = (
    await client.query(
      `SELECT u.* FROM users u JOIN ingress_events e ON e.phone_number_id=u.business_phone_id AND e.sender_id=u.sender_id
    WHERE u.id=$1 AND e.id=$2 AND e.kind='inbound.message' FOR UPDATE OF u`,
      [userId, eventId],
    )
  ).rows[0];
  if (!user) throw new Error('List event owner mismatch');
  const old = (
    await client.query('SELECT reply_text FROM list_actions WHERE user_id=$1 AND event_id=$2', [
      userId,
      eventId,
    ])
  ).rows[0];
  if (old) return old.reply_text as string;
  const earlier =
    (
      await client.query(
        `SELECT 1 FROM work_outbox q JOIN ingress_events e ON e.id=q.event_id
    WHERE e.phone_number_id=$1 AND e.sender_id=$2 AND e.sequence_no<(SELECT sequence_no FROM ingress_events WHERE id=$3)
      AND q.stage IN ('action','execution') AND q.status<>'completed' LIMIT 1`,
        [user.business_phone_id, user.sender_id, eventId],
      )
    ).rowCount !== 0;
  let result: Result;
  if (!hasOnboarded(user as IdentityState))
    result = {
      outcome: 'blocked',
      reply: 'Confirm consent and timezone before using list commands.',
    };
  else if (command.kind === 'invalid') result = { outcome: 'invalid', reply: help };
  else if (
    earlier &&
    (command.kind === 'choose' ||
      (command.kind === 'request' && ['edit', 'complete'].includes(command.request.operation)))
  )
    result = {
      outcome: 'blocked',
      reply:
        'An earlier request is still being processed. Retry this list command after it finishes. Nothing was changed.',
    };
  else if (command.kind === 'choose')
    result = await choose(client, userId, command.reference, command.option);
  else if (command.kind === 'request') {
    const request = listRequest.parse(command.request);
    if (request.operation === 'edit' || request.operation === 'complete')
      await client.query(
        "UPDATE list_choices SET status='superseded' WHERE user_id=$1 AND status='pending'",
        [userId],
      );
    result = await resolve(client, userId, request);
  } else if (
    command.after &&
    !(
      await client.query('SELECT 1 FROM lists WHERE user_id=$1 AND reference=$2', [
        userId,
        command.after,
      ])
    ).rowCount
  )
    result = {
      outcome: 'not_found',
      reply: 'That list page is unavailable. Start again with LISTS.',
    };
  else {
    const rows = (
      await client.query<List>(
        'SELECT id,name,reference,revision FROM lists WHERE user_id=$1 AND reference>$2 ORDER BY reference LIMIT 11',
        [userId, command.after ?? ''],
      )
    ).rows;
    const page = rows.slice(0, 10);
    result = {
      outcome: 'read',
      reply: page.length
        ? `Your lists:\n${page.map((l) => `${preview(l.name)} — LIST @${l.reference}`).join('\n')}${rows.length > 10 ? `\nMore: LISTS AFTER ${page.at(-1)!.reference}` : ''}`
        : command.after
          ? 'No more lists.'
          : 'You have no saved lists yet.',
    };
  }
  if (earlier && result.outcome === 'read')
    result.reply += '\nThis shows saved items only; an earlier request is still being processed.';
  await client.query(
    `INSERT INTO list_actions(event_id,user_id,choice_id,list_id,item_id,outcome,reply_text,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      eventId,
      userId,
      result.choiceId ?? null,
      result.listId ?? null,
      result.itemId ?? null,
      result.outcome,
      result.reply,
      result.result ?? {},
    ],
  );
  return result.reply;
}
