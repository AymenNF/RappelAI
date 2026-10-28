import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import {
  ModelAdapter,
  ModelError,
  type ModelTransport,
} from '../../src/modules/processing/model.js';
import { OpenAITransport, decisionJsonSchema } from '../../src/modules/processing/openai.js';
import { PROMPT_SHA256, INTENT_PROMPT } from '../../src/modules/processing/prompt.js';
import { readConfig } from '../../src/config/env.js';

const context = {
  message: 'Add milk to grocery',
  timezone: 'America/Toronto',
  referenceTime: new Date('2026-10-27T12:00:00Z'),
  processingTime: new Date('2026-10-27T12:00:02Z'),
};
const choice = {
  behavior: 'execute',
  calls: [{ tool: 'add_list_item', args: { list_name: 'grocery', text: 'milk' } }],
};
const result = (text = JSON.stringify(choice)) => ({
  text,
  model: 'test-model',
  responseId: 'response-1',
  inputTokens: 30,
  outputTokens: 20,
});
const transport = (generate: ModelTransport['generate']): ModelTransport => ({
  provider: 'test',
  model: 'test-model',
  generate,
});
const signal = () => new AbortController().signal;
const code = (expected: ModelError['code']) => (error: unknown) =>
  error instanceof ModelError && error.code === expected;
const response = (overrides: Record<string, unknown> = {}) => ({
  id: 'resp-1',
  status: 'completed',
  model: 'test-model',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(choice) }],
    },
  ],
  usage: { input_tokens: 30, output_tokens: 20 },
  ...overrides,
});

test('adapter separates trusted instructions and message data, validates and records provenance', async () => {
  const adapter = new ModelAdapter(
    transport(async (request) => {
      assert.equal(request.system, INTENT_PROMPT);
      assert.deepEqual(JSON.parse(request.input), {
        message: context.message,
        confirmed_timezone: context.timezone,
        reference_time: context.referenceTime.toISOString(),
        processing_time: context.processingTime.toISOString(),
      });
      return result();
    }),
  );
  const plan = await adapter.plan(context, signal());
  assert.deepEqual(plan.decision, choice);
  assert.equal(plan.promptHash, PROMPT_SHA256);
  assert.match(plan.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(plan.inputTokens, 30);
  assert.equal(plan.outputTokens, 20);
  assert.ok(plan.latencyMs >= 0);
});

test('invalid JSON, schemas, unsafe arguments, past dates and bad usage never become plans', async () => {
  const invalid = [
    'private raw reply',
    '```json\n{}\n```',
    JSON.stringify({ ...choice, user_id: 'victim' }),
    JSON.stringify({ behavior: 'clarify', calls: choice.calls }),
    JSON.stringify({
      behavior: 'execute',
      calls: [{ tool: 'send_message', args: { recipient: 'victim' } }],
    }),
    JSON.stringify({
      behavior: 'execute',
      calls: [
        {
          tool: 'create_reminder',
          args: { title: 'test', due_at: '2001-01-01T00:00:00Z', delivery_mode: 'immediate' },
        },
      ],
    }),
  ];
  for (const text of invalid) {
    await assert.rejects(
      new ModelAdapter(transport(async () => result(text))).plan(context, signal()),
      code('invalid_output'),
    );
  }
  await assert.rejects(
    new ModelAdapter(transport(async () => ({ ...result(), inputTokens: -1 }))).plan(
      context,
      signal(),
    ),
    code('invalid_output'),
  );
  await assert.rejects(
    new ModelAdapter(transport(async () => result())).plan(
      { ...context, message: 'x'.repeat(16001) },
      signal(),
    ),
    code('too_large'),
  );
});

test('timeout bounds an uncooperative provider, aborts its signal, and ignores late completion', async () => {
  let remoteSignal: AbortSignal | undefined;
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const adapter = new ModelAdapter(
    transport(async (request) => {
      remoteSignal = request.signal;
      return pending;
    }),
    20,
  );
  await assert.rejects(adapter.plan(context, signal()), code('timeout'));
  assert.equal(remoteSignal?.aborted, true);
  release(result());
  await setTimeout(0);
});

test('cancellation prevents starting a request and cancels an active provider', async () => {
  const stop = new AbortController();
  stop.abort();
  let calls = 0;
  const adapter = new ModelAdapter(
    transport(async () => {
      calls++;
      return result();
    }),
  );
  await assert.rejects(adapter.plan(context, stop.signal), code('cancelled'));
  assert.equal(calls, 0);
  const active = new AbortController();
  await assert.rejects(
    new ModelAdapter(
      transport(async () => {
        active.abort();
        return result();
      }),
    ).plan(context, active.signal),
    code('cancelled'),
  );
});

test('Responses adapter sends strict schema, bounded output, no storage and no tool access', async () => {
  const schema = JSON.stringify(decisionJsonSchema);
  assert.ok(schema.includes('"anyOf"'));
  assert.ok(!schema.includes('"oneOf"'));
  assert.ok(!schema.includes('"const"'));
  const fake: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 2000);
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(body.text.format.schema, decisionJsonSchema);
    assert.equal(body.tools, undefined);
    assert.equal(body.instructions, INTENT_PROMPT);
    return Response.json(response());
  };
  const plan = await new ModelAdapter(new OpenAITransport('test-key', 'test-model', fake)).plan(
    context,
    signal(),
  );
  assert.deepEqual(plan.decision, choice);
  assert.equal(plan.responseId, 'resp-1');
});

test('Responses adapter rejects HTTP failures, refusals, truncation, missing usage and oversize bodies', async () => {
  for (const [status, expected] of [
    [429, 'rate_limited'],
    [503, 'unavailable'],
    [401, 'rejected'],
  ] as const) {
    const fake: typeof fetch = async () => new Response('private provider error', { status });
    await assert.rejects(
      new ModelAdapter(new OpenAITransport('test', 'test', fake)).plan(context, signal()),
      code(expected),
    );
  }
  for (const [body, expected] of [
    [response({ status: 'incomplete' }), 'invalid_output'],
    [response({ usage: null }), 'invalid_output'],
    [response({ output: [] }), 'invalid_output'],
    [
      response({
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal' }] }],
      }),
      'refused',
    ],
  ] as const) {
    await assert.rejects(
      new ModelAdapter(new OpenAITransport('test', 'test', async () => Response.json(body))).plan(
        context,
        signal(),
      ),
      code(expected),
    );
  }
  await assert.rejects(
    new ModelAdapter(
      new OpenAITransport('test', 'test', async () => new Response('x'.repeat(131073))),
    ).plan(context, signal()),
    code('too_large'),
  );
  await assert.rejects(
    new ModelAdapter(
      new OpenAITransport('test', 'test', async () => new Response('private malformed JSON')),
    ).plan(context, signal()),
    code('invalid_output'),
  );
});

test('model mode defaults off and cannot silently enable paid calls', () => {
  const env = {
    WHATSAPP_APP_SECRET: 'local-test-secret-1234',
    WHATSAPP_VERIFY_TOKEN: 'local-test-token-1234',
  };
  assert.equal(readConfig(env).MODEL_MODE, 'disabled');
  assert.equal(readConfig({ ...env, MODEL_MODE: 'fixture' }).MODEL_MODE, 'fixture');
  assert.throws(() => readConfig({ ...env, MODEL_MODE: 'openai' }), /MODEL_MODE/);
});
