import 'dotenv/config';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { OpenAITransport } from '../src/modules/processing/openai.js';
import type { ModelTransport } from '../src/modules/processing/model.js';
import { loadDataset } from './lib.js';
import { runEvaluation } from './runner.js';

const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'mock' },
    model: { type: 'string' },
    'allow-paid': { type: 'boolean', default: false },
    split: { type: 'string', default: 'all' },
    out: { type: 'string', default: 'evals/results' },
    'max-calls': { type: 'string', default: '60' },
    'max-output-tokens': { type: 'string', default: '2000' },
    'timeout-ms': { type: 'string', default: '20000' },
  },
  strict: true,
  allowPositionals: false,
});
const provider = z.enum(['openai', 'mock']).parse(values.provider);
const split = z.enum(['all', 'development', 'holdout']).parse(values.split);
const maxCalls = z.coerce.number().int().min(1).max(60).parse(values['max-calls']);
const maxOutputTokens = z.coerce
  .number()
  .int()
  .min(128)
  .max(8000)
  .parse(values['max-output-tokens']);
const timeoutMs = z.coerce.number().int().min(1).max(120000).parse(values['timeout-ms']);
let transport: ModelTransport;
if (provider === 'openai') {
  if (!values['allow-paid'] || !values.model || !process.env.OPENAI_API_KEY)
    throw new Error(
      'Live evaluation requires --allow-paid, --model and OPENAI_API_KEY. No call was made.',
    );
  transport = new OpenAITransport(process.env.OPENAI_API_KEY, values.model, fetch, maxOutputTokens);
} else {
  if (values['allow-paid'] || values.model)
    throw new Error('Paid/model options require --provider openai');
  transport = {
    provider: 'mock',
    model: 'constant-noop-v1',
    maxOutputTokens,
    generate: async () => ({
      text: JSON.stringify({ behavior: 'noop', calls: [] }),
      responseId: null,
      model: 'constant-noop-v1',
      inputTokens: 0,
      outputTokens: 0,
    }),
  };
}
const dataset = await loadDataset();
let gitRevision: string | null = null,
  gitDirty = true;
try {
  gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  gitDirty =
    execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0;
} catch {
  /* Unknown provenance remains explicit. */
}
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const result = await runEvaluation({
    directory: resolve(values.out!),
    cases: dataset.cases,
    datasetVersion: dataset.version,
    datasetHash: dataset.hash,
    source: provider,
    transport,
    timeoutMs,
    maxCalls,
    split,
    gitRevision,
    gitDirty,
    signal: controller.signal,
  });
  console.log(
    JSON.stringify(
      {
        directory: result.directory,
        source: provider,
        stopReason: result.report.stopReason,
        gatePassed: result.report.gatePassed,
        metrics: result.report.metrics,
      },
      null,
      2,
    ),
  );
  process.exitCode =
    provider === 'mock'
      ? result.report.stopReason === 'completed'
        ? 0
        : 1
      : result.report.gatePassed
        ? 0
        : 1;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
