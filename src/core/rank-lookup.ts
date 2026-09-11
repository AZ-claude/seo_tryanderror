import type { RankHistory, RankMeasurement } from './types.js';

/**
 * Finds the most recent measurement for a keyword across all rank-history
 * entries, comparing by entry date (ties broken by array order, i.e. the
 * later-appended entry wins since history is append-only).
 */
export function getLatestMeasurement(
  keyword: string,
  rankHistory: RankHistory,
): RankMeasurement | null {
  let best: { date: string; measurement: RankMeasurement } | null = null;
  for (const entry of rankHistory.entries) {
    const measurement = entry.measurements.find((m) => m.keyword === keyword);
    if (!measurement) continue;
    if (!best || entry.date >= best.date) {
      best = { date: entry.date, measurement };
    }
  }
  return best?.measurement ?? null;
}

export function getLatestRank(keyword: string, rankHistory: RankHistory): number | null {
  return getLatestMeasurement(keyword, rankHistory)?.rank ?? null;
}
