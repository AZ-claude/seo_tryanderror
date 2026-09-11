// Date helpers. All dates are plain 'YYYY-MM-DD' strings, UTC-based, no time component.

export function todayString(): string {
  return new Date().toISOString().slice(0, 10);
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
