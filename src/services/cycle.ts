// Update-cycle date arithmetic. Pure — no database — so seed, services and tests
// can all share it.
//
// Dates are plain 'YYYY-MM-DD' strings in the SERVER's local time zone (set TZ
// in the container to your own zone). The due day is a calendar fact ("every
// Thursday"), so it must not slide by a day when UTC midnight passes in the
// evening, which is what toISOString().slice(0, 10) would do.

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Local calendar date of an instant (default: now). */
export function localDay(d: Date | string = new Date()): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

function toUtc(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return fromUtc(toUtc(day) + n * 86_400_000);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

export function weekdayOf(day: string): number {
  return new Date(toUtc(day)).getUTCDay();
}

/** The due day of the cycle containing `day`: the next `weekday` on or after it. */
export function cycleDueFor(day: string, weekday: number): string {
  return addDays(day, (weekday - weekdayOf(day) + 7) % 7);
}

export function isValidDay(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toUtc(s)) && fromUtc(toUtc(s)) === s;
}

/** "Thu 8 Oct" — compact label for a due day. */
export function shortDay(day: string): string {
  const d = new Date(toUtc(day));
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
