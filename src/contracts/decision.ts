import { z } from 'zod';

// First vertical slice only: one-time reminders and list additions.
export const reminderArgs = z
  .object({
    title: z.string().trim().min(1).max(200),
    due_at: z.string().datetime({ offset: true }),
    delivery_mode: z.enum(['immediate', 'digest']),
  })
  .strict();
export const listArgs = z
  .object({
    list_name: z.string().trim().min(1).max(200),
    text: z.string().trim().min(1).max(1000),
  })
  .strict();
export const toolCall = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('create_reminder'), args: reminderArgs }).strict(),
  z.object({ tool: z.literal('add_list_item'), args: listArgs }).strict(),
]);
export const decision = z
  .object({
    behavior: z.enum(['execute', 'clarify', 'noop', 'unsupported']),
    calls: z.array(toolCall).max(5),
  })
  .strict()
  .refine((value) => (value.behavior === 'execute') === value.calls.length > 0, {
    message: 'Only execute decisions may contain tool calls; execution requires at least one call',
  });
export type Decision = z.infer<typeof decision>;

export function validateDecision(input: unknown, now: Date): Decision {
  const parsed = decision.parse(input);
  for (const call of parsed.calls) {
    if (call.tool === 'create_reminder' && Date.parse(call.args.due_at) <= now.getTime()) {
      throw new Error('Reminder must be in the future');
    }
  }
  return parsed;
}
