import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ActiveExperimentGuardError,
  OpportunityNotOpenError,
  assertCanCreateExperiment,
  buildExperiment,
  transitionExperiment,
} from '../src/core/experiment.js';
import { promoteOpportunity, releaseOpportunity } from '../src/core/opportunity.js';
import type { Experiment, Hypothesis, Opportunity } from '../src/core/types.js';

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'OPP1',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    scope: { type: 'page', path: '/a/' },
    identity: { scopeKey: 'page:/a/', intentKey: 'content_gap:x' },
    kind: 'content_gap',
    title: 'title',
    description: 'desc',
    evidence: [],
    signals: { hasGscTraction: false, contentGapConfirmed: false, leveragesProprietaryData: false },
    status: 'open',
    history: [],
    ...overrides,
  };
}

const hypothesis: Hypothesis = {
  id: 'HYP1',
  opportunityId: 'OPP1',
  createdAt: '2026-09-01T00:00:00.000Z',
  statement: 'stmt',
  expectedSignals: ['ctr'],
  rationale: 'r',
};

const action = { type: 'REVISE' as const, targetPaths: ['/a/'], summary: 's', requiredFacts: [], forbiddenChanges: [] };
const measurementPlan = { targetPages: ['/a/'], primaryMetric: 'ctr' as const, secondaryMetrics: [], baselineWindowDays: 28, reviewWindowDays: 7 };

test('assertCanCreateExperiment allows creation when opportunity is open and has no active experiment', () => {
  assert.doesNotThrow(() => assertCanCreateExperiment(opportunity(), []));
});

test('assertCanCreateExperiment rejects when opportunity is not open', () => {
  assert.throws(() => assertCanCreateExperiment(opportunity({ status: 'promoted' }), []), OpportunityNotOpenError);
  assert.throws(() => assertCanCreateExperiment(opportunity({ status: 'rejected' }), []), OpportunityNotOpenError);
});

test('active experiment guard: rejects a second Experiment while one is non-terminal, for each active status', () => {
  for (const status of ['proposed', 'approved', 'applied', 'observing'] as const) {
    const existing: Experiment = {
      id: 'EXP1',
      opportunityId: 'OPP1',
      hypothesisId: 'HYP1',
      action,
      measurementPlan,
      status,
      before: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      history: [],
    };
    assert.throws(
      () => assertCanCreateExperiment(opportunity(), [existing]),
      ActiveExperimentGuardError,
      `expected guard to reject when an experiment is ${status}`,
    );
  }
});

test('active experiment guard: allows a new Experiment once the prior one is terminal', () => {
  for (const status of ['concluded', 'rejected'] as const) {
    const existing: Experiment = {
      id: 'EXP1',
      opportunityId: 'OPP1',
      hypothesisId: 'HYP1',
      action,
      measurementPlan,
      status,
      before: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      history: [],
    };
    // Terminal experiment means the opportunity should already be released back to 'open'.
    assert.doesNotThrow(() => assertCanCreateExperiment(opportunity({ status: 'open' }), [existing]));
  }
});

test('valid status transitions succeed and append history', () => {
  const experiment = buildExperiment({ opportunity: opportunity(), hypothesis, action, measurementPlan, before: null, now: '2026-09-01T00:00:00.000Z' });
  const approved = transitionExperiment(experiment, 'approved', '2026-09-02T00:00:00.000Z');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.history.length, 2);
  const applied = transitionExperiment(approved, 'applied', '2026-09-03T00:00:00.000Z');
  const observing = transitionExperiment(applied, 'observing', '2026-09-04T00:00:00.000Z');
  const concluded = transitionExperiment(observing, 'concluded', '2026-09-11T00:00:00.000Z');
  assert.equal(concluded.status, 'concluded');
  assert.equal(concluded.history.length, 5);
});

test('invalid status transitions throw', () => {
  const experiment = buildExperiment({ opportunity: opportunity(), hypothesis, action, measurementPlan, before: null, now: '2026-09-01T00:00:00.000Z' });
  assert.throws(() => transitionExperiment(experiment, 'observing', '2026-09-02T00:00:00.000Z'));
  const concluded = transitionExperiment(
    transitionExperiment(
      transitionExperiment(transitionExperiment(experiment, 'approved', '2026-09-02T00:00:00.000Z'), 'applied', '2026-09-03T00:00:00.000Z'),
      'observing',
      '2026-09-04T00:00:00.000Z',
    ),
    'concluded',
    '2026-09-11T00:00:00.000Z',
  );
  assert.throws(() => transitionExperiment(concluded, 'approved', '2026-09-12T00:00:00.000Z'));
});

test('promote sets Opportunity to promoted with a promoted event; release returns it to open with a released event', () => {
  const promoted = promoteOpportunity(opportunity(), 'EXP1', '2026-09-01T00:00:00.000Z');
  assert.equal(promoted.status, 'promoted');
  assert.equal(promoted.history[promoted.history.length - 1]!.type, 'promoted');
  assert.equal(promoted.history[promoted.history.length - 1]!.relatedExperimentId, 'EXP1');

  const released = releaseOpportunity(promoted, 'EXP1', '2026-09-11T00:00:00.000Z');
  assert.equal(released.status, 'open');
  assert.equal(released.history[released.history.length - 1]!.type, 'released');
});

test("history[] only ever grows: transitionExperiment/appendOpportunityEvent never drop prior entries", () => {
  const experiment = buildExperiment({ opportunity: opportunity(), hypothesis, action, measurementPlan, before: null, now: '2026-09-01T00:00:00.000Z' });
  const next = transitionExperiment(experiment, 'rejected', '2026-09-02T00:00:00.000Z', 'no longer relevant');
  assert.deepEqual(next.history.slice(0, experiment.history.length), experiment.history);
  assert.equal(next.history.length, experiment.history.length + 1);
});
