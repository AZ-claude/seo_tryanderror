import type { RankHistory, RankMeasurement, RankSource } from './types.js';

/**
 * Finds the most recent measurement for a keyword across all rank-history
 * entries, comparing by entry date (ties broken by array order, i.e. the
 * later-appended entry wins since history is append-only).
 */
export function getLatestMeasurementWithSource(
  keyword: string,
  rankHistory: RankHistory,
): { source: RankSource; measurement: RankMeasurement } | null {
  let best: { date: string; source: RankSource; measurement: RankMeasurement } | null = null;
  for (const entry of rankHistory.entries) {
    const measurement = entry.measurements.find((m) => m.keyword === keyword);
    if (!measurement) continue;
    if (!best || entry.date >= best.date) {
      best = { date: entry.date, source: entry.source, measurement };
    }
  }
  return best ? { source: best.source, measurement: best.measurement } : null;
}

export function getLatestMeasurement(keyword: string, rankHistory: RankHistory): RankMeasurement | null {
  return getLatestMeasurementWithSource(keyword, rankHistory)?.measurement ?? null;
}

export function getLatestRank(keyword: string, rankHistory: RankHistory): number | null {
  return getLatestMeasurement(keyword, rankHistory)?.rank ?? null;
}
