import { z } from 'zod';

const position = z.number().int().min(1).max(2147483647);
export const listRequest = z
  .object({
    operation: z.enum(['read', 'item', 'edit', 'complete']),
    list: z.string().trim().min(1).max(200),
    byReference: z.boolean().default(false),
    selector: z.union([z.string().trim().min(1).max(1000), position]).optional(),
    after: z.number().int().min(0).max(2147483647).default(0),
    text: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .refine(
    (r) =>
      (r.operation === 'read' ? r.selector === undefined : r.selector !== undefined) &&
      (r.operation === 'edit' ? r.text !== undefined : r.text === undefined) &&
      (r.operation !== 'item' || typeof r.selector === 'number'),
  );
export type ListRequest = z.infer<typeof listRequest>;
export type ListCommand =
  | { kind: 'request'; request: ListRequest }
  | { kind: 'catalog'; after?: string }
  | { kind: 'choose'; reference: string; option: number }
  | { kind: 'invalid' };

const quoted = '"(?:[^"\\\\]|\\\\.)*"';
const list = `(${quoted}|@[a-f0-9]{16})`;
const read = new RegExp(`^LIST\\s+${list}(?:\\s+AFTER\\s+(\\d+))?$`, 'iu');
const item = new RegExp(`^ITEM\\s+${list}\\s+#([1-9]\\d*)$`, 'iu');
const write = new RegExp(
  `^(EDIT|DONE|COMPLETE)\\s+ITEM\\s+${list}\\s+(${quoted}|#[1-9]\\d*)(?:\\s+TO\\s+(${quoted}))?$`,
  'iu',
);
const decode = (value: string): string =>
  value.startsWith('"') ? (JSON.parse(value) as string) : value.toLowerCase();
export function listCommand(text: string | null): ListCommand | null {
  if (
    !text ||
    !/^(LISTS?\b|ITEM\b|(?:EDIT|DONE|COMPLETE)\s+ITEM\b|CHOOSE\s+LIST\b)/iu.test(text.trim())
  )
    return null;
  const input = text.trim();
  const catalog = /^LISTS(?:\s+AFTER\s+([a-f0-9]{16}))?$/iu.exec(input);
  if (catalog)
    return { kind: 'catalog', ...(catalog[1] ? { after: catalog[1].toLowerCase() } : {}) };
  const choose = /^CHOOSE\s+LIST\s+([a-f0-9]{16})\s+([1-5])$/iu.exec(input);
  if (choose)
    return { kind: 'choose', reference: choose[1]!.toLowerCase(), option: Number(choose[2]) };
  try {
    let request: unknown;
    const r = read.exec(input),
      i = item.exec(input),
      w = write.exec(input);
    if (r)
      request = {
        operation: 'read',
        list: decode(r[1]!),
        byReference: r[1]!.startsWith('@'),
        after: Number(r[2] ?? 0),
      };
    else if (i)
      request = {
        operation: 'item',
        list: decode(i[1]!),
        byReference: i[1]!.startsWith('@'),
        selector: Number(i[2]),
      };
    else if (w)
      request = {
        operation: w[1]!.toUpperCase() === 'EDIT' ? 'edit' : 'complete',
        list: decode(w[2]!),
        byReference: w[2]!.startsWith('@'),
        selector: w[3]!.startsWith('#') ? Number(w[3]!.slice(1)) : decode(w[3]!),
        ...(w[4] ? { text: decode(w[4]) } : {}),
      };
    const parsed = listRequest.safeParse(request);
    return parsed.success ? { kind: 'request', request: parsed.data } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}
export const matchKey = (text: string) =>
  text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();

/** Banded edit distance: bounded typo matching, not an unbounded quadratic search. */
function near(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  let prev = new Map<number, number>();
  for (let j = 0; j <= Math.min(b.length, limit); j++) prev.set(j, j);
  for (let i = 1; i <= a.length; i++) {
    const row = new Map<number, number>();
    for (let j = Math.max(0, i - limit); j <= Math.min(b.length, i + limit); j++) {
      const value =
        j === 0
          ? i
          : Math.min(
              (prev.get(j) ?? Infinity) + 1,
              (row.get(j - 1) ?? Infinity) + 1,
              (prev.get(j - 1) ?? Infinity) + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
      if (value <= limit) row.set(j, value);
    }
    if (!row.size) return false;
    prev = row;
  }
  return (prev.get(b.length) ?? Infinity) <= limit;
}
export function matching<T>(rows: T[], query: string, label: (row: T) => string): T[] {
  const key = matchKey(query);
  if (!key) return [];
  const exact = rows.filter((r) => matchKey(label(r)) === key);
  if (exact.length) return exact;
  const limit = key.length < 3 ? 0 : key.length < 6 ? 1 : 2;
  return rows.filter((r) => {
    const value = matchKey(label(r));
    return value.includes(key) || near(value, key, limit);
  });
}
export function preview(text: string, max = 140): string {
  const chars = Array.from(text.replace(/\s+/gu, ' ').trim());
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}
