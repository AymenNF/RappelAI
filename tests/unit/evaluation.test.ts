import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadDataset, parseCases, modelContext, type GoldenCase } from '../../evals/lib.js';
import { score, type Prediction } from '../../evals/metrics.js';
import { runEvaluation, type EvaluationOptions } from '../../evals/runner.js';
import { verifyReport } from '../../evals/reports.js';
import { OpenAITransport } from '../../src/modules/processing/openai.js';
import { ModelError, type ModelTransport } from '../../src/modules/processing/model.js';
import { PROMPT_SHA256 } from '../../src/modules/processing/prompt.js';

const dataset = await loadDataset();
const prediction = (item: GoldenCase): Prediction => ({
  id: item.id,
  actual: item.expect,
  error: null,
  provider: 'mock',
  model: 'unit-only',
  responseId: null,
  inputTokens: 2,
  outputTokens: 3,
  latencyMs: 1,
  inputHash: '0'.repeat(64),
});
const constant: ModelTransport = {
  provider: 'mock',
  model: 'constant',
  generate: async () => ({
    text: '{"behavior":"noop","calls":[]}',
    model: 'constant',
    responseId: null,
    inputTokens: 4,
    outputTokens: 5,
  }),
};
async function inDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'memorae-eval-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const options = (directory: string, extra: Partial<EvaluationOptions> = {}): EvaluationOptions => ({
  directory,
  cases: dataset.cases,
  datasetVersion: dataset.version,
  datasetHash: dataset.hash,
  source: 'mock',
  transport: constant,
  timeoutMs: 1000,
  maxCalls: 60,
  split: 'all',
  gitRevision: null,
  gitDirty: true,
  ...extra,
});

test('CLI refuses live evaluation without explicit paid opt-in and rejects unknown flags', () => {
  for (const args of [['--provider', 'openai', '--model', 'test-model'], ['--unexpected-option']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'evals/run.ts', ...args], {
      encoding: 'utf8',
      env: { ...process.env, OPENAI_API_KEY: 'unit-test-only' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No call was made|Unknown option/);
    assert.doesNotMatch(result.stderr, /unit-test-only/);
  }
});

test('60 reviewed cases have coverage, unique IDs, 48/12 split and valid timezone offsets', () => {
  assert.equal(dataset.cases.length, 60);
  assert.equal(dataset.cases.filter((c) => c.split === 'holdout').length, 12);
  assert.equal(new Set(dataset.cases.map((c) => c.category)).size, 8);
  for (const item of dataset.cases)
    for (const call of item.expect.calls) {
      if (call.tool !== 'create_reminder') continue;
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: item.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(call.args.due_at));
      const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      assert.equal(
        `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`,
        call.args.due_at.slice(0, 19),
        item.id,
      );
    }
});
test('dataset validator rejects duplicate IDs, invalid labels, missing review and reversed processing time', () => {
  const item = dataset.cases[0]!;
  assert.throws(() => parseCases(JSON.stringify(item) + '\n' + JSON.stringify(item)), /duplicate/);
  for (const changed of [
    { ...item, review: undefined },
    { ...item, expect: { behavior: 'execute', calls: [] } },
    { ...item, processingTime: '2020-01-01T00:00:00Z' },
    { ...item, timezone: 'not-a-zone' },
  ])
    assert.throws(() => parseCases(JSON.stringify(changed)));
});
test('model input is an explicit whitelist, with delayed processing kept separate', () => {
  const item = dataset.cases.find((c) => c.processingTime)!;
  const context = modelContext(item);
  assert.deepEqual(Object.keys(context).sort(), [
    'message',
    'processingTime',
    'referenceTime',
    'timezone',
  ]);
  assert.notEqual(context.processingTime.getTime(), context.referenceTime.getTime());
});
test('scoring normalizes instants but not titles, call ordering, duplicates or extra actions', () => {
  const item = dataset.cases[0]!,
    row = prediction(item);
  const changed = structuredClone(row);
  if (changed.actual?.calls[0]?.tool === 'create_reminder')
    changed.actual.calls[0].args.due_at = new Date(
      changed.actual.calls[0].args.due_at,
    ).toISOString();
  const metrics = score([item], [changed], 'mock');
  assert.equal(metrics.exactMatches, 0);
  assert.equal(metrics.semanticMatches, 1);
  assert.equal(metrics.passed, false);
  if (changed.actual?.calls[0]?.tool === 'create_reminder')
    changed.actual.calls[0].args.title = 'different';
  assert.equal(score([item], [changed], 'mock').semanticMatches, 0);
  const multi = dataset.cases.find((c) => c.id === 'multi-001')!,
    reversed = prediction(multi);
  reversed.actual = structuredClone(reversed.actual);
  reversed.actual!.calls.reverse();
  assert.equal(score([multi], [reversed], 'mock').semanticMatches, 0);
});
test('missing/error predictions count against denominator; duplicates and unknown IDs reject', () => {
  const subset = dataset.cases.slice(0, 2),
    row = prediction(subset[0]!);
  assert.equal(score(subset, [row], 'openai').accuracy, 0.5);
  assert.equal(score(subset, [row], 'openai').complete, false);
  const failed = { ...prediction(subset[1]!), actual: null, error: 'timeout' };
  assert.equal(score(subset, [row, failed], 'openai').accuracy, 0.5);
  assert.throws(() => score(subset, [row, row], 'mock'), /Duplicate/);
  assert.throws(() => score(subset, [{ ...row, id: 'unknown' }], 'mock'), /unknown/);
});
test('injection and scope gates require perfection; mock/imported perfect labels never pass live gate', () => {
  const rows = dataset.cases.map(prediction);
  // Golden labels used only in this scorer unit test, never as model predictions in a run.
  assert.equal(score(dataset.cases, rows, 'mock').passed, false);
  assert.equal(score(dataset.cases, rows, 'imported').passed, false);
  assert.equal(score(dataset.cases, rows, 'openai').passed, true);
  const changed = structuredClone(rows);
  changed.find((p) => p.id === 'scope-001')!.actual = { behavior: 'noop', calls: [] };
  const metrics = score(dataset.cases, changed, 'openai');
  assert.ok(metrics.accuracy > 0.9);
  assert.equal(metrics.passed, false);
});
test('runner emits unique versioned artifacts and verifies mock report without claiming model accuracy', async () => {
  await inDirectory(async (directory) => {
    const first = await runEvaluation(options(directory));
    const second = await runEvaluation(options(directory, { split: 'holdout' }));
    assert.notEqual(first.directory, second.directory);
    assert.equal(first.report.prompt.sha256, PROMPT_SHA256);
    assert.equal(first.report.metrics.predictions, 60);
    assert.equal(second.report.metrics.predictions, 12);
    assert.equal(first.report.measuredModelAccuracy, false);
    assert.equal(first.report.gatePassed, false);
    assert.equal((await verifyReport(first.directory)).gatePassed, false);
    await writeFile(join(first.directory, 'predictions.jsonl'), '{}\n');
    await assert.rejects(verifyReport(first.directory), /checksum/);
  });
});
test('real OpenAI adapter path runs through mocked HTTP without leaking expected labels or review metadata', async () => {
  await inDirectory(async (directory) => {
    let calls = 0;
    const item = dataset.cases.find((c) => c.category === 'noop')!;
    const transport = new OpenAITransport(
      'fake-key',
      'test-requested-model',
      async (_url, init) => {
        calls++;
        const body = JSON.parse(init?.body as string),
          input = JSON.parse(body.input[0].content);
        assert.deepEqual(Object.keys(input).sort(), [
          'confirmed_timezone',
          'message',
          'processing_time',
          'reference_time',
        ]);
        assert.equal(input.message, item.input);
        assert.doesNotMatch(body.input[0].content, /expect|rationale|reviewer|holdout|noop-00/);
        return Response.json({
          id: 'resp-test',
          model: 'resolved-model-snapshot',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '{"behavior":"noop","calls":[]}' }],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 8 },
        });
      },
    );
    const result = await runEvaluation(options(directory, { cases: [item], transport }));
    assert.equal(calls, 1);
    assert.equal(result.predictions[0]!.model, 'resolved-model-snapshot');
    assert.equal(result.predictions[0]!.responseId, 'resp-test');
    assert.equal(result.report.metrics.inputTokens, 12);
  });
});
test('invalid output keeps known usage; provider errors stop without retries or raw error leakage', async () => {
  await inDirectory(async (directory) => {
    let calls = 0;
    const transport: ModelTransport = {
      provider: 'mock',
      model: 'error-model',
      generate: async () => {
        if (++calls === 1)
          return {
            text: 'not-json',
            model: 'error-model',
            responseId: 'r1',
            inputTokens: 7,
            outputTokens: 2,
          };
        throw new ModelError('rate_limited');
      },
    };
    const result = await runEvaluation(options(directory, { transport }));
    assert.equal(calls, 2);
    assert.equal(result.report.stopReason, 'rate_limited');
    assert.equal(result.predictions[0]!.error, 'invalid_output');
    assert.equal(result.report.metrics.inputTokens, 7);
    assert.equal(result.report.metrics.unknownUsageCount, 1);
    assert.equal(result.report.metrics.missing.length, 58);
    assert.equal(result.report.gatePassed, false);
  });
});
test('call cap, cancellation and uncooperative timeout produce partial reports and no retry', async () => {
  await inDirectory(async (directory) => {
    const capped = await runEvaluation(options(directory, { maxCalls: 1 }));
    assert.equal(capped.report.stopReason, 'call_limit');
    assert.equal(capped.predictions.length, 1);
    const cancelled = await runEvaluation(options(directory, { signal: AbortSignal.abort() }));
    assert.equal(cancelled.predictions.length, 0);
    assert.equal(cancelled.report.stopReason, 'cancelled');
    assert.equal((await verifyReport(cancelled.directory)).gatePassed, false);
    const timeout = await runEvaluation(
      options(directory, {
        timeoutMs: 10,
        transport: { provider: 'mock', model: 'stuck', generate: () => new Promise(() => {}) },
      }),
    );
    assert.equal(timeout.predictions.length, 1);
    assert.equal(timeout.report.stopReason, 'timeout');
    const text = await readFile(join(timeout.directory, 'predictions.jsonl'), 'utf8');
    assert.equal(text.trim().split('\n').length, 1);
  });
});
