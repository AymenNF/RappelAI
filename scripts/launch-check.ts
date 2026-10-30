import { readFile } from 'node:fs/promises';
import { launchReadiness } from '../src/modules/qualification/report.js';

const [reportPath, expectedImage, flag] = process.argv.slice(2);
if (
  !reportPath ||
  !expectedImage ||
  !/^sha256:[a-f0-9]{64}$/.test(expectedImage) ||
  (flag !== undefined && flag !== '--require-ready') ||
  process.argv.length > 5
)
  throw new Error('Use launch:check -- <report.json> <expected-image-sha256> [--require-ready]');
try {
  const result = launchReadiness(
    JSON.parse(await readFile(reportPath, 'utf8')),
    JSON.parse(await readFile(new URL('../ops/launch-reviews.json', import.meta.url), 'utf8')),
    expectedImage,
  );
  console.log(JSON.stringify(result, null, 2));
  if (flag === '--require-ready' && !result.ready) process.exitCode = 1;
} catch {
  console.error('Readiness evidence missing or invalid; launch is blocked.');
  process.exitCode = 1;
}
