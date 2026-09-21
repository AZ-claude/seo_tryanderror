import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dumpReviewInputs, runReviewDecision } from '../src/core/workflow/review.js';
import { saveExperiments, saveOpportunities } from '../src/infra/json-store.js';
import type { CheckpointDay, Experiment, GscAdapter, GscSummaryRow, Opportunity, ReviewCheckpoint } from '../src/core/types.js';

function stubCheckpoint(checkpointDay: CheckpointDay): ReviewCheckpoint {
  const snapshot = {
    at: '2026-01-01T00:00:00.000Z',
    source: 'gsc' as const,
    window: { start: '2026-01-01', end: '2026-01-01', days: 1 },
    scope: { targetPages: ['/a/'] },
    metrics: { impressions: 0, clicks: 0, ctr: 0, position: 0 },
    sufficientData: false,
  };
  return {
    at: '2026-01-01T00:00:00.000Z',
    checkpointDay,
    elapsedDays: checkpointDay,
    comparisonWindow: { beforeStart: '2026-01-01', beforeEnd: '2026-01-01', afterStart: '2026-01-02', afterEnd: '2026-01-02', days: 1 },
    before: snapshot,
    after: snapshot,
    decision: 'continue_observing',
    note: 'stub (already reviewed in an earlier test-fixture cycle)',
  };
}

/** A daily row per date so tests can assert exact equal-window aggregation. */
function dailyGscAdapter(dailyImpressions: Record<string, number>): GscAdapter {
  return {
    async fetchQueryPageMatrix(input) {
      const rows: GscSummaryRow[] = [];
      for (const [date, impressions] of Object.entries(dailyImpressions)) {
        if (date >= input.startDate && date <= input.endDate) {
          rows.push({ query: 'q', page: '/a/', clicks: 1, impressions, ctr: 1 / impressions, position: 10 });
        }
      }
      return { rows };
    },
  };
}

function experiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: 'EXP1',
    opportunityId: 'OPP1',
    hypothesisId: 'HYP1',
    action: { type: 'REVISE', targetPaths: ['/a/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
    measurementPlan: {
      targetPages: ['/a/'],
      primaryMetric: 'impressions',
      secondaryMetrics: ['clicks'],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
      minimumImpressions: 10,
    },
    status: 'observing',
    before: null,
    observation: { start: '2026-09-01', end: '2026-09-29', nextReviewDate: '2026-09-29' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    history: [{ at: '2026-09-01T00:00:00.000Z', type: 'observing' }],
    ...overrides,
  };
}

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'OPP1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    scope: { type: 'page', path: '/a/' },
    identity: { scopeKey: 'page:/a/', intentKey: 'content_gap:x' },
    kind: 'content_gap',
    title: 't',
    description: 'd',
    evidence: [],
    signals: { hasGscTraction: true, contentGapConfirmed: true, leveragesProprietaryData: false },
    status: 'promoted',
    history: [],
    ...overrides,
  };
}

async function withWorkdir<T>(
  fn: (paths: { experiments: string; opportunities: string; lock: string }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'seo-review-'));
  try {
    return await fn({
      experiments: join(dir, 'experiments.json'),
      opportunities: join(dir, 'opportunities.json'),
      lock: join(dir, '.run.lock'),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A run of daily impressions covering 8/26..9/15 (before) and 9/2..9/8 (after window for checkpoint 7).
const dailyImpressions: Record<string, number> = {};
for (let d = 26; d <= 31; d++) dailyImpressions[`2026-08-${d}`] = 4; // before window tail
for (let d = 1; d <= 15; d++) dailyImpressions[`2026-09-${String(d).padStart(2, '0')}`] = 4;

test('runReviewDecision: dry-run makes no persistent writes', async () => {
  await withWorkdir(async (paths) => {
    await saveExperiments(paths.experiments, [experiment()]);
    await saveOpportunities(paths.opportunities, [opportunity()]);
    const gsc = dailyGscAdapter(dailyImpressions);

    const result = await runReviewDecision(paths, gsc, {
      experimentId: 'EXP1',
      property: 'sc-domain:example.com',
      today: '2026-09-09',
      finalDataLagDays: 0,
      now: '2026-09-09T00:00:00.000Z',
      decisionInput: { decision: 'continue_observing', note: 'watching' },
      dryRun: true,
    });
    assert.equal(result.exitCode, 0);

    const raw = await readFile(paths.experiments, 'utf8');
    const saved = JSON.parse(raw).experiments[0];
    assert.equal(saved.status, 'observing');
    assert.equal(saved.checkpoints ?? undefined, undefined, 'dry-run must not persist a checkpoint');
  });
});

test('runReviewDecision: continue_observing records a checkpoint but does not change status', async () => {
  await withWorkdir(async (paths) => {
    await saveExperiments(paths.experiments, [experiment()]);
    await saveOpportunities(paths.opportunities, [opportunity()]);
    const gsc = dailyGscAdapter(dailyImpressions);

    const result = await runReviewDecision(paths, gsc, {
      experimentId: 'EXP1',
      property: 'sc-domain:example.com',
      today: '2026-09-09', // elapsed = 8 days since 9/1 -> smallest unrecorded tier (3) is due
      finalDataLagDays: 0,
      now: '2026-09-09T00:00:00.000Z',
      decisionInput: { decision: 'continue_observing', note: 'watching a bit longer' },
      dryRun: false,
    });
    assert.equal(result.exitCode, 0);

    const raw = await readFile(paths.experiments, 'utf8');
    const saved = JSON.parse(raw).experiments[0];
    assert.equal(saved.status, 'observing');
    assert.equal(saved.checkpoints.length, 1);
    assert.equal(saved.checkpoints[0].checkpointDay, 3);
    assert.equal(saved.history.length, 1, 'continue_observing must not append an ExperimentEvent');
  });
});

// 11 + 12. conclude persists after/result/learning and releases the Opportunity
test('runReviewDecision: conclude saves after/result/learning and releases the Opportunity (no other active Experiment)', async () => {
  await withWorkdir(async (paths) => {
    await saveExperiments(paths.experiments, [experiment()]);
    await saveOpportunities(paths.opportunities, [opportunity()]);
    const gsc = dailyGscAdapter(dailyImpressions);

    const result = await runReviewDecision(paths, gsc, {
      experimentId: 'EXP1',
      property: 'sc-domain:example.com',
      today: '2026-09-09',
      finalDataLagDays: 0,
      now: '2026-09-09T00:00:00.000Z',
      decisionInput: {
        decision: 'conclude',
        proposedOutcome: 'hypothesis_supported',
        note: 'clear improvement',
        learning: 'adding context links helps CTR on price hub pages',
      },
      dryRun: false,
    });
    assert.equal(result.exitCode, 0);

    const expRaw = JSON.parse(await readFile(paths.experiments, 'utf8')).experiments[0];
    assert.equal(expRaw.status, 'concluded');
    assert.ok(expRaw.after);
    assert.equal(expRaw.result.outcome, 'hypothesis_supported');
    assert.equal(expRaw.result.notes, 'clear improvement');
    assert.equal(expRaw.learning, 'adding context links helps CTR on price hub pages');
    assert.equal(expRaw.history.at(-1).type, 'concluded');

    const oppRaw = JSON.parse(await readFile(paths.opportunities, 'utf8')).opportunities[0];
    assert.equal(oppRaw.status, 'open', 'Opportunity should be released back to open');
  });
});

test('runReviewDecision: conclude does NOT release the Opportunity while another active Experiment still references it', async () => {
  await withWorkdir(async (paths) => {
    const otherActive = experiment({
      id: 'EXP2',
      action: { type: 'REVISE', targetPaths: ['/other-page/'], summary: 's2', requiredFacts: [], forbiddenChanges: [] },
      measurementPlan: {
        targetPages: ['/other-page/'],
        primaryMetric: 'impressions',
        secondaryMetrics: [],
        baselineWindowDays: 28,
        reviewWindowDays: 28,
      },
    });
    await saveExperiments(paths.experiments, [experiment(), otherActive]);
    await saveOpportunities(paths.opportunities, [opportunity()]);
    const gsc = dailyGscAdapter(dailyImpressions);

    await runReviewDecision(paths, gsc, {
      experimentId: 'EXP1',
      property: 'sc-domain:example.com',
      today: '2026-09-09',
      finalDataLagDays: 0,
      now: '2026-09-09T00:00:00.000Z',
      decisionInput: { decision: 'conclude', proposedOutcome: 'hypothesis_supported', note: 'done' },
      dryRun: false,
    });

    const oppRaw = JSON.parse(await readFile(paths.opportunities, 'utf8')).opportunities[0];
    assert.equal(oppRaw.status, 'promoted', 'must stay promoted: OPP1 still has an active Experiment (EXP2)');
  });
});

test('runReviewDecision: rejects conclude with a mismatched outcome (no_effect at an insufficient_data checkpoint)', async () => {
  await withWorkdir(async (paths) => {
    // Tiers 3/7/14 already reviewed (stubbed), so the final (28-day) tier is the one due;
    // zero GSC rows anywhere means it comes back insufficient, even at the final tier.
    await saveExperiments(paths.experiments, [
      experiment({
        observation: { start: '2026-06-01', end: '2026-06-29', nextReviewDate: '2026-06-29' },
        checkpoints: [stubCheckpoint(3), stubCheckpoint(7), stubCheckpoint(14)],
      }),
    ]);
    await saveOpportunities(paths.opportunities, [opportunity()]);
    const gsc = dailyGscAdapter({});

    const result = await runReviewDecision(paths, gsc, {
      experimentId: 'EXP1',
      property: 'sc-domain:example.com',
      today: '2026-09-09',
      finalDataLagDays: 0,
      now: '2026-09-09T00:00:00.000Z',
      decisionInput: { decision: 'conclude', proposedOutcome: 'no_effect', note: 'looks flat' },
      dryRun: true,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.report, /insufficient_data/);
  });
});

test('dumpReviewInputs: not observing -> error, no crash', async () => {
  const gsc = dailyGscAdapter(dailyImpressions);
  const result = await dumpReviewInputs([experiment({ status: 'proposed' })], gsc, {
    experimentId: 'EXP1',
    property: 'sc-domain:example.com',
    today: '2026-09-09',
    finalDataLagDays: 0,
    now: '2026-09-09T00:00:00.000Z',
  });
  assert.ok('error' in result);
});
