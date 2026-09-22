import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReject } from '../src/core/workflow/reject.js';
import { saveExperiments, saveOpportunities } from '../src/infra/json-store.js';
import type { Experiment, Opportunity } from '../src/core/types.js';

function experiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: 'EXP1',
    opportunityId: 'OPP1',
    hypothesisId: 'HYP1',
    action: { type: 'REVISE', targetPaths: ['/a/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
    measurementPlan: {
      targetPages: ['/a/'],
      primaryMetric: 'impressions',
      secondaryMetrics: [],
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

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'OPP1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    scope: { type: 'page', path: '/a/' },
    identity: { scopeKey: 'page:/a/', intentKey: 'ctr_title:x' },
    kind: 'ctr_title',
    title: 't',
    description: 'd',
    evidence: [],
    signals: { hasGscTraction: false, contentGapConfirmed: false, leveragesProprietaryData: false },
    status: 'promoted',
    history: [],
    ...overrides,
  };
}

async function withWorkdir<T>(
  fn: (paths: { experiments: string; opportunities: string; lock: string }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'seo-reject-'));
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

test('runReject: proposed -> rejected, history preserved (not discarded), Opportunity released back to open', async () => {
  await withWorkdir(async (paths) => {
    await saveExperiments(paths.experiments, [experiment()]);
    await saveOpportunities(paths.opportunities, [opportunity()]);

    const result = await runReject(paths, {
      experimentId: 'EXP1',
      reason: 'kind mismatch: this is intent_mismatch, not ctr_title',
      now: '2026-09-23T00:00:00.000Z',
      dryRun: false,
    });
    assert.equal(result.exitCode, 0);

    const saved = JSON.parse(await readFile(paths.experiments, 'utf8')).experiments[0];
    assert.equal(saved.status, 'rejected');
    assert.equal(saved.history.length, 2, 'the original "proposed" event must still be there, plus the new "rejected" one');
    assert.equal(saved.history[0].type, 'proposed');
    assert.equal(saved.history[1].type, 'rejected');
    assert.match(saved.history[1].note, /kind mismatch/);

    const oppSaved = JSON.parse(await readFile(paths.opportunities, 'utf8')).opportunities[0];
    assert.equal(oppSaved.status, 'open', 'promoted Opportunity must be released back to open once its only active Experiment is rejected');
    assert.equal(oppSaved.kind, 'ctr_title', 'reject must never rewrite the Opportunity.kind (part of its identity)');
  });
});

test('runReject: does NOT release the Opportunity while another active Experiment still references it', async () => {
  await withWorkdir(async (paths) => {
    const other = experiment({ id: 'EXP2', status: 'observing', observation: { start: '2026-09-01', end: '2026-09-29', nextReviewDate: '2026-09-29' } });
    await saveExperiments(paths.experiments, [experiment(), other]);
    await saveOpportunities(paths.opportunities, [opportunity()]);

    await runReject(paths, { experimentId: 'EXP1', reason: 'r', now: '2026-09-23T00:00:00.000Z', dryRun: false });

    const oppSaved = JSON.parse(await readFile(paths.opportunities, 'utf8')).opportunities[0];
    assert.equal(oppSaved.status, 'promoted', 'must stay promoted: EXP2 is still active on the same Opportunity');
  });
});

test('runReject: dry-run makes no persistent writes', async () => {
  await withWorkdir(async (paths) => {
    await saveExperiments(paths.experiments, [experiment()]);
    await saveOpportunities(paths.opportunities, [opportunity()]);
    const before = await readFile(paths.experiments, 'utf8');

    const result = await runReject(paths, { experimentId: 'EXP1', reason: 'r', now: '2026-09-23T00:00:00.000Z', dryRun: true });
    assert.equal(result.exitCode, 0);
    assert.match(result.report, /DRY RUN/);
    assert.equal(await readFile(paths.experiments, 'utf8'), before);
  });
});

test('runReject: a terminal Experiment (already concluded) cannot be rejected — reuses the same transition guard as everything else', async () => {
  await withWorkdir(async (paths) => {
    await saveExperiments(paths.experiments, [experiment({ status: 'concluded' })]);
    await saveOpportunities(paths.opportunities, [opportunity()]);

    const result = await runReject(paths, { experimentId: 'EXP1', reason: 'r', now: '2026-09-23T00:00:00.000Z', dryRun: false });
    assert.equal(result.exitCode, 1);
    assert.match(result.report, /invalid experiment status transition/);
  });
});

test('runReject: unknown experiment id -> error, no crash', async () => {
  await withWorkdir(async (paths) => {
    await saveExperiments(paths.experiments, [experiment()]);
    const result = await runReject(paths, { experimentId: 'NOPE', reason: 'r', now: '2026-09-23T00:00:00.000Z', dryRun: false });
    assert.equal(result.exitCode, 1);
    assert.match(result.report, /no Experiment found/);
  });
});
