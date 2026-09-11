import type { ChangeType, ImprovementKeywordState, ReviewOutcome } from './types.js';

/**
 * Pure judgement of a single review comparison. See DESIGN.md section 11.
 * `insufficient_data` must never be conflated with `no_effect`.
 */
export function judgeReview(input: {
  previousRank: number | null;
  currentRank: number | null;
}): ReviewOutcome {
  const { previousRank, currentRank } = input;

  if (currentRank === 1) return 'achieved';
  if (previousRank === null || currentRank === null) return 'insufficient_data';
  if (currentRank < previousRank) return 'improved_not_achieved';
  if (currentRank > previousRank) return 'worse';
  return 'no_effect';
}

/** Status a keyword should move to after a review outcome. */
export function nextStatusForOutcome(outcome: ReviewOutcome): 'active' | 'observing' | 'achieved' {
  if (outcome === 'achieved') return 'achieved';
  if (outcome === 'insufficient_data') return 'observing';
  return 'active';
}

/**
 * Applies a review to a keyword's improvement-log state: records the
 * outcome on the most recent action, and transitions status/nextReviewDate.
 * Does not mutate the input; returns a new state object.
 */
export function applyReview(input: {
  state: ImprovementKeywordState;
  today: string;
  currentRank: number | null;
  notes: string;
  /** Required when the outcome is insufficient_data and review should be retried later. */
  retryReviewDate?: string;
}): ImprovementKeywordState {
  const { state, today, currentRank, notes, retryReviewDate } = input;
  const lastActionIndex = state.actions.length - 1;
  if (lastActionIndex < 0) {
    throw new Error(`cannot review keyword with no actions: ${state.keyword}`);
  }
  const lastAction = state.actions[lastActionIndex]!;
  const previousRank = lastAction.rankAtAction;
  const outcome = judgeReview({ previousRank, currentRank });
  const nextStatus = nextStatusForOutcome(outcome);

  const updatedActions = state.actions.map((action, i) =>
    i === lastActionIndex
      ? {
          ...action,
          review: { date: today, outcome, previousRank, currentRank, notes },
        }
      : action,
  );

  return {
    ...state,
    status: nextStatus,
    nextReviewDate:
      nextStatus === 'observing' ? (retryReviewDate ?? state.nextReviewDate) : null,
    actions: updatedActions,
  };
}

/**
 * The changeType to avoid as a first choice for the next plan, per
 * DESIGN.md section 11: after no_effect/worse, don't repeat the same
 * changeType by default.
 */
export function changeTypeToAvoid(state: ImprovementKeywordState): ChangeType | null {
  const lastAction = state.actions[state.actions.length - 1];
  if (!lastAction?.review) return null;
  if (lastAction.review.outcome === 'no_effect' || lastAction.review.outcome === 'worse') {
    return lastAction.changeType;
  }
  return null;
}
