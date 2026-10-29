import 'dotenv/config';
import { setTimeout } from 'node:timers/promises';
import { createPool } from '../src/db/pool.js';
import { OperationsControl, queueKind } from '../src/modules/telemetry/control.js';
import { rules, type AlertKey } from '../src/modules/telemetry/rules.js';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL administrator required');
const pool = createPool(process.env.DATABASE_URL);
const ops = new OperationsControl(pool);
const [command, ...args] = process.argv.slice(2);
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
try {
  if (command === 'status' && !args.length)
    console.log(JSON.stringify(await ops.status(), null, 2));
  else if (command === 'check' && !args.length)
    console.log(JSON.stringify(await ops.check(), null, 2));
  else if (command === 'watch' && !args.length) {
    // Independent of the worker: it can detect a stopped worker. No external notification transport.
    while (!controller.signal.aborted) {
      try {
        const result = await ops.check();
        console.log(
          JSON.stringify({
            event: 'monitor_observed',
            observedAt: result.snapshot.observedAt,
            active: Object.values(result.snapshot.signals).filter((n) => n > 0).length,
          }),
        );
        for (const alert of result.changes)
          console.log(JSON.stringify({ event: 'operational_alert', ...alert }));
      } catch {
        console.error(
          JSON.stringify({
            event: 'monitor_failed',
            severity: 'critical',
            action:
              'Monitoring data unavailable. Check database connectivity and monitor credentials; no recovery is asserted.',
          }),
        );
      }
      await setTimeout(15000, undefined, { signal: controller.signal }).catch(() => {});
    }
  } else if (
    command === 'expect' &&
    args.length === 2 &&
    ['api', 'worker'].includes(args[0]!) &&
    ['on', 'off'].includes(args[1]!)
  ) {
    await ops.expect(args[0] as 'api' | 'worker', args[1] === 'on');
    console.log(
      JSON.stringify({
        event: 'monitor_expectation_updated',
        component: args[0],
        enabled: args[1] === 'on',
      }),
    );
  } else if (command === 'ack' && args.length === 2 && Object.hasOwn(rules, args[0]!)) {
    console.log(
      JSON.stringify({ acknowledged: await ops.acknowledge(args[0] as AlertKey, Number(args[1])) }),
    );
  } else if (command === 'queue' && [1, 2, 4].includes(args.length)) {
    console.log(
      JSON.stringify(
        await ops.queue(
          queueKind.parse(args[0]),
          args[1] === undefined ? 100 : Number(args[1]),
          args.length === 4 ? { createdAt: args[2]!, id: args[3]! } : undefined,
        ),
        null,
        2,
      ),
    );
  } else throw new Error('Invalid operations command');
} catch {
  // Do not print database URLs, errors, payloads or operator-supplied arguments.
  console.error(
    'Operations command failed. Use status | check | watch | expect <api|worker> <on|off> | ack <key> <generation> | queue <work|model|send|receipt|privacy> [limit [after-time after-id]]. Check administrator access and migrations.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
