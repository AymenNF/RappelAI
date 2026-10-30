// Disposable lab only. Inject failures around real services; no production fault hooks.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { readSecret } from '../config/secrets.js';
import { createPool } from '../db/pool.js';
import { assertRuntimeRole } from '../db/runtime.js';
import { PostgresIngressStore } from '../db/ingress-store.js';
import { CONSENT_VERSION } from '../modules/identity/onboarding.js';
import { WorkQueue } from '../modules/processing/leases.js';
import { ExecutionProcessor } from '../modules/processing/execution.js';
import { PROMPT_SHA256 } from '../modules/processing/prompt.js';
import { TestReplySender } from '../modules/whatsapp/dispatch.js';
import { DeliveryRecovery } from '../modules/whatsapp/recovery.js';

const run = process.env.QUALIFICATION_RUN;
if (!run || !/^[a-f0-9]{12}$/.test(run) || process.env.STAGING_SYNTHETIC_ONLY !== 'true')
  throw new Error('Disposable lab required');
const prefix = `memorae-qual-${run}`;
const [mode, key] = process.argv.slice(2);
if (mode === 'provider') {
  let accepted = 0;
  createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/count') {
      res.end(String(accepted));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/send') {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    req.on('end', () => {
      accepted++;
      console.log('synthetic_provider_accepted');
    });
    // Deliberately leave the response open after acceptance to exercise a lost acknowledgement.
  }).listen(3001, '0.0.0.0');
} else {
  const adminMode = mode === 'seed';
  const url = new URL(readSecret(adminMode ? 'DATABASE_URL' : 'WORKER_DATABASE_URL') ?? '');
  if (url.hostname !== `${prefix}-postgres` || url.pathname !== '/memorae_staging')
    throw new Error('Disposable database identity mismatch');
  const pool = createPool(url.toString());
  pool.on('error', () => {});
  try {
    if (!adminMode) await assertRuntimeRole(pool, 'worker');
    if (mode === 'seed') {
      if (!['before', 'after', 'send'].includes(key ?? '')) throw new Error('Invalid seed');
      const phone = key === 'send' ? '12345' : 'staging-synthetic';
      const sender = key === 'send' ? '15555550101' : `qual-${key}`;
      await new PostgresIngressStore(pool).persist([
        {
          eventKey: `qual-${key}`,
          kind: 'inbound.message',
          phoneNumberId: phone,
          providerMessageId: `qual-${key}`,
          senderId: sender,
          payload: {
            type: 'text',
            timestamp: String(Math.floor(Date.now() / 1000)),
            text: { body: 'Synthetic qualification' },
          },
        },
      ]);
      const event = (
        await pool.query('SELECT id FROM ingress_events WHERE event_key=$1', [`qual-${key}`])
      ).rows[0].id;
      const user = (
        await pool.query(
          `INSERT INTO users(business_phone_id,sender_id,consent_version,consent_at,paused,timezone,timezone_confirmed_at,window_expires_at)
        VALUES($1,$2,$3,$4,false,'UTC',$4,clock_timestamp()+interval '1 hour') RETURNING *`,
          [phone, sender, CONSENT_VERSION, new Date()],
        )
      ).rows[0];
      await pool.query(
        `INSERT INTO identity_results(event_id,user_id,disposition,reply_text,consent_grant_at,timezone_confirmed_at)
        VALUES($1,$2,'ready','Synthetic reply',$3,$4)`,
        [event, user.id, user.consent_at, user.timezone_confirmed_at],
      );
      if (key === 'send') {
        await pool.query(
          "UPDATE work_outbox SET status='completed',completed_at=clock_timestamp() WHERE event_id=$1",
          [event],
        );
        await pool.query('UPDATE usage_policy SET enabled=true');
      } else {
        const decision = {
          behavior: 'execute',
          calls: [
            { tool: 'add_list_item', args: { list_name: 'Qualification', text: `item-${key}` } },
          ],
        };
        await pool.query(
          `INSERT INTO action_plans(event_id,user_id,schema_version,decision,provider,model,prompt_version,prompt_sha256,input_sha256,input_tokens,output_tokens,latency_ms,reference_at,validated_at,consent_grant_at,timezone_confirmed_at,timezone)
          VALUES($1,$2,'decision-v1',$3,'fake','test-v1','intent-v1',$4,$4,0,0,0,clock_timestamp(),clock_timestamp(),$5,$6,'UTC')`,
          [event, user.id, decision, PROMPT_SHA256, user.consent_at, user.timezone_confirmed_at],
        );
        await pool.query("UPDATE work_outbox SET stage='execution' WHERE event_id=$1", [event]);
      }
      console.log(JSON.stringify({ eventId: event }));
    } else if (mode === 'before' || mode === 'after') {
      const queue = new WorkQueue(pool),
        executor = new ExecutionProcessor();
      const lease = await queue.claim('execution', 'qualification-crash', 10000);
      assert.ok(lease);
      await queue.commit(lease, async (c) => {
        const result = await executor.apply(c, lease);
        assert.equal(
          (
            await c.query('SELECT count(*)::int AS n FROM action_receipts WHERE event_id=$1', [
              lease.event_id,
            ])
          ).rows[0].n,
          1,
        );
        if (mode === 'before') {
          console.log('effects_uncommitted');
          await setTimeout(120000);
        }
        return result;
      });
      console.log('effects_committed');
      await setTimeout(120000);
    } else if (mode === 'send' || mode === 'recover-send') {
      if (mode === 'recover-send') await new DeliveryRecovery(pool).recover();
      const event = (await pool.query("SELECT id FROM ingress_events WHERE event_key='qual-send'"))
        .rows[0].id;
      const sender = new TestReplySender(
        pool,
        {
          send: async (_message, signal) => {
            await fetch(`http://${prefix}-provider:3001/send`, {
              method: 'POST',
              body: 'synthetic',
              signal,
            });
            return { state: 'accepted', providerMessageId: 'synthetic-provider-id' };
          },
        },
        { enabled: true, phoneNumberId: '12345', recipients: ['15555550101'], timeoutMs: 10000 },
      );
      console.log(JSON.stringify(await sender.send(event)));
    } else throw new Error('Invalid qualification phase');
  } finally {
    await pool.end();
  }
}
