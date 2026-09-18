import { computeMeasurementWindow } from './date.js';
import type { MeasurementPlan, MetricsSnapshot, MetricsSnapshotSource, RankHistory } from './types.js';

/**
 * DESIGN.md 6.5.3: before/after snapshots are computed by extracting only the
 * rank-history rows matching `measurementPlan.targetPages`/`targetQueries`
 * (never the whole matrix), aggregated across entries whose date falls
 * within the computed window. `sufficientData` is false only when there is
 * no matching data at all, or the aggregate is below `minimumImpressions` —
 * this must never be conflated with a genuine "no effect" measurement.
 */
export function computeMetricsSnapshot(input: {
  rankHistory: RankHistory;
  measurementPlan: Pick<MeasurementPlan, 'targetPages' | 'targetQueries' | 'minimumImpressions'>;
  today: string;
  windowDays: number;
  finalDataLagDays: number;
  source: MetricsSnapshotSource;
  now: string;
}): MetricsSnapshot {
  const { rankHistory, measurementPlan, today, windowDays, finalDataLagDays, source, now } = input;
  const window = computeMeasurementWindow({ today, windowDays, finalDataLagDays });
  const targetPages = new Set(measurementPlan.targetPages);
  const targetQueries = measurementPlan.targetQueries ? new Set(measurementPlan.targetQueries) : null;

  // An entry's own `window` (set when it was fetched, e.g. a trailing-28-day
  // GSC pull recorded on a later `date`) describes what period its rows
  // actually cover; prefer overlap against that over the fetch date itself.
  // Entries without a window (e.g. manual/websearch spot checks) fall back
  // to comparing the entry's date directly.
  const relevantEntries = rankHistory.entries.filter((e) =>
    e.window ? e.window.end >= window.start && e.window.start <= window.end : e.date >= window.start && e.date <= window.end,
  );
  const rows = relevantEntries
    .flatMap((e) => e.rows)
    .filter((r) => (r.page !== null ? targetPages.has(r.page) : false))
    .filter((r) => (targetQueries ? targetQueries.has(r.query) : true));

  const impressions = rows.reduce((sum, r) => sum + r.impressions, 0);
  const clicks = rows.reduce((sum, r) => sum + r.clicks, 0);
  const positionWeighted = rows.reduce((sum, r) => sum + r.position * r.impressions, 0);
  const position = impressions > 0 ? positionWeighted / impressions : 0;
  const ctr = impressions > 0 ? clicks / impressions : 0;

  const threshold = measurementPlan.minimumImpressions ?? 0;
  const sufficientData = rows.length > 0 && impressions >= threshold;

  return {
    at: now,
    source,
    window,
    scope: { targetPages: measurementPlan.targetPages, targetQueries: measurementPlan.targetQueries },
    metrics: { impressions, clicks, ctr, position },
    sufficientData,
  };
}
