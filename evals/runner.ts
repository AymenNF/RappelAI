import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ModelAdapter, ModelError, type ModelTransport } from '../src/modules/processing/model.js';
import {
  INTENT_PROMPT,
  PROMPT_SHA256,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  hashText,
} from '../src/modules/processing/prompt.js';
import { decisionJsonSchema } from '../src/modules/processing/openai.js';
import { modelContext, type GoldenCase } from './lib.js';
import { score, type Prediction } from './metrics.js';

export interface EvaluationOptions {
  directory: string;
  cases: GoldenCase[];
  datasetVersion: string;
  datasetHash: string;
  source: 'openai' | 'mock';
  transport: ModelTransport;
  timeoutMs: number;
  maxCalls: number;
  split: 'all' | 'development' | 'holdout';
  gitRevision: string | null;
  gitDirty: boolean;
  signal?: AbortSignal;
}
export async function runEvaluation(options: EvaluationOptions) {
  if (!Number.isInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 60)
    throw new Error('maxCalls must be 1..60');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120000)
    throw new Error('Invalid timeout');
  const cases = options.cases.filter((c) => options.split === 'all' || c.split === options.split);
  if (!cases.length || new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error('Invalid selected cases');
  const runId = randomUUID(),
    startedAt = new Date().toISOString();
  await mkdir(options.directory, { recursive: true });
  const directory = join(options.directory, runId);
  await mkdir(directory);
  const manifest = {
    formatVersion: 'eval-report-v1',
    scorerVersion: 'decision-score-v1',
    runId,
    startedAt,
    source: options.source,
    dataset: {
      version: options.datasetVersion,
      sha256: options.datasetHash,
      split: options.split,
      caseIds: cases.map((c) => c.id),
    },
    prompt: { version: PROMPT_VERSION, sha256: PROMPT_SHA256 },
    schema: { version: SCHEMA_VERSION, sha256: hashText(JSON.stringify(decisionJsonSchema)) },
    provider: options.transport.provider,
    requestedModel: options.transport.model,
    limits: {
      maxCalls: options.maxCalls,
      timeoutMs: options.timeoutMs,
      maxOutputTokens: options.transport.maxOutputTokens ?? null,
    },
    code: { revision: options.gitRevision, dirty: options.gitDirty },
    nodeVersion: process.version,
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
  await writeFile(join(directory, 'prompt.txt'), INTENT_PROMPT, { flag: 'wx' });
  await writeFile(
    join(directory, 'schema.json'),
    JSON.stringify(decisionJsonSchema, null, 2) + '\n',
    { flag: 'wx' },
  );
  const file = await open(join(directory, 'predictions.jsonl'), 'wx');
  const predictions: Prediction[] = [];
  const adapter = new ModelAdapter(options.transport, options.timeoutMs);
  let stopReason = 'completed';
  try {
    for (const item of cases) {
      if (options.signal?.aborted) {
        stopReason = 'cancelled';
        break;
      }
      if (predictions.length >= options.maxCalls) {
        stopReason = 'call_limit';
        break;
      }
      const context = modelContext(item);
      const inputHash = hashText(
        JSON.stringify({
          message: context.message,
          confirmed_timezone: context.timezone,
          reference_time: context.referenceTime.toISOString(),
          processing_time: context.processingTime.toISOString(),
        }),
      );
      const started = performance.now();
      let usage:
        | { inputTokens: number; outputTokens: number; responseId: string | null; model: string }
        | undefined;
      let row: Prediction;
      try {
        const result = await adapter.plan(
          context,
          options.signal ?? new AbortController().signal,
          async (transport, request) => {
            const response = await transport.generate(request);
            const parsed = z
              .object({
                inputTokens: z.number().int().nonnegative(),
                outputTokens: z.number().int().nonnegative(),
                responseId: z.string().max(200).nullable(),
                model: z.string().min(1).max(200),
              })
              .safeParse(response);
            if (parsed.success) usage = parsed.data;
            return response;
          },
        );
        row = {
          id: item.id,
          actual: result.decision,
          error: null,
          provider: result.provider,
          model: result.model,
          responseId: result.responseId,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          latencyMs: result.latencyMs,
          inputHash: result.inputHash,
        };
      } catch (error) {
        const code = error instanceof ModelError ? error.code : 'runner_error';
        row = {
          id: item.id,
          actual: null,
          error: code,
          provider: options.transport.provider,
          model: usage?.model ?? options.transport.model,
          responseId: usage?.responseId ?? null,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          latencyMs: Math.round(performance.now() - started),
          inputHash,
        };
        if (!['invalid_output', 'refused', 'too_large'].includes(code)) stopReason = code;
      }
      await file.write(JSON.stringify(row) + '\n');
      await file.sync();
      predictions.push(row);
      if (stopReason !== 'completed') break;
    }
  } finally {
    await file.close();
  }
  const predictionHash = hashText(predictions.map((p) => JSON.stringify(p) + '\n').join(''));
  const metrics = score(cases, predictions, options.source);
  const report = {
    ...manifest,
    finishedAt: new Date().toISOString(),
    stopReason,
    predictionsSha256: predictionHash,
    metrics,
    measuredModelAccuracy: options.source === 'openai',
    gatePassed:
      options.split === 'all' &&
      options.source === 'openai' &&
      stopReason === 'completed' &&
      metrics.passed,
  };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  return { directory, report, predictions };
}
