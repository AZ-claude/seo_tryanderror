import { computeMeasurementWindow } from './date.js';
import type { MeasurementPlan, MetricsSnapshot, MetricsSnapshotSource, RankHistory, RankHistoryEntry } from './types.js';

/**
 * An entry's own `window` (set when it was fetched, e.g. a trailing-28-day
 * GSC pull recorded on a later `date`) describes what period its rows
 * actually cover; prefer overlap against that over the fetch date itself.
 * Entries without a window (e.g. manual/websearch spot checks) fall back to
 * comparing the entry's date directly.
 */
function overlapsWindow(entry: RankHistoryEntry, window: { start: string; end: string }): boolean {
  return entry.window
    ? entry.window.end >= window.start && entry.window.start <= window.end
    : entry.date >= window.start && entry.date <= window.end;
}

/**
 * Each rank-history entry is a pre-aggregated snapshot for its own window,
 * not daily raw data — two entries with overlapping windows (e.g. two
 * trailing-28-day GSC pulls a day apart) describe mostly the same
 * underlying clicks/impressions counted twice over. Summing across entries
 * would double-count. Pick exactly one: the most recently fetched entry
 * (by date, tie-broken by window end) among the candidates that both match
 * the requested `source` and overlap the target window.
 */
function pickSnapshotEntry(
  entries: RankHistoryEntry[],
  source: MetricsSnapshotSource,
  window: { start: string; end: string },
): RankHistoryEntry | null {
  const candidates = entries.filter((e) => e.source === source && overlapsWindow(e, window));
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, candidate) => {
    if (candidate.date !== latest.date) return candidate.date > latest.date ? candidate : latest;
    const candidateEnd = candidate.window?.end ?? candidate.date;
    const latestEnd = latest.window?.end ?? latest.date;
    return candidateEnd > latestEnd ? candidate : latest;
  });
}

/**
 * DESIGN.md 6.5.3: before/after snapshots are computed by extracting only
 * the rank-history rows matching `measurementPlan.targetPages`/
 * `targetQueries` (never the whole matrix) from a single selected snapshot
 * entry (see `pickSnapshotEntry`) — never summed across overlapping GSC
 * pulls. `sufficientData` is false only when there is no matching snapshot
 * or data at all, or the aggregate is below `minimumImpressions` — this
 * must never be conflated with a genuine "no effect" measurement.
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

  const selectedEntry = pickSnapshotEntry(rankHistory.entries, source, window);
  const rows = (selectedEntry?.rows ?? [])
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
