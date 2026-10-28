import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { decision, validateDecision } from '../src/contracts/decision.js';

export const goldenCase = z
  .object({
    id: z.string().min(1),
    category: z.string().min(1),
    input: z.string().min(1),
    now: z.string().datetime({ offset: true }),
    timezone: z.string().refine((zone) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }),
    expect: decision,
  })
  .strict();
export async function loadGolden() {
  const text = await readFile(new URL('./datasets/starter.jsonl', import.meta.url), 'utf8');
  const cases = text
    .trim()
    .split(/\r?\n/)
    .map((line) => goldenCase.parse(JSON.parse(line)));
  if (!cases.length || new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error('Empty set or duplicate case IDs');
  for (const item of cases) validateDecision(item.expect, new Date(item.now));
  return cases;
}
