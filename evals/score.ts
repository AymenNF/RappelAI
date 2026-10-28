import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { decision } from '../src/contracts/decision.js';
import { loadGolden } from './lib.js';
import { score, type Prediction } from './metrics.js';
import { verifyReport } from './reports.js';
const path = process.argv[2];
if (!path || process.argv.length !== 3)
  throw new Error('Usage: npm run eval -- <run-directory | imported-predictions.jsonl>');
if ((await stat(path)).isDirectory()) {
  const result = await verifyReport(path);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.gatePassed ? 0 : 1;
} else {
  // Legacy external predictions remain supported, but carry no trusted run provenance.
  const cases = await loadGolden();
  const schema = z.object({ id: z.string(), actual: decision }).strict();
  const text = await readFile(path, 'utf8');
  const rows: Prediction[] = text.trim()
    ? text
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const value = schema.parse(JSON.parse(line));
          return {
            ...value,
            error: null,
            provider: 'imported',
            model: 'unknown',
            responseId: null,
            inputTokens: null,
            outputTokens: null,
            latencyMs: 0,
            inputHash: '0'.repeat(64),
          };
        })
    : [];
  const metrics = score(cases, rows, 'imported');
  console.log(JSON.stringify({ source: 'imported', gatePassed: false, metrics }, null, 2));
  process.exitCode = metrics.qualityPassed ? 0 : 1;
}
