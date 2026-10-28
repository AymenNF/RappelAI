import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { PostgresIngressStore } from '../src/db/ingress-store.js';
import { IdentityProcessor } from '../src/modules/identity/store.js';

if (process.env.NODE_ENV === 'production')
  throw new Error('Local simulator cannot run in production');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = createPool(process.env.DATABASE_URL);
const store = new PostgresIngressStore(pool);
const processor = new IdentityProcessor(pool);
const sender = `local-${randomUUID()}`;
const terminal = createInterface({ input: process.stdin, output: process.stdout });
console.log('Synthetic local onboarding chat. No WhatsApp or model calls. Type /quit to leave.');
try {
  while (true) {
    const body = await terminal.question('You: ');
    if (body === '/quit') break;
    const key = randomUUID();
    await store.persist([
      {
        eventKey: key,
        kind: 'inbound.message',
        phoneNumberId: 'local-simulator',
        providerMessageId: key,
        senderId: sender,
        payload: { type: 'text', timestamp: String(Math.floor(Date.now() / 1000)), text: { body } },
      },
    ]);
    // Processes queued onboarding too; a separately running worker is safe.
    while (await processor.processNext()) {
      /* drain local onboarding work */
    }
    const result = await pool.query(
      `SELECT r.reply_text,r.disposition FROM identity_results r
      JOIN ingress_events e ON e.id=r.event_id WHERE e.event_key=$1`,
      [key],
    );
    const row = result.rows[0];
    console.log(
      `Assistant: ${
        row?.reply_text ??
        (row?.disposition === 'ready'
          ? 'Ready for future processing; no model or reminder service connected.'
          : 'Paused or processing; no reply.')
      }`,
    );
  }
} finally {
  terminal.close();
  await pool.end();
}
