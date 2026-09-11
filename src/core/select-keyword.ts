import { getLatestMeasurement } from './rank-lookup.js';
import type { ImprovementLog, KeywordRecord, Priority, RankHistory, UnregisteredQuery } from './types.js';

const PRIORITY_WEIGHT: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

/**
 * Selects at most one keyword to work on this run, following the bucket
 * priority order in DESIGN.md section 12. `activeCandidates` must already be
 * filtered to exclude observing/achieved keywords (see getStatus()).
 *
 * Only buckets 1-4 are eligible for automatic selection; unregistered
 * queries (bucket 5) are report-only suggestions and never auto-selected.
 */
export function selectKeyword(input: {
  activeCandidates: KeywordRecord[];
  rankHistory: RankHistory;
  improvementLog: ImprovementLog;
}): KeywordRecord | null {
  const { activeCandidates, rankHistory, improvementLog } = input;
  const stateByKeyword = new Map(improvementLog.keywords.map((k) => [k.keyword, k]));

  const withMeasurement = activeCandidates.map((kw) => ({
    kw,
    measurement: getLatestMeasurement(kw.keyword, rankHistory),
  }));

  // Bucket 1: rank 2-10 and impressions > 0
  const bucket1 = withMeasurement.filter(
    ({ measurement }) =>
      measurement !== null &&
      measurement.rank !== null &&
      measurement.rank >= 2 &&
      measurement.rank <= 10 &&
      measurement.impressions > 0,
  );
  if (bucket1.length > 0) {
    bucket1.sort((a, b) => {
      const rankDiff = (a.measurement!.rank as number) - (b.measurement!.rank as number);
      if (rankDiff !== 0) return rankDiff;
      const impressionDiff = b.measurement!.impressions - a.measurement!.impressions;
      if (impressionDiff !== 0) return impressionDiff;
      return PRIORITY_WEIGHT[a.kw.priority] - PRIORITY_WEIGHT[b.kw.priority];
    });
    return bucket1[0]!.kw;
  }

  // Bucket 2: rank 11-20 and impressions > 0
  const bucket2 = withMeasurement.filter(
    ({ measurement }) =>
      measurement !== null &&
      measurement.rank !== null &&
      measurement.rank > 10 &&
      measurement.rank <= 20 &&
      measurement.impressions > 0,
  );
  if (bucket2.length > 0) {
    bucket2.sort((a, b) => {
      const impressionDiff = b.measurement!.impressions - a.measurement!.impressions;
      if (impressionDiff !== 0) return impressionDiff;
      const rankDiff = (a.measurement!.rank as number) - (b.measurement!.rank as number);
      if (rankDiff !== 0) return rankDiff;
      return PRIORITY_WEIGHT[a.kw.priority] - PRIORITY_WEIGHT[b.kw.priority];
    });
    return bucket2[0]!.kw;
  }

  // Bucket 3: previously actioned, still active. Oldest last-review first;
  // never-reviewed actions sort as oldest (they take priority).
  const bucket3 = activeCandidates
    .map((kw) => ({ kw, state: stateByKeyword.get(kw.keyword) }))
    .filter(({ state }) => state && state.actions.length > 0);
  if (bucket3.length > 0) {
    const lastReviewDate = (state: NonNullable<(typeof bucket3)[number]['state']>): string => {
      const lastAction = state.actions[state.actions.length - 1]!;
      return lastAction.review?.date ?? '0000-00-00';
    };
    bucket3.sort((a, b) => lastReviewDate(a.state!).localeCompare(lastReviewDate(b.state!)));
    return bucket3[0]!.kw;
  }

  // Bucket 4: rank null and priority high
  const bucket4 = withMeasurement.filter(
    ({ measurement, kw }) => (measurement === null || measurement.rank === null) && kw.priority === 'high',
  );
  if (bucket4.length > 0) {
    return bucket4[0]!.kw;
  }

  return null;
}

/** Bucket 5: report-only suggestions, never auto-selected. */
export function suggestUnregisteredQueries(queries: UnregisteredQuery[]): UnregisteredQuery[] {
  return [...queries].sort((a, b) => b.impressions - a.impressions);
}
