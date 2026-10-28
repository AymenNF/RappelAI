import { createHash } from 'node:crypto';
import { z } from 'zod';

const providerMessage = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    timestamp: z.string().regex(/^\d+$/),
    type: z.string().min(1),
  })
  .passthrough();
const providerStatus = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    timestamp: z.string().regex(/^\d+$/),
  })
  .passthrough();
const envelope = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z
      .object({
        id: z.string(),
        changes: z.array(
          z
            .object({
              field: z.string(),
              value: z
                .object({
                  metadata: z
                    .object({ phone_number_id: z.string().min(1) })
                    .passthrough()
                    .optional(),
                  messages: z.array(providerMessage).optional(),
                  statuses: z.array(providerStatus).optional(),
                })
                .passthrough(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  ),
});

export interface IngressEvent {
  eventKey: string;
  kind: 'inbound.message' | 'delivery.status';
  phoneNumberId: string;
  providerMessageId: string;
  senderId: string | null;
  payload: Record<string, unknown>;
}

export function extractEvents(input: unknown, allowedPhoneId = ''): IngressEvent[] {
  const parsed = envelope.parse(input);
  const events: IngressEvent[] = [];
  for (const entry of parsed.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const value = change.value;
      if (!value.messages?.length && !value.statuses?.length) continue;
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) throw new Error('Missing phone number metadata');
      if (allowedPhoneId && phoneNumberId !== allowedPhoneId)
        throw new Error('Unexpected phone number');
      for (const message of value.messages ?? []) {
        events.push({
          eventKey: key(['message', phoneNumberId, message.id]),
          kind: 'inbound.message',
          phoneNumberId,
          providerMessageId: message.id,
          senderId: message.from,
          payload: message,
        });
      }
      for (const status of value.statuses ?? []) {
        events.push({
          eventKey: key(['status', phoneNumberId, status.id, status.status, status.timestamp]),
          kind: 'delivery.status',
          phoneNumberId,
          providerMessageId: status.id,
          senderId: null,
          payload: status,
        });
      }
    }
  }
  return events;
}

function key(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
