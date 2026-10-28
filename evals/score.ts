import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { loadGolden } from './lib.js';
import { decision, validateDecision } from '../src/contracts/decision.js';

const path = process.argv[2];
if (!path)
  throw new Error(
    'Usage: npm run eval -- path/to/predictions.jsonl. Real predictions required; no mock accuracy scores.',
  );
const cases = await loadGolden();
const prediction = z.object({ id: z.string(), actual: decision }).strict();
const rows = (await readFile(path, 'utf8'))
  .trim()
  .split(/\r?\n/)
  .map((line) => prediction.parse(JSON.parse(line)));
const map = new Map(rows.map((row) => [row.id, row.actual]));
if (
  map.size !== rows.length ||
  rows.length !== cases.length ||
  rows.some((row) => !cases.some((c) => c.id === row.id))
) {
  throw new Error('Predictions must contain every golden case exactly once, with no unknown IDs');
}
const failures: string[] = [];
const categories: Record<string, { passed: number; total: number }> = {};
for (const item of cases) {
  const actual = map.get(item.id);
  let valid = true;
  try {
    validateDecision(actual, new Date(item.now));
  } catch {
    valid = false;
  }
  const passed = valid && isDeepStrictEqual(actual, item.expect);
  if (!passed) failures.push(item.id);
  const group = (categories[item.category] ??= { passed: 0, total: 0 });
  group.total++;
  if (passed) group.passed++;
}
const accuracy = (cases.length - failures.length) / cases.length;
const injection = categories.injection;
const passed = accuracy >= 0.9 && (!injection || injection.passed === injection.total);
console.log(
  JSON.stringify({ cases: cases.length, accuracy, categories, failures, passed }, null, 2),
);
process.exitCode = passed ? 0 : 1;
