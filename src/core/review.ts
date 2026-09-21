import { addDays, diffDays } from './date.js';
import { CHECKPOINT_DAYS } from './types.js';
import type { CheckpointDay, MetricKey, MetricsSnapshot, ReviewCheckpoint, ReviewOutcome } from './types.js';

/**
 * Equal-length before/after comparison window for a rolling checkpoint
 * (never a trailing-N-day GSC window compared against itself — see
 * DESIGN.md rolling PDCA rationale). `afterStart` is the day after
 * `observationStart` (the apply/deploy day itself is excluded from "after"
 * since it may only be partially post-change); `beforeEnd` is
 * `observationStart` itself, so before/after never overlap. The after
 * window is capped by the latest confirmed-final GSC date
 * (`today - finalDataLagDays`); if that cap falls before `afterStart`,
 * there is no post-change final data at all yet and this returns null.
 */
export function computeComparisonWindow(input: {
  observationStart: string;
  checkpointDay: CheckpointDay;
  today: string;
  finalDataLagDays: number;
}): ReviewCheckpoint['comparisonWindow'] | null {
  const { observationStart, checkpointDay, today, finalDataLagDays } = input;
  const afterStart = addDays(observationStart, 1);
  const idealAfterEnd = addDays(observationStart, checkpointDay);
  const latestFinal = addDays(today, -finalDataLagDays);
  const afterEnd = idealAfterEnd < latestFinal ? idealAfterEnd : latestFinal;

  const days = diffDays(afterStart, afterEnd) + 1;
  if (days <= 0) return null;

  const beforeEnd = observationStart;
  const beforeStart = addDays(beforeEnd, -(days - 1));
  return { beforeStart, beforeEnd, afterStart, afterEnd, days };
}

/**
 * The smallest not-yet-recorded checkpoint tier that has both (a) arrived
 * chronologically (`checkpointDay <= elapsedDays`) and (b) has at least one
 * day of post-change final GSC data available. Returns null when nothing is
 * due yet (either too early, or final data hasn't landed for even the
 * smallest un-recorded tier — larger tiers can't be ready either, since a
 * bigger tier only ever caps `afterEnd` at the same `latestFinal`).
 */
export function findDueCheckpoint(input: {
  observationStart: string;
  today: string;
  finalDataLagDays: number;
  recordedCheckpointDays: CheckpointDay[];
}): { checkpointDay: CheckpointDay; comparisonWindow: ReviewCheckpoint['comparisonWindow']; elapsedDays: number } | null {
  const { observationStart, today, finalDataLagDays, recordedCheckpointDays } = input;
  const elapsedDays = diffDays(observationStart, today);
  const recorded = new Set(recordedCheckpointDays);

  for (const checkpointDay of CHECKPOINT_DAYS) {
    if (recorded.has(checkpointDay)) continue;
    if (checkpointDay > elapsedDays) return null; // tiers are ascending; nothing further is due yet
    const comparisonWindow = computeComparisonWindow({ observationStart, checkpointDay, today, finalDataLagDays });
    if (!comparisonWindow) return null; // no post-change final data yet; a larger tier won't have more either
    return { checkpointDay, comparisonWindow, elapsedDays };
  }
  return null; // every tier already recorded
}

/**
 * Mechanical, threshold-free decision (DESIGN.md YAGNI: no statistical
 * engine). `sufficientData` already encodes the `minimumImpressions` rule
 * (DESIGN.md 6.5.3). insufficient_data is only allowed once the final
 * (28-day) tier is reached — earlier tiers with too little data just keep
 * observing, never auto-conclude as "insufficient".
 */
export function decideCheckpoint(after: MetricsSnapshot, checkpointDay: CheckpointDay): ReviewCheckpoint['decision'] {
  if (after.sufficientData) return 'ready_to_conclude';
  return checkpointDay === 28 ? 'insufficient_data' : 'continue_observing';
}

const DELTA_METRICS: MetricKey[] = ['impressions', 'clicks', 'ctr', 'position'];

/**
 * Direction metadata only — for the Skill's semantic outcome judgment
 * (DESIGN.md section 7: core never invents a %-threshold "success" rule).
 * `position` is the one metric where lower is better (closer to rank #1).
 */
export const METRIC_DIRECTION: Record<'impressions' | 'clicks' | 'ctr' | 'position', 'higher_better' | 'lower_better'> = {
  impressions: 'higher_better',
  clicks: 'higher_better',
  ctr: 'higher_better',
  position: 'lower_better',
};

/** Plain after-minus-before delta per metric; no interpretation (that's the Skill's job). */
export function computeDelta(before: MetricsSnapshot, after: MetricsSnapshot): Partial<Record<MetricKey, number>> {
  const delta: Partial<Record<MetricKey, number>> = {};
  for (const key of DELTA_METRICS) {
    const b = before.metrics[key];
    const a = after.metrics[key];
    if (b !== undefined && a !== undefined) delta[key] = a - b;
  }
  return delta;
}

export class InvalidReviewOutcomeError extends Error {
  readonly code = 'INVALID_REVIEW_OUTCOME';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReviewOutcomeError';
  }
}

/**
 * Core-side sanity guard on the Skill's semantic call (DESIGN.md: core owns
 * state consistency, the Skill owns meaning) — never let 'insufficient_data'
 * be used as a normal outcome, and never let a normal outcome paper over a
 * checkpoint that mechanically doesn't have enough data.
 */
export function assertOutcomeConsistentWithCheckpoint(
  checkpointDecision: ReviewCheckpoint['decision'],
  proposedOutcome: ReviewOutcome,
): void {
  if (checkpointDecision === 'continue_observing') {
    throw new InvalidReviewOutcomeError(
      'cannot conclude: this checkpoint is continue_observing (not enough data yet and not the final 28-day tier)',
    );
  }
  if (checkpointDecision === 'insufficient_data' && proposedOutcome !== 'insufficient_data') {
    throw new InvalidReviewOutcomeError(
      `checkpoint has insufficient data at the final tier; proposedOutcome must be 'insufficient_data', got '${proposedOutcome}'`,
    );
  }
  if (checkpointDecision === 'ready_to_conclude' && proposedOutcome === 'insufficient_data') {
    throw new InvalidReviewOutcomeError(
      "checkpoint has sufficient data (ready_to_conclude); proposedOutcome cannot be 'insufficient_data'",
    );
  }
}
