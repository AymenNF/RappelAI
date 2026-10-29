import { Temporal } from '@js-temporal/polyfill';

export type DeliveryMode = 'exact' | 'digest' | 'quiet';
export interface DeliveryPreferences {
  digest_minute: number | null;
  quiet_start: number | null;
  quiet_end: number | null;
}
export const TIME_POLICY =
  'Clock gaps shift forward; repeated digest times use the first occurrence once. Quiet hours include the start and exclude the end.';
export const timeLabel = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const minuteOf = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
const time = '(?:[01]\\d|2[0-3]):[0-5]\\d';
export type PreferenceCommand =
  | { action: 'show' | 'invalid' }
  | { action: 'digest'; minute: number | null }
  | { action: 'quiet'; start: number | null; end: number | null }
  | { action: 'propose'; reference: string; mode: DeliveryMode }
  | { action: 'confirm'; reference: string };
export function preferenceCommand(text: string | null): PreferenceCommand | null {
  if (
    !text ||
    !/^(PREFERENCES\b|DIGEST\b|QUIET\b|DELIVER\b|CONFIRM\s+DELIVERY\b)/i.test(text.trim())
  )
    return null;
  const s = text.trim().toUpperCase();
  if (s === 'PREFERENCES') return { action: 'show' };
  if (s === 'DIGEST OFF') return { action: 'digest', minute: null };
  if (s === 'QUIET OFF') return { action: 'quiet', start: null, end: null };
  const d = new RegExp(`^DIGEST AT (${time})$`).exec(s);
  if (d) return { action: 'digest', minute: minuteOf(d[1]!) };
  const q = new RegExp(`^QUIET (${time})-(${time})$`).exec(s);
  if (q && q[1] !== q[2]) return { action: 'quiet', start: minuteOf(q[1]!), end: minuteOf(q[2]!) };
  const p = /^DELIVER ([A-F0-9]{16}) (EXACT|DIGEST|QUIET)$/.exec(s);
  if (p)
    return {
      action: 'propose',
      reference: p[1]!.toLowerCase(),
      mode: p[2]!.toLowerCase() as DeliveryMode,
    };
  const c = /^CONFIRM DELIVERY ([A-F0-9]{16})$/.exec(s);
  return c ? { action: 'confirm', reference: c[1]!.toLowerCase() } : { action: 'invalid' };
}

/** Original due time is never rewritten. Compute a preview once and persist its exact instant. */
export function deliveryTime(
  due: string,
  zone: string,
  mode: DeliveryMode,
  prefs: DeliveryPreferences,
): string {
  const instant = Temporal.Instant.from(due);
  const local = instant.toZonedDateTimeISO(zone);
  for (const value of [prefs.digest_minute, prefs.quiet_start, prefs.quiet_end])
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 1439))
      throw new Error('Invalid clock preference');
  if (
    (prefs.quiet_start === null) !== (prefs.quiet_end === null) ||
    (prefs.quiet_start !== null && prefs.quiet_start === prefs.quiet_end)
  )
    throw new Error('Invalid quiet interval');
  const afterQuiet = (candidate: Temporal.ZonedDateTime) => {
    const start = prefs.quiet_start,
      end = prefs.quiet_end;
    if (start === null || end === null) return candidate.toInstant();
    const m = candidate.hour * 60 + candidate.minute;
    const inside = start < end ? m >= start && m < end : m >= start || m < end;
    if (!inside) return candidate.toInstant();
    const date =
      start > end && m >= start
        ? candidate.toPlainDate().add({ days: 1 })
        : candidate.toPlainDate();
    const boundary = date.toPlainDateTime(timeLabel(end));
    let result = boundary.toZonedDateTime(zone, { disambiguation: 'compatible' }).toInstant();
    if (Temporal.Instant.compare(result, candidate.toInstant()) < 0)
      result = boundary.toZonedDateTime(zone, { disambiguation: 'later' }).toInstant();
    if (Temporal.Instant.compare(result, candidate.toInstant()) < 0)
      throw new Error('Invalid quiet boundary');
    return result;
  };
  if (mode === 'exact') return instant.toString();
  if (mode === 'quiet') {
    if (prefs.quiet_start === null) throw new Error('Set quiet hours first');
    return afterQuiet(local).toString();
  }
  if (prefs.digest_minute === null) throw new Error('Set a digest time first');
  for (let day = 0; day < 4; day++) {
    const slot = local
      .toPlainDate()
      .add({ days: day })
      .toPlainDateTime(timeLabel(prefs.digest_minute))
      .toZonedDateTime(zone, { disambiguation: 'compatible' });
    if (Temporal.Instant.compare(slot.toInstant(), instant) < 0) continue;
    return afterQuiet(slot).toString();
  }
  throw new Error('No valid digest slot');
}
