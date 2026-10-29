import { z } from 'zod';
import { controlHelp } from '../reminders/controls.js';

export const actionResult = z.discriminatedUnion('tool', [
  z
    .object({
      tool: z.literal('create_reminder'),
      id: z.uuid(),
      title: z.string(),
      dueAt: z.string().datetime({ offset: true }),
      timezone: z.string(),
      reference: z
        .string()
        .regex(/^[a-f0-9]{16}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      tool: z.literal('add_list_item'),
      id: z.uuid(),
      listId: z.uuid(),
      listName: z.string(),
      text: z.string(),
      position: z.number().int().positive(),
    })
    .strict(),
]);
export type ActionResult = z.infer<typeof actionResult>;
export interface ActionSource {
  userId: string;
  eventId: string;
  version: number;
  key: string;
}
export class ExpiredReminderError extends Error {}

function preview(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/gu, ' ').trim());
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}
export function successReply(results: ActionResult[]): string {
  const lines = results.map((result) => {
    if (result.tool === 'add_list_item')
      return `Added “${preview(result.text, 160)}” to “${preview(result.listName, 100)}”.`;
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: result.timezone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'shortOffset',
    }).format(new Date(result.dueAt));
    return `Saved reminder “${preview(result.title, 160)}” for ${local} (${result.timezone}).${result.reference ? '\n' + controlHelp(result.reference) : ''}`;
  });
  if (results.some((result) => result.tool === 'create_reminder'))
    lines.push('Reminder delivery is not enabled yet.');
  return lines.join('\n');
}
