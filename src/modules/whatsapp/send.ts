import { z } from 'zod';

export const textMessage = z
  .object({
    phoneNumberId: z.string().regex(/^\d{1,30}$/),
    recipientId: z.string().regex(/^\d{5,20}$/),
    body: z.string().min(1).max(4096),
  })
  .strict();
export type TextMessage = z.infer<typeof textMessage>;
export type SendResult =
  | { state: 'accepted'; providerMessageId: string }
  | { state: 'rejected' | 'unknown'; code: string };
export interface WhatsAppTransport {
  send(message: TextMessage, signal: AbortSignal): Promise<SendResult>;
}

// Bound even an injected transport that ignores cancellation. Late completions cannot change state.
export async function boundedSend(
  transport: WhatsAppTransport,
  message: TextMessage,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SendResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      new Promise<SendResult>((resolve) => {
        abort = () => {
          controller.abort();
          resolve({ state: 'unknown', code: 'cancelled' });
        };
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          resolve({ state: 'unknown', code: 'timeout' });
        }, timeoutMs);
        if (signal?.aborted) abort();
      }),
      Promise.resolve().then(() =>
        controller.signal.aborted
          ? { state: 'unknown' as const, code: 'cancelled' }
          : transport.send(message, controller.signal),
      ),
    ]);
  } catch {
    return { state: 'unknown', code: 'transport_error' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export class WhatsAppCloudTransport implements WhatsAppTransport {
  constructor(
    private readonly accessToken: string,
    private readonly version: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (!accessToken || /[\r\n]/.test(accessToken) || !/^v\d{1,3}\.0$/.test(version))
      throw new Error('Invalid WhatsApp transport configuration');
  }
  async send(input: TextMessage, signal: AbortSignal): Promise<SendResult> {
    const parsed = textMessage.safeParse(input);
    if (!parsed.success) return { state: 'rejected', code: 'invalid_message' };
    const message = parsed.data;
    if (signal.aborted) return { state: 'unknown', code: 'cancelled' };
    try {
      const response = await this.request(
        `https://graph.facebook.com/${this.version}/${message.phoneNumberId}/messages`,
        {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: message.recipientId,
            type: 'text',
            text: { body: message.body, preview_url: false },
          }),
        },
      );
      if (!response.body) return { state: 'unknown', code: 'missing_response' };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 32768) {
            await reader.cancel();
            return { state: 'unknown', code: 'oversize_response' };
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) {
        const error = z
          .object({ error: z.object({ code: z.number().int().nonnegative() }) })
          .safeParse(data);
        return response.status >= 400 && response.status < 500 && error.success
          ? { state: 'rejected', code: `meta_${error.data.error.code}` }
          : { state: 'unknown', code: 'http_error' };
      }
      const result = z
        .object({
          messaging_product: z.literal('whatsapp'),
          messages: z.array(z.object({ id: z.string().min(1).max(512) })).length(1),
        })
        .safeParse(data);
      return result.success
        ? { state: 'accepted', providerMessageId: result.data.messages[0]!.id }
        : { state: 'unknown', code: 'invalid_response' };
    } catch {
      return { state: 'unknown', code: 'transport_error' };
    }
  }
}
