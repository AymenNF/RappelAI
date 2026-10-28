import type { PoolClient } from 'pg';
import { decision } from '../../contracts/decision.js';
import { hasOnboarded, type IdentityState } from '../identity/onboarding.js';
import { createReminder } from '../reminders/service.js';
import { addListItem, normalizeListName } from '../lists/service.js';
import { PermanentWorkError, type WorkHandler } from './runner.js';
import { LeaseLostError, type WorkLease, type WorkTransition } from './leases.js';
import { actionKey, type StoredPlan } from './plans.js';
import { SCHEMA_VERSION } from './prompt.js';
import { actionResult, successReply, type ActionResult } from './results.js';

type Outcome = 'executed' | 'blocked' | 'expired' | 'clarify' | 'noop' | 'unsupported';
export class ExecutionProcessor implements WorkHandler<null> {
  async prepare(lease: WorkLease, signal: AbortSignal): Promise<null> {
    if (lease.stage !== 'execution') throw new PermanentWorkError('Expected execution stage');
    if (signal.aborted) throw new LeaseLostError();
    return null;
  }
  async apply(client: PoolClient, lease: WorkLease): Promise<WorkTransition> {
    if (lease.stage !== 'execution') throw new PermanentWorkError('Expected execution stage');
    if (
      (
        await client.query('SELECT event_id FROM plan_executions WHERE event_id=$1', [
          lease.event_id,
        ])
      ).rowCount
    )
      return { nextStage: null };
    const plan = (
      await client.query('SELECT * FROM action_plans WHERE event_id=$1', [lease.event_id])
    ).rows[0];
    if (!plan || plan.version !== 1 || plan.schema_version !== SCHEMA_VERSION)
      throw new PermanentWorkError('Missing or unsupported plan');
    const parsed = decision.safeParse(plan.decision);
    if (!parsed.success) throw new PermanentWorkError('Invalid persisted decision');
    const user = (
      await client.query(
        `SELECT u.*,p.consent_grant_at=u.consent_at AND p.timezone_confirmed_at=u.timezone_confirmed_at
      AND p.timezone=u.timezone AS matches_snapshot FROM users u JOIN action_plans p ON p.user_id=u.id
      WHERE p.event_id=$1 FOR UPDATE OF u`,
        [lease.event_id],
      )
    ).rows[0];
    if (!user) throw new PermanentWorkError('Plan owner missing');
    // Query time after acquiring the user lock; a blocked lock must not freeze date validation.
    const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    let outcome: Outcome = parsed.data.behavior === 'execute' ? 'executed' : parsed.data.behavior;
    let reason: string = outcome;
    let body = '';
    if (!hasOnboarded(user as IdentityState) || !user.matches_snapshot) {
      outcome = 'blocked';
      reason = 'identity_changed';
      body = 'This request was not applied because consent or timezone settings changed.';
    } else if (
      parsed.data.calls.some(
        (call) => call.tool === 'create_reminder' && Date.parse(call.args.due_at) <= now.getTime(),
      )
    ) {
      outcome = 'expired';
      reason = 'reminder_expired';
      body =
        'That reminder time has passed. Please send a new future date and time. Nothing from this request was saved.';
    } else if (
      parsed.data.calls.some(
        (call) => call.tool === 'create_reminder' && call.args.delivery_mode === 'digest',
      )
    ) {
      outcome = 'unsupported';
      reason = 'digest_unavailable';
      body =
        'Digest reminders are not available yet. Please choose an exact date and time. Nothing from this request was saved.';
    }
    if (outcome === 'executed') {
      // Validate normalized names before any mutation; the entire plan is all-or-nothing.
      try {
        for (const call of parsed.data.calls)
          if (call.tool === 'add_list_item') normalizeListName(call.args.list_name);
      } catch {
        throw new PermanentWorkError('Invalid normalized list name');
      }
      const stored: StoredPlan = { ...plan, decision: parsed.data };
      const results: ActionResult[] = [];
      for (const [index, call] of parsed.data.calls.entries()) {
        const key = actionKey(stored, index);
        const receipt = (
          await client.query('SELECT * FROM action_receipts WHERE action_key=$1 AND user_id=$2', [
            key,
            plan.user_id,
          ])
        ).rows[0];
        if (receipt) {
          results.push(actionResult.parse(receipt.result));
          continue;
        }
        const source = {
          userId: plan.user_id,
          eventId: lease.event_id,
          version: plan.version,
          key,
        };
        const result =
          call.tool === 'create_reminder'
            ? await createReminder(client, source, call.args, plan.timezone)
            : await addListItem(client, source, call.args);
        await client.query(
          `INSERT INTO action_receipts(action_key,user_id,event_id,plan_version,action_index,tool,reminder_id,list_item_id,result)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            key,
            plan.user_id,
            lease.event_id,
            plan.version,
            index,
            call.tool,
            result.tool === 'create_reminder' ? result.id : null,
            result.tool === 'add_list_item' ? result.id : null,
            result,
          ],
        );
        results.push(result);
      }
      body = successReply(results);
    } else if (!body) {
      body =
        outcome === 'clarify'
          ? 'What would you like to save? For a reminder, include the title, date and time; for a list item, include the item and list name.'
          : outcome === 'unsupported'
            ? 'I can save one-time reminders and add items to named lists. This request is not supported yet.'
            : 'No reminder or list change was requested.';
    }
    await client.query(
      'INSERT INTO plan_executions(event_id,user_id,plan_version,outcome,reason_code) VALUES($1,$2,$3,$4,$5)',
      [lease.event_id, plan.user_id, plan.version, outcome, reason],
    );
    await client.query(
      `INSERT INTO reply_intents(user_id,event_id,body,status,consent_grant_at,timezone_confirmed_at)
      VALUES($1,$2,$3,$4,$5,$6)`,
      [
        plan.user_id,
        lease.event_id,
        body,
        outcome === 'blocked' ? 'suppressed' : 'pending',
        plan.consent_grant_at,
        plan.timezone_confirmed_at,
      ],
    );
    return { nextStage: null };
  }
}
