import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffDays } from '../src/core/date.js';
import {
  METRIC_DIRECTION,
  assertOutcomeConsistentWithCheckpoint,
  computeComparisonWindow,
  computeDelta,
  decideCheckpoint,
  findDueCheckpoint,
  InvalidReviewOutcomeError,
} from '../src/core/review.js';
import type { MetricsSnapshot } from '../src/core/types.js';

function snapshot(overrides: Partial<MetricsSnapshot['metrics']> & { sufficientData?: boolean } = {}): MetricsSnapshot {
  const { sufficientData, ...metrics } = overrides;
  return {
    at: '2026-09-01T00:00:00.000Z',
    source: 'gsc',
    window: { start: '2026-08-01', end: '2026-08-07', days: 7 },
    scope: { targetPages: ['/a/'] },
    metrics: { impressions: 10, clicks: 1, ctr: 0.1, position: 20, ...metrics },
    sufficientData: sufficientData ?? true,
  };
}

// 1. equal-window before/after
test('computeComparisonWindow: before and after windows are equal length', () => {
  const w = computeComparisonWindow({
    observationStart: '2026-09-21',
    checkpointDay: 7,
    today: '2026-10-01',
    finalDataLagDays: 0,
  });
  assert.ok(w);
  assert.equal(w!.afterStart, '2026-09-22');
  assert.equal(w!.afterEnd, '2026-09-28');
  assert.equal(w!.beforeEnd, '2026-09-20');
  assert.equal(w!.beforeStart, '2026-09-14');
  assert.equal(w!.days, 7);
});

// 2. finalDataLagDays反映 + worked example from the user's spec
test('computeComparisonWindow: finalDataLagDays caps the after window (worked example: 9/21 deploy, lag=2, review 9/29)', () => {
  const w = computeComparisonWindow({
    observationStart: '2026-09-21',
    checkpointDay: 7,
    today: '2026-09-29',
    finalDataLagDays: 2,
  });
  assert.ok(w);
  assert.equal(w!.afterStart, '2026-09-22');
  assert.equal(w!.afterEnd, '2026-09-27'); // capped by today(9/29) - lag(2) = 9/27, not the ideal 9/28
  assert.equal(w!.days, 6);
  assert.equal(w!.beforeStart, '2026-09-15');
  assert.equal(w!.beforeEnd, '2026-09-20');

  // deploy day (observationStart) is excluded from both sides, and before/after never overlap
  assert.notEqual(w!.beforeEnd, '2026-09-21');
  assert.notEqual(w!.afterStart, '2026-09-21');
  assert.ok(w!.beforeEnd < w!.afterStart);
  assert.equal(diffDays(w!.beforeStart, w!.beforeEnd) + 1, diffDays(w!.afterStart, w!.afterEnd) + 1);
});

// 3. deploy当日をbefore/afterのどちらからも完全除外
test('computeComparisonWindow: the deploy/observation-start day itself is excluded from BOTH the before and after windows', () => {
  const w = computeComparisonWindow({
    observationStart: '2026-09-21',
    checkpointDay: 3,
    today: '2026-09-25',
    finalDataLagDays: 0,
  });
  assert.ok(w);
  assert.notEqual(w!.afterStart, '2026-09-21');
  assert.equal(w!.afterStart, '2026-09-22');
  assert.notEqual(w!.beforeEnd, '2026-09-21');
  assert.equal(w!.beforeEnd, '2026-09-20'); // before window ends the day BEFORE the deploy day
});

test('computeComparisonWindow: no post-change final data yet -> null', () => {
  const w = computeComparisonWindow({
    observationStart: '2026-09-21',
    checkpointDay: 3,
    today: '2026-09-21',
    finalDataLagDays: 2,
  });
  assert.equal(w, null);
});

// 4. 3/7/14/28 checkpoint
test('findDueCheckpoint: picks the smallest not-yet-recorded tier that has arrived', () => {
  const due = findDueCheckpoint({
    observationStart: '2026-09-01',
    today: '2026-09-16',
    finalDataLagDays: 0,
    recordedCheckpointDays: [],
  });
  assert.ok(due);
  assert.equal(due!.checkpointDay, 3);
});

test('findDueCheckpoint: elapsed < 3 -> nothing due', () => {
  const due = findDueCheckpoint({
    observationStart: '2026-09-21',
    today: '2026-09-22',
    finalDataLagDays: 0,
    recordedCheckpointDays: [],
  });
  assert.equal(due, null);
});

// 5. duplicate checkpoint禁止
test('findDueCheckpoint: an already-recorded tier is skipped, moving to the next one', () => {
  const due = findDueCheckpoint({
    observationStart: '2026-09-01',
    today: '2026-09-16',
    finalDataLagDays: 0,
    recordedCheckpointDays: [3],
  });
  assert.ok(due);
  assert.equal(due!.checkpointDay, 7);
});

test('findDueCheckpoint: all tiers already recorded -> null', () => {
  const due = findDueCheckpoint({
    observationStart: '2026-01-01',
    today: '2026-09-16',
    finalDataLagDays: 0,
    recordedCheckpointDays: [3, 7, 14, 28],
  });
  assert.equal(due, null);
});

// 6. minimumImpressions未達 → continue (non-final tier)
test('decideCheckpoint: insufficient data at a non-final tier -> continue_observing, never insufficient_data', () => {
  const after = snapshot({ sufficientData: false });
  assert.equal(decideCheckpoint(after, 7), 'continue_observing');
  assert.equal(decideCheckpoint(after, 14), 'continue_observing');
});

// 7. final checkpoint未達 → insufficient_data
test('decideCheckpoint: insufficient data at the final (28-day) tier -> insufficient_data', () => {
  const after = snapshot({ sufficientData: false });
  assert.equal(decideCheckpoint(after, 28), 'insufficient_data');
});

test('decideCheckpoint: sufficient data at any tier -> ready_to_conclude', () => {
  const after = snapshot({ sufficientData: true });
  assert.equal(decideCheckpoint(after, 7), 'ready_to_conclude');
  assert.equal(decideCheckpoint(after, 28), 'ready_to_conclude');
});

// 8. no_effectとinsufficient_dataの区別
test('assertOutcomeConsistentWithCheckpoint: no_effect is rejected when the checkpoint is actually insufficient_data', () => {
  assert.throws(() => assertOutcomeConsistentWithCheckpoint('insufficient_data', 'no_effect'), InvalidReviewOutcomeError);
});

test('assertOutcomeConsistentWithCheckpoint: insufficient_data is rejected when the checkpoint has sufficient data', () => {
  assert.throws(
    () => assertOutcomeConsistentWithCheckpoint('ready_to_conclude', 'insufficient_data'),
    InvalidReviewOutcomeError,
  );
});

test('assertOutcomeConsistentWithCheckpoint: conclude is rejected outright while continue_observing', () => {
  assert.throws(
    () => assertOutcomeConsistentWithCheckpoint('continue_observing', 'hypothesis_supported'),
    InvalidReviewOutcomeError,
  );
});

test('assertOutcomeConsistentWithCheckpoint: matching outcomes pass', () => {
  assert.doesNotThrow(() => assertOutcomeConsistentWithCheckpoint('insufficient_data', 'insufficient_data'));
  assert.doesNotThrow(() => assertOutcomeConsistentWithCheckpoint('ready_to_conclude', 'hypothesis_supported'));
  assert.doesNotThrow(() => assertOutcomeConsistentWithCheckpoint('ready_to_conclude', 'no_effect'));
});

// 9. positionはlower-is-better
test('METRIC_DIRECTION: position is lower_better, the other three are higher_better', () => {
  assert.equal(METRIC_DIRECTION.position, 'lower_better');
  assert.equal(METRIC_DIRECTION.impressions, 'higher_better');
  assert.equal(METRIC_DIRECTION.clicks, 'higher_better');
  assert.equal(METRIC_DIRECTION.ctr, 'higher_better');
});

test('computeDelta: plain after-minus-before per metric, no interpretation', () => {
  const before = snapshot({ impressions: 10, clicks: 1, ctr: 0.25, position: 20 });
  const after = snapshot({ impressions: 15, clicks: 3, ctr: 0.5, position: 12 });
  assert.deepEqual(computeDelta(before, after), { impressions: 5, clicks: 2, ctr: 0.25, position: -8 });
});
