import { readFile } from 'node:fs/promises';
import { prepareBeta } from '../src/modules/beta/preparation.js';
const [reportPath, image, flag] = process.argv.slice(2);
try {
  if (
    !reportPath ||
    !image ||
    !/^sha256:[a-f0-9]{64}$/.test(image) ||
    (flag !== undefined && flag !== '--require-ready') ||
    process.argv.length > 5
  )
    throw new Error();
  const result = prepareBeta(
    JSON.parse(await readFile(new URL('../ops/beta-plan.json', import.meta.url), 'utf8')),
    JSON.parse(await readFile(reportPath, 'utf8')),
    JSON.parse(await readFile(new URL('../ops/launch-reviews.json', import.meta.url), 'utf8')),
    image,
  );
  console.log(JSON.stringify(result, null, 2));
  if (flag === '--require-ready' && !result.readyForOwnerLaunchReview) process.exitCode = 1;
} catch {
  console.error(
    'Beta preparation blocked. Use beta:prepare -- <qualification-report> <expected-image-id> [--require-ready]. Check evidence and plan.',
  );
  process.exitCode = 1;
}
