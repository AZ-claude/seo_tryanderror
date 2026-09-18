import type { Experiment, Opportunity } from './types.js';

export type ExcludedOpportunity = { id: string; reason: string };

export type PrioritizeResult = {
  ranked: Opportunity[];
  excluded: ExcludedOpportunity[];
};

const RETRY_OUTCOMES = new Set(['no_effect', 'worse', 'partially_supported']);

/**
 * True when the Opportunity had a concluded Experiment with a non-supporting
 * outcome, and has gathered new evidence (collected after that Experiment
 * was created) since then. Backs bucket 4, DESIGN.md 10.4.
 */
function isRetryCandidate(opportunity: Opportunity, experiments: Experiment[]): boolean {
  const pastAttempts = experiments.filter(
    (e) =>
      e.opportunityId === opportunity.id &&
      e.status === 'concluded' &&
      e.result &&
      RETRY_OUTCOMES.has(e.result.outcome),
  );
  if (pastAttempts.length === 0) return false;
  const mostRecent = pastAttempts.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  return opportunity.evidence.some((ev) => ev.collectedAt > mostRecent.createdAt);
}

function bucketOf(opportunity: Opportunity, experiments: Experiment[]): 1 | 2 | 3 | 4 | 5 {
  const { signals, scope } = opportunity;
  if (signals.hasGscTraction && signals.contentGapConfirmed && scope.type === 'page') return 1;
  if (signals.hasGscTraction && scope.type === 'cluster') return 2;
  if (signals.leveragesProprietaryData) return 3;
  if (isRetryCandidate(opportunity, experiments)) return 4;
  return 5;
}

function compareTieBreak(a: Opportunity, b: Opportunity): number {
  if (a.evidence.length !== b.evidence.length) return b.evidence.length - a.evidence.length; // more evidence first
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1; // older first
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * DESIGN.md 10.4: explicit bucket priority, no scoring engine, no dependence
 * on GSC rank position. Only `status === 'open'` Opportunities are eligible.
 */
export function prioritizeOpportunities(input: {
  opportunities: Opportunity[];
  experiments: Experiment[];
}): PrioritizeResult {
  const { opportunities, experiments } = input;
  const excluded: ExcludedOpportunity[] = [];
  const eligible: Opportunity[] = [];

  for (const o of opportunities) {
    if (o.status !== 'open') {
      excluded.push({ id: o.id, reason: `status is ${o.status}, not open` });
      continue;
    }
    eligible.push(o);
  }

  const withBucket = eligible.map((o) => ({ o, bucket: bucketOf(o, experiments) }));
  withBucket.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket;
    return compareTieBreak(a.o, b.o);
  });

  return { ranked: withBucket.map((x) => x.o), excluded };
}
