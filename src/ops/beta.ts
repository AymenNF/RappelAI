import 'dotenv/config';
import { writeFile, readFile } from 'node:fs/promises';
import { readSecret, assertSecretScope } from '../config/secrets.js';
import { createPool } from '../db/pool.js';
import { assertRuntimeRole } from '../db/runtime.js';
import { BetaDailyReview } from '../modules/beta/review.js';
import { BetaFeedbackControl } from '../modules/beta/control.js';
import { betaPlan } from '../modules/beta/preparation.js';
const [command, ...args] = process.argv.slice(2);
if (command === 'review') assertSecretScope('monitor');
const pool = createPool(
  readSecret(command === 'review' ? 'MONITOR_DATABASE_URL' : 'DATABASE_URL') ??
    (command === 'review' ? readSecret('DATABASE_URL') : undefined) ??
    '',
);
try {
  if (command === 'review' && args.length === 3) {
    if (process.env.DEPLOYMENT_ENV === 'staging') await assertRuntimeRole(pool, 'monitor');
    const plan = betaPlan.parse(JSON.parse(await readFile(args[2]!, 'utf8')));
    const report = await new BetaDailyReview(pool).run(args[0]!, plan.dailyModelReviewMicros);
    await writeFile(args[1]!, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(
      JSON.stringify({
        event: 'daily_review_written',
        attention: report.attention,
        launchEnabled: false,
      }),
    );
  } else if (command === 'feedback' && args[0] === 'list' && args.length <= 2) {
    console.log(JSON.stringify(await new BetaFeedbackControl(pool).list(args[1]), null, 2));
  } else if (command === 'feedback' && args[0] === 'triage' && [4, 5].includes(args.length)) {
    console.log(
      JSON.stringify(
        await new BetaFeedbackControl(pool).triage(
          args[1]!,
          Number(args[2]),
          args[3],
          args[4] ?? null,
        ),
      ),
    );
  } else throw new Error();
} catch {
  console.error(
    'Beta operation failed. Use review <UTC-day> <new-json-path> <plan-json> | feedback list [new|investigating|resolved] | feedback triage <id> <revision> <status> [resolution]. Require scoped credentials and current migrations.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
