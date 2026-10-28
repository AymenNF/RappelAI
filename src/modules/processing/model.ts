import { z } from 'zod';
import { validateDecision, type Decision } from '../../contracts/decision.js';
import { INTENT_PROMPT, PROMPT_SHA256, PROMPT_VERSION, hashText } from './prompt.js';
import { DeferredWorkError } from './runner.js';

export class ModelError extends Error {
  constructor(
    public readonly code:
      | 'timeout'
      | 'cancelled'
      | 'unavailable'
      | 'rate_limited'
      | 'rejected'
      | 'invalid_output'
      | 'refused'
      | 'too_large',
  ) {
    super(`Model request failed: ${code}`);
  }
}
export interface ModelContext {
  message: string;
  timezone: string;
  referenceTime: Date;
  processingTime: Date;
}
export interface ModelRequest {
  system: string;
  input: string;
  signal: AbortSignal;
}
export interface ModelTransport {
  provider: string;
  model: string;
  maxOutputTokens?: number;
  generate(request: ModelRequest): Promise<unknown>;
}
const output = z
  .object({
    text: z.string().max(32768),
    responseId: z.string().max(200).nullable(),
    model: z.string().min(1).max(200),
    inputTokens: z.number().int().min(0).max(2147483647),
    outputTokens: z.number().int().min(0).max(2147483647),
  })
  .strict();
export interface ValidatedPlan {
  decision: Decision;
  provider: string;
  model: string;
  promptVersion: string;
  promptHash: string;
  inputHash: string;
  responseId: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export class ModelAdapter {
  constructor(
    private readonly transport: ModelTransport,
    private readonly timeoutMs = 20000,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
      throw new Error('Invalid model timeout');
  }
  async plan(
    context: ModelContext,
    signal: AbortSignal,
    invoke: (transport: ModelTransport, request: ModelRequest) => Promise<unknown> = (
      transport,
      request,
    ) => transport.generate(request),
  ): Promise<ValidatedPlan> {
    if (signal.aborted) throw new ModelError('cancelled');
    if (!context.message.trim() || context.message.length > 16000)
      throw new ModelError('too_large');
    const input = JSON.stringify({
      message: context.message,
      confirmed_timezone: context.timezone,
      reference_time: context.referenceTime.toISOString(),
      processing_time: context.processingTime.toISOString(),
    });
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort(new ModelError('cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => cancellation.abort(new ModelError('timeout')), this.timeoutMs);
    const started = performance.now();
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(cancellation.signal.reason);
        cancellation.signal.addEventListener('abort', onAbort, { once: true });
        if (cancellation.signal.aborted) onAbort();
      });
      const response = await Promise.race([
        Promise.resolve().then(() => {
          if (cancellation.signal.aborted) throw cancellation.signal.reason;
          return invoke(this.transport, {
            system: INTENT_PROMPT,
            input,
            signal: cancellation.signal,
          });
        }),
        aborted,
      ]);
      if (cancellation.signal.aborted) throw cancellation.signal.reason;
      const parsed = output.parse(response);
      const decision = validateDecision(JSON.parse(parsed.text), context.processingTime);
      return {
        decision,
        provider: this.transport.provider,
        model: parsed.model,
        promptVersion: PROMPT_VERSION,
        promptHash: PROMPT_SHA256,
        inputHash: hashText(input),
        responseId: parsed.responseId,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      if (error instanceof ModelError || error instanceof DeferredWorkError) throw error;
      // Provider bodies and user content must never escape in error messages.
      throw new ModelError('invalid_output');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (onAbort) cancellation.signal.removeEventListener('abort', onAbort);
    }
  }
}
