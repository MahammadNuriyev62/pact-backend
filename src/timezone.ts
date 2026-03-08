/**
 * Timezone utilities for pact date calculations.
 * Each pact stores the creator's timezone (IANA, e.g. "America/New_York").
 * All day-boundary logic uses the pact's timezone.
 */

/** Get today's date (YYYY-MM-DD) in the given IANA timezone. */
export function getTodayInTimezone(tz: string): string {
  return formatDateInTimezone(new Date(), tz);
}

/** Format a Date object as YYYY-MM-DD in the given timezone. */
export function formatDateInTimezone(date: Date, tz: string): string {
  // Intl.DateTimeFormat gives us the date parts in the target timezone
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find(p => p.type === 'year')!.value;
  const month = parts.find(p => p.type === 'month')!.value;
  const day = parts.find(p => p.type === 'day')!.value;
  return `${year}-${month}-${day}`;
}

/** Convert a UTC ISO timestamp string to a YYYY-MM-DD date in the given timezone. */
export function utcTimestampToDateInTimezone(isoTimestamp: string, tz: string): string {
  return formatDateInTimezone(new Date(isoTimestamp), tz);
}

/** Get current hour and minute in the given timezone. */
export function getCurrentTimeInTimezone(tz: string): { hours: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date());

  const hours = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  const minutes = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
  return { hours, minutes };
}
