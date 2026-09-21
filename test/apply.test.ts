import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApply } from '../src/core/workflow/apply.js';
import { saveExperiments } from '../src/infra/json-store.js';
import type { ApplyEvidence, Experiment } from '../src/core/types.js';

function experiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: 'EXP1',
    opportunityId: 'OPP1',
    hypothesisId: 'HYP1',
    action: { type: 'REVISE', targetPaths: ['/a/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
    measurementPlan: {
      targetPages: ['https://example.com/a/'],
      primaryMetric: 'impressions',
      secondaryMetrics: ['clicks'],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
    status: 'proposed',
    before: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    history: [{ at: '2026-09-01T00:00:00.000Z', type: 'proposed' }],
    ...overrides,
  };
}

function evidence(overrides: Partial<ApplyEvidence> = {}): ApplyEvidence {
  return {
    targetPage: 'https://example.com/a/',
    siteRepo: 'org/site',
    changedFiles: ['src/pages/a.astro'],
    actionSummary: 'added a short section',
    commitSha: 'abc123',
    commitBranch: 'master',
    bReview: { tool: 'seo_japanese', claimPreservation: { preserved: 1, modified: 0, invented: 0 } },
    siteValidation: { lintContent: 'PASS', build: 'PASS' },
    deployMethod: 'wrangler pages deploy',
    liveVerification: {
      httpStatus: 200,
      sectionPresent: true,
      existingSectionsIntact: ['existing'],
      canonicalUnchanged: true,
      noindexUnchanged: true,
    },
    ...overrides,
  };
}

async function withWorkdir<T>(fn: (paths: { experiments: string; lock: string }) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'seo-apply-'));
  try {
    return await fn({ experiments: join(dir, 'experiments.json'), lock: join(dir, '.run.lock') });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('runApply: dry-run validates and reports the transition chain without writing', async () => {
  await withWorkdir(async (paths) => {
    await saveExperiments(paths.experiments, [experiment()]);
    const result = await runApply(paths, {
      experimentId: 'EXP1',
      evidence: evidence(),
      today: '2026-09-21',
      now: '2026-09-21T00:00:00.000Z',
      dryRun: true,
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.report, /proposed -> approved -> applied -> observing/);

    const raw = await import('node:fs/promises').then((fs) => fs.readFile(paths.experiments, 'utf8'));
    const saved = JSON.parse(raw);
    assert.equal(saved.experiments[0].status, 'proposed', 'dry-run must not persist the transition');
  });
});

test('runApply: actual run persists proposed -> observing with append-only history and an observation window', async () => {
  await withWorkdir(async (paths) => {
    await saveExperiments(paths.experiments, [experiment()]);
    const result = await runApply(paths, {
      experimentId: 'EXP1',
      evidence: evidence(),
      today: '2026-09-21',
      now: '2026-09-21T00:00:00.000Z',
      dryRun: false,
    });
    assert.equal(result.exitCode, 0);

    const raw = await import('node:fs/promises').then((fs) => fs.readFile(paths.experiments, 'utf8'));
    const saved = JSON.parse(raw);
    const e = saved.experiments[0];
    assert.equal(e.status, 'observing');
    assert.equal(e.history.length, 4); // proposed (seeded) + approved + applied + observing
    assert.equal(e.history[0].type, 'proposed');
    assert.equal(e.history[3].type, 'observing');
    assert.deepEqual(e.observation, { start: '2026-09-21', end: '2026-10-19', nextReviewDate: '2026-10-19' });
  });
});

test('runApply: refuses when action.type is not REVISE', async () => {
  await withWorkdir(async (paths) => {
    await saveExperiments(paths.experiments, [experiment({ action: { type: 'CREATE', targetPaths: ['/a/'], summary: 's', requiredFacts: [], forbiddenChanges: [] } })]);
    const result = await runApply(paths, {
      experimentId: 'EXP1',
      evidence: evidence(),
      today: '2026-09-21',
      now: '2026-09-21T00:00:00.000Z',
      dryRun: true,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.report, /only supports action\.type === 'REVISE'/);
  });
});

test('runApply: refuses when B claim-preservation hard gate failed (invented > 0)', async () => {
  await withWorkdir(async (paths) => {
    await saveExperiments(paths.experiments, [experiment()]);
    const result = await runApply(paths, {
      experimentId: 'EXP1',
      evidence: evidence({ bReview: { tool: 'seo_japanese', claimPreservation: { preserved: 1, modified: 0, invented: 2 } } }),
      today: '2026-09-21',
      now: '2026-09-21T00:00:00.000Z',
      dryRun: true,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.report, /claim-preservation hard gate failed/);
  });
});

test('runApply: refuses when live verification HTTP status is not 200', async () => {
  await withWorkdir(async (paths) => {
    await saveExperiments(paths.experiments, [experiment()]);
    const result = await runApply(paths, {
      experimentId: 'EXP1',
      evidence: evidence({ liveVerification: { httpStatus: 500, sectionPresent: true, existingSectionsIntact: [], canonicalUnchanged: true, noindexUnchanged: true } }),
      today: '2026-09-21',
      now: '2026-09-21T00:00:00.000Z',
      dryRun: true,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.report, /HTTP status was 500/);
  });
});

test('runApply: refuses when Experiment status is not proposed (e.g. already observing)', async () => {
  await withWorkdir(async (paths) => {
    await saveExperiments(paths.experiments, [experiment({ status: 'observing' })]);
    const result = await runApply(paths, {
      experimentId: 'EXP1',
      evidence: evidence(),
      today: '2026-09-21',
      now: '2026-09-21T00:00:00.000Z',
      dryRun: true,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.report, /status must be 'proposed'/);
  });
});
