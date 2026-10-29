import type { PoolClient } from 'pg';
export type PrivacyCommand =
  { action: 'export' | 'offer' | 'invalid' } | { action: 'confirm'; reference: string };
export function privacyCommand(text: string | null): PrivacyCommand | null {
  if (!text || !/^(EXPORT\b|DELETE\s+ACCOUNT\b|CONFIRM\s+DELETE\b)/i.test(text.trim())) return null;
  const s = text.trim();
  if (/^EXPORT DATA$/i.test(s)) return { action: 'export' };
  if (/^DELETE ACCOUNT$/i.test(s)) return { action: 'offer' };
  const c = /^CONFIRM DELETE ([a-f0-9]{32})$/i.exec(s);
  return c ? { action: 'confirm', reference: c[1]!.toLowerCase() } : { action: 'invalid' };
}
export async function applyPrivacyCommand(
  c: PoolClient,
  eventId: string,
  userId: string,
  command: PrivacyCommand,
): Promise<string> {
  const user = (
    await c.query(
      `SELECT u.* FROM users u JOIN ingress_events e ON e.phone_number_id=u.business_phone_id AND e.sender_id=u.sender_id
    WHERE u.id=$1 AND e.id=$2 AND e.kind='inbound.message' FOR UPDATE OF u`,
      [userId, eventId],
    )
  ).rows[0];
  if (!user) throw new Error('Privacy event owner mismatch');
  const old = (
    await c.query('SELECT reply_text FROM privacy_actions WHERE event_id=$1 AND user_id=$2', [
      eventId,
      userId,
    ])
  ).rows[0];
  if (old) return old.reply_text;
  let reply = 'Use EXPORT DATA or DELETE ACCOUNT. Deletion requires a separate confirmation.';
  if (command.action === 'offer' || command.action === 'export') {
    await c.query(
      "UPDATE privacy_requests SET status='expired' WHERE user_id=$1 AND status='offered' AND expires_at<=clock_timestamp()",
      [userId],
    );
    const kind = command.action === 'offer' ? 'delete' : 'export';
    await c.query(
      `INSERT INTO privacy_requests(user_id,kind,status) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [userId, kind, kind === 'delete' ? 'offered' : 'requested'],
    );
    const r = (
      await c.query(
        "SELECT * FROM privacy_requests WHERE user_id=$1 AND kind=$2 AND status IN ('offered','requested')",
        [userId, kind],
      )
    ).rows[0];
    reply =
      kind === 'export'
        ? `Export requested (${r.id}). An administrator can produce your JSON export and deliver it through a verified private channel. No public download link is created. Export files are separate copies; export before deleting if you want one.`
        : `Delete this account and its saved reminders, lists and history? Confirmation stops pending activity immediately. Already authorized calls cannot be recalled; unresolved outcomes must be reconciled before physical removal. A keyed address fingerprint remains to reject replay. Existing export files, provider copies and backups require separate cleanup. Nothing has been deleted yet. Confirm within 15 minutes: CONFIRM DELETE ${r.reference}`;
  } else if (command.action === 'confirm') {
    const r = (
      await c.query(
        "UPDATE privacy_requests SET status='requested' WHERE user_id=$1 AND kind='delete' AND status='offered' AND reference=$2 AND expires_at>clock_timestamp() RETURNING id",
        [userId, command.reference],
      )
    ).rows[0];
    reply =
      'That deletion confirmation is unavailable or expired. Send DELETE ACCOUNT for a new confirmation.';
    if (r) {
      await c.query(
        'UPDATE users SET deletion_requested_at=clock_timestamp(),paused=true WHERE id=$1',
        [userId],
      );
      await cancelActivity(c, userId);
      reply =
        'Deletion confirmed. Pending activity is stopped. The administrator must finish removal; unresolved model/send outcomes are held for reconciliation. No further assistant messages will be sent to this account.';
    }
  }
  await c.query('INSERT INTO privacy_actions(event_id,user_id,reply_text) VALUES($1,$2,$3)', [
    eventId,
    userId,
    reply,
  ]);
  return reply;
}
/** User lock held. Never touches work rows here: a concurrent planner may hold a work lock. */
export async function cancelActivity(c: PoolClient, userId: string) {
  await c.query(
    "UPDATE reminders SET status='cancelled',schedule_version=schedule_version+1 WHERE user_id=$1 AND status='pending'",
    [userId],
  );
  await c.query(
    "UPDATE reminder_series SET status='cancelled' WHERE user_id=$1 AND status IN ('proposed','active')",
    [userId],
  );
  await c.query(
    "UPDATE reply_intents SET status='suppressed' WHERE user_id=$1 AND status='pending'",
    [userId],
  );
  await c.query(
    "UPDATE reminder_occurrences SET status='suppressed',suppression_reason='identity_changed' WHERE user_id=$1 AND status='pending'",
    [userId],
  );
  await c.query(
    "UPDATE outbound_messages SET status='suppressed',suppression_reason='identity_changed' WHERE user_id=$1 AND status='pending'",
    [userId],
  );
  await c.query(
    "UPDATE whatsapp_attempts SET recovery_state='exhausted',retry_at=NULL WHERE user_id=$1 AND recovery_state='retry_wait'",
    [userId],
  );
  await c.query(
    'UPDATE reminder_controls SET invalidated_at=clock_timestamp() WHERE user_id=$1 AND invalidated_at IS NULL',
    [userId],
  );
  for (const table of ['list_choices', 'delivery_choices'])
    await c.query(
      `UPDATE ${table} SET status='invalidated' WHERE user_id=$1 AND status='pending'`,
      [userId],
    );
  await c.query('UPDATE delivery_preferences SET active=false WHERE user_id=$1', [userId]);
}
