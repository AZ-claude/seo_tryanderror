// Date helpers. All dates are plain 'YYYY-MM-DD' strings.
// Calendar-date *arithmetic* below (addDays/diffDays/parseDate/formatDate)
// stays UTC-based — it only ever operates on already-resolved YYYY-MM-DD
// strings, not on the current instant, so there is nothing timezone-ish
// about it. The one place "what day is it right now" actually gets decided
// is todayString(); operators, the site, and the Windows ops machine all
// run on JST, so that single entry point resolves against Asia/Tokyo
// (Node's built-in Intl.DateTimeFormat, no external timezone library).

const OPERATIONAL_TIMEZONE = 'Asia/Tokyo';
const jstDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: OPERATIONAL_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Pure, instant-injectable: the Asia/Tokyo calendar date for a given instant, as YYYY-MM-DD. */
export function toOperationalDateString(instant: Date): string {
  // en-CA's formatToParts gives numeric fields we can reassemble losslessly,
  // rather than relying on the locale's en-CA output ordering.
  const parts = jstDateFormatter.formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** "What day is it, operationally" — Asia/Tokyo, not UTC and not the host machine's local zone. */
export function todayString(): string {
  return toOperationalDateString(new Date());
}

export function parseDate(date: string): Date {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid date: ${date}`);
  }
  return d;
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d);
}

/** Number of days from `a` to `b` (positive when b is after a). */
export function diffDays(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / msPerDay);
}

/** -1 if a < b, 0 if equal, 1 if a > b */
export function compareDates(a: string, b: string): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function isBeforeOrEqual(a: string, b: string): boolean {
  return compareDates(a, b) <= 0;
}

export function isAfter(a: string, b: string): boolean {
  return compareDates(a, b) > 0;
}

/**
 * Standard measurement window: end = today - finalDataLagDays,
 * start = end - (days - 1). See DESIGN.md section 8.
 */
export function computeMeasurementWindow(input: {
  today: string;
  windowDays: number;
  finalDataLagDays: number;
}): { start: string; end: string; days: number } {
  const end = addDays(input.today, -input.finalDataLagDays);
  const start = addDays(end, -(input.windowDays - 1));
  return { start, end, days: input.windowDays };
}
