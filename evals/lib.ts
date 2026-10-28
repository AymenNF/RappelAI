import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { decision, validateDecision } from '../src/contracts/decision.js';
import { hashText } from '../src/modules/processing/prompt.js';
import type { ModelContext } from '../src/modules/processing/model.js';
export const DATASET_VERSION = 'm1-v1';
export const goldenCase = z
  .object({
    id: z.string().regex(/^[a-z]+-\d{3}$/),
    category: z.enum([
      'reminder',
      'timezone',
      'list',
      'ambiguity',
      'scope',
      'injection',
      'noop',
      'multi',
    ]),
    input: z.string().min(1).max(16000),
    now: z.string().datetime({ offset: true }),
    processingTime: z.string().datetime({ offset: true }).optional(),
    timezone: z.string().refine((zone) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }),
    split: z.enum(['development', 'holdout']),
    expect: decision,
    review: z
      .object({
        kind: z.literal('agent'),
        reviewer: z.literal('Codex'),
        date: z.literal('2026-10-28'),
        rationale: z.string().min(20),
      })
      .strict(),
  })
  .strict();
export type GoldenCase = z.infer<typeof goldenCase>;
export function parseCases(text: string): GoldenCase[] {
  const cases = text
    .trim()
    .split(/\r?\n/)
    .map((line) => goldenCase.parse(JSON.parse(line)));
  if (!cases.length || new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error('Empty dataset or duplicate IDs');
  for (const item of cases) {
    if (Date.parse(item.processingTime ?? item.now) < Date.parse(item.now))
      throw new Error('Processing precedes reference time');
    validateDecision(item.expect, new Date(item.processingTime ?? item.now));
  }
  return cases;
}
export async function loadDataset() {
  const text = await readFile(new URL('./datasets/m1-v1.jsonl', import.meta.url), 'utf8');
  const cases = parseCases(text);
  const manifest = z
    .object({
      version: z.literal(DATASET_VERSION),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      count: z.literal(60),
      review: z.literal('agent-reviewed; human review pending'),
    })
    .strict()
    .parse(
      JSON.parse(
        await readFile(new URL('./datasets/m1-v1.manifest.json', import.meta.url), 'utf8'),
      ),
    );
  const hash = hashText(text.replace(/\r\n/g, '\n'));
  if (
    hash !== manifest.sha256 ||
    cases.length !== manifest.count ||
    cases.filter((c) => c.split === 'holdout').length !== 12
  )
    throw new Error('Dataset manifest/count/split mismatch');
  const counts = Object.fromEntries(
    goldenCase.shape.category.options.map((category) => [
      category,
      cases.filter((c) => c.category === category).length,
    ]),
  );
  if (Object.values(counts).some((count) => count < 4))
    throw new Error('Missing category coverage');
  return { version: DATASET_VERSION, hash, cases, review: manifest.review };
}
export async function loadGolden() {
  return (await loadDataset()).cases;
}
// Explicit allowlist: labels, IDs, category, split and review metadata never reach the model.
export function modelContext(item: GoldenCase): ModelContext {
  return {
    message: item.input,
    timezone: item.timezone,
    referenceTime: new Date(item.now),
    processingTime: new Date(item.processingTime ?? item.now),
  };
}
