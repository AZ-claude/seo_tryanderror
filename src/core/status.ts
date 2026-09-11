import { getLatestRank } from './rank-lookup.js';
import type { ImprovementLog, KeywordRecord, RankHistory, StatusBuckets } from './types.js';
import { isBeforeOrEqual } from './date.js';

/**
 * Classifies every watched keyword into one bucket. See DESIGN.md section 10.
 *
 * - achieved -> achieved
 * - observing && nextReviewDate <= today -> dueForReview
 * - observing && nextReviewDate > today -> observing
 * - else (no state, or status 'active') -> active
 *
 * `active` is sorted by latest known rank ascending (better rank first);
 * keywords with no measurement yet (rank === null) sort last.
 */
export function getStatus(input: {
  watchwords: KeywordRecord[];
  improvementLog: ImprovementLog;
  rankHistory: RankHistory;
  today: string;
}): StatusBuckets {
  const { watchwords, improvementLog, rankHistory, today } = input;
  const stateByKeyword = new Map(improvementLog.keywords.map((k) => [k.keyword, k]));

  const buckets: StatusBuckets = {
    dueForReview: [],
    observing: [],
    active: [],
    achieved: [],
  };

  for (const kw of watchwords) {
    const state = stateByKeyword.get(kw.keyword);

    if (state?.status === 'achieved') {
      buckets.achieved.push(kw);
      continue;
    }

    if (state?.status === 'observing') {
      if (state.nextReviewDate && isBeforeOrEqual(state.nextReviewDate, today)) {
        buckets.dueForReview.push(kw);
      } else {
        buckets.observing.push(kw);
      }
      continue;
    }

    buckets.active.push(kw);
  }

  buckets.active.sort((a, b) => {
    const rankA = getLatestRank(a.keyword, rankHistory);
    const rankB = getLatestRank(b.keyword, rankHistory);
    if (rankA === null && rankB === null) return 0;
    if (rankA === null) return 1;
    if (rankB === null) return -1;
    return rankA - rankB;
  });

  return buckets;
}
