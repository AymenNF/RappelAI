import { z } from 'zod';
import { decision } from '../../contracts/decision.js';
import { ModelError, type ModelRequest, type ModelTransport } from './model.js';

// Derived from the runtime contract; semantic refinements are enforced again after parsing.
function responseSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(responseSchema);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== '$schema')
        .map(([key, entry]) => [
          key === 'oneOf' ? 'anyOf' : key === 'const' ? 'enum' : key,
          key === 'const' ? [entry] : responseSchema(entry),
        ]),
    );
  return value;
}
// The discriminated tool branches are disjoint, so anyOf preserves their meaning.
// Responses supports anyOf; Zod emits oneOf for discriminated unions.
export const decisionJsonSchema = responseSchema(z.toJSONSchema(decision));
const envelope = z.object({
  id: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  status: z.literal('completed'),
  output: z.array(
    z.object({
      type: z.string(),
      role: z.string().optional(),
      content: z
        .array(
          z.object({
            type: z.string(),
            text: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

export class OpenAITransport implements ModelTransport {
  readonly provider = 'openai';
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly request: typeof fetch = fetch,
    private readonly maxOutputTokens = 2000,
  ) {
    if (
      !apiKey ||
      !model ||
      model.length > 200 ||
      !Number.isInteger(maxOutputTokens) ||
      maxOutputTokens < 128 ||
      maxOutputTokens > 8000
    )
      throw new Error('Invalid model configuration');
  }
  async generate(input: ModelRequest): Promise<unknown> {
    try {
      const response = await this.request('https://api.openai.com/v1/responses', {
        method: 'POST',
        redirect: 'error',
        signal: input.signal,
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          store: false,
          max_output_tokens: this.maxOutputTokens,
          instructions: input.system,
          input: [{ role: 'user', content: input.input }],
          text: {
            format: {
              type: 'json_schema',
              name: 'memorae_decision_v1',
              strict: true,
              schema: decisionJsonSchema,
            },
          },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ModelError(
          response.status === 429
            ? 'rate_limited'
            : response.status >= 500
              ? 'unavailable'
              : 'rejected',
        );
      }
      if (!response.body) throw new ModelError('invalid_output');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 131072) {
            await reader.cancel();
            throw new ModelError('too_large');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      let json: unknown;
      try {
        json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new ModelError('invalid_output');
      }
      const parsed = envelope.safeParse(json);
      if (!parsed.success) throw new ModelError('invalid_output');
      const messages = parsed.data.output.filter((item) => item.type === 'message');
      if (parsed.data.output.some((item) => !['message', 'reasoning'].includes(item.type)))
        throw new ModelError('invalid_output');
      if (messages.some((item) => item.content?.some((part) => part.type === 'refusal')))
        throw new ModelError('refused');
      if (
        messages.length !== 1 ||
        messages[0]?.role !== 'assistant' ||
        messages[0].content?.length !== 1 ||
        messages[0].content[0]?.type !== 'output_text'
      )
        throw new ModelError('invalid_output');
      return {
        text: messages[0].content[0].text,
        model: parsed.data.model,
        responseId: parsed.data.id,
        inputTokens: parsed.data.usage.input_tokens,
        outputTokens: parsed.data.usage.output_tokens,
      };
    } catch (error) {
      if (error instanceof ModelError) throw error;
      if (input.signal.aborted) throw input.signal.reason;
      throw new ModelError('unavailable');
    }
  }
}
