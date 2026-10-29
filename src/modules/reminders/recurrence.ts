import { Temporal } from '@js-temporal/polyfill';
import { canonicalTimezone } from '../identity/onboarding.js';

export type Cadence = 'daily' | 'weekly';
export interface ScheduledDate {
  localDate: string;
  instant: string;
  local: string;
}
export const DST_POLICY =
  'Clock gaps shift forward by the gap; repeated times use the first occurrence once. Skipped calendar dates never produce duplicate instants.';

/** Finite, calendar-based schedule. The first saved instant must agree with the visible DST policy. */
export function recurrenceSchedule(
  firstInstant: string,
  zone: string,
  cadence: Cadence,
  until: string,
): ScheduledDate[] {
  if (
    !canonicalTimezone(zone) ||
    !['daily', 'weekly'].includes(cadence) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(until)
  )
    throw new Error('Invalid recurrence rule');
  const first = Temporal.Instant.from(firstInstant).toZonedDateTimeISO(zone);
  const start = first.toPlainDate(),
    end = Temporal.PlainDate.from(until, { overflow: 'reject' });
  const days = start.until(end).days;
  if (days < 1 || days > 365)
    throw new Error('End date must be within 365 days after the first reminder');
  const time = first.toPlainTime();
  const schedule: ScheduledDate[] = [];
  for (
    let date = start;
    Temporal.PlainDate.compare(date, end) <= 0;
    date = date.add({ days: cadence === 'daily' ? 1 : 7 })
  ) {
    const local = date
      .toPlainDateTime(time)
      .toZonedDateTime(zone, { disambiguation: 'compatible' });
    const instant = local.toInstant();
    if (schedule.length === 0 && Temporal.Instant.compare(instant, first.toInstant()) !== 0)
      throw new Error(
        'First reminder selects the second repeated clock time; choose the first occurrence before repeating',
      );
    // A whole-date political offset jump can map adjacent nominal dates to the same instant.
    if (
      schedule.length &&
      Temporal.Instant.compare(instant, Temporal.Instant.from(schedule.at(-1)!.instant)) <= 0
    )
      continue;
    schedule.push({
      localDate: date.toString(),
      instant: instant.toString(),
      local: local.toString(),
    });
  }
  if (schedule.length < 2) throw new Error('The end date must include at least two occurrences');
  return schedule;
}

export type SeriesCommand =
  | { action: 'propose'; reference: string; cadence: Cadence; until: string }
  | { action: 'confirm' | 'cancel'; reference: string }
  | { action: 'invalid' };
export function seriesCommand(text: string | null): SeriesCommand | null {
  if (!text || !/^(REPEAT\b|CONFIRM\s+REPEAT\b|CANCEL\s+SERIES\b)/i.test(text.trim())) return null;
  const proposal = /^REPEAT\s+([a-f0-9]{16})\s+(DAILY|WEEKLY)\s+UNTIL\s+(\d{4}-\d{2}-\d{2})$/i.exec(
    text.trim(),
  );
  if (proposal)
    return {
      action: 'propose',
      reference: proposal[1]!.toLowerCase(),
      cadence: proposal[2]!.toLowerCase() as Cadence,
      until: proposal[3]!,
    };
  const control = /^(CONFIRM REPEAT|CANCEL SERIES)\s+([a-f0-9]{16})$/i.exec(text.trim());
  return control
    ? {
        action: control[1]!.toUpperCase() === 'CONFIRM REPEAT' ? 'confirm' : 'cancel',
        reference: control[2]!.toLowerCase(),
      }
    : { action: 'invalid' };
}
