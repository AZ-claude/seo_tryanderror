import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MaxActiveExperimentsError,
  PageConflictError,
  assertNoActivePageConflict,
  assertUnderMaxActiveExperiments,
} from '../src/core/experiment.js';
import type { Experiment } from '../src/core/types.js';

function activeExperiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: 'EXP',
    opportunityId: 'OPP',
    hypothesisId: 'HYP',
    action: { type: 'REVISE', targetPaths: ['/pokemon-box-price/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/pokemon-box-price/'],
      primaryMetric: 'impressions',
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
    status: 'observing',
    before: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    history: [],
    ...overrides,
  };
}

// 14. 同一pageなら別Opportunityでもblock
test('assertNoActivePageConflict: blocks a candidate touching the same page as an active Experiment (different Opportunity)', () => {
  const active = activeExperiment({ opportunityId: 'OPP-A' });
  const candidate = {
    action: { type: 'CREATE' as const, targetPaths: ['/pokemon-box-price/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/pokemon-box-price/'],
      primaryMetric: 'ctr' as const,
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  };
  assert.throws(() => assertNoActivePageConflict(candidate, [active]), PageConflictError);
});

test('assertNoActivePageConflict: matches a bare path against a full-URL targetPage for the same page', () => {
  const active = activeExperiment(); // measurementPlan.targetPages uses a full URL
  const candidate = {
    action: { type: 'REVISE' as const, targetPaths: ['/pokemon-box-price/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
    measurementPlan: {
      targetPages: [], // only the Action.targetPaths side overlaps here
      primaryMetric: 'ctr' as const,
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  };
  assert.throws(() => assertNoActivePageConflict(candidate, [active]), PageConflictError);
});

// 13. 別ページならactive Experiment並行可
test('assertNoActivePageConflict: allows a candidate on a different page', () => {
  const active = activeExperiment();
  const candidate = {
    action: { type: 'REVISE' as const, targetPaths: ['/pokebox/megabrave/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/pokebox/megabrave/'],
      primaryMetric: 'impressions' as const,
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  };
  assert.doesNotThrow(() => assertNoActivePageConflict(candidate, [active]));
});

// 16. concluded Experimentはactive countに含めない (also applies to the page-conflict guard)
test('assertNoActivePageConflict: a concluded Experiment on the same page does not block', () => {
  const concluded = activeExperiment({ status: 'concluded' });
  const candidate = {
    action: { type: 'REVISE' as const, targetPaths: ['/pokemon-box-price/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/pokemon-box-price/'],
      primaryMetric: 'impressions' as const,
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  };
  assert.doesNotThrow(() => assertNoActivePageConflict(candidate, [concluded]));
});

// 15. maxActiveExperiments=3 guard
test('assertUnderMaxActiveExperiments: allows creation below the max, blocks at/over it', () => {
  const two = [activeExperiment({ id: 'E1' }), activeExperiment({ id: 'E2' })];
  assert.doesNotThrow(() => assertUnderMaxActiveExperiments(two, 3));

  const three = [...two, activeExperiment({ id: 'E3' })];
  assert.throws(() => assertUnderMaxActiveExperiments(three, 3), MaxActiveExperimentsError);
});

// 16. concluded Experimentはactive countに含めない
test('assertUnderMaxActiveExperiments: concluded/rejected Experiments do not count toward the max', () => {
  const experiments = [
    activeExperiment({ id: 'E1' }),
    activeExperiment({ id: 'E2' }),
    activeExperiment({ id: 'E3', status: 'concluded' }),
    activeExperiment({ id: 'E4', status: 'rejected' }),
  ];
  assert.doesNotThrow(() => assertUnderMaxActiveExperiments(experiments, 3));
});
