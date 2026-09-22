import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MaxActiveExperimentsError,
  PageConflictError,
  QueryConflictError,
  assertNoActivePageConflict,
  assertNoActiveQueryConflict,
  assertUnderMaxActiveExperiments,
} from '../src/core/experiment.js';
import { runPropose } from '../src/core/workflow/propose.js';
import { loadExperiments, saveExperiments, saveOpportunities } from '../src/infra/json-store.js';
import type { Experiment, Opportunity } from '../src/core/types.js';

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

// --- assertNoActiveQueryConflict ---

test('assertNoActiveQueryConflict: blocks an exact targetQueries overlap with an active Experiment, even on a different page', () => {
  const active = activeExperiment({
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/pokemon-box-price/'],
      targetQueries: ['ポケカ30周年 ボックス 買い取り', 'ポケカ30周年 ボックス 買取価格'],
      primaryMetric: 'impressions',
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  });
  const candidate = {
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/pokebox/megabrave/'], // different page
      targetQueries: ['メガブレイブ 買取', 'ポケカ30周年 ボックス 買取価格'], // one query overlaps
      primaryMetric: 'clicks' as const,
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  };
  assert.throws(() => assertNoActiveQueryConflict(candidate, [active]), QueryConflictError);
});

test('assertNoActiveQueryConflict: allows disjoint targetQueries', () => {
  const active = activeExperiment({
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/pokemon-box-price/'],
      targetQueries: ['ポケカ30周年 ボックス 買い取り'],
      primaryMetric: 'impressions',
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  });
  const candidate = {
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/pokebox/megabrave/'],
      targetQueries: ['メガブレイブ 買取'],
      primaryMetric: 'clicks' as const,
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  };
  assert.doesNotThrow(() => assertNoActiveQueryConflict(candidate, [active]));
});

test('assertNoActiveQueryConflict: no similar-keyword/semantic judgment — a near-identical but non-exact query does not block', () => {
  const active = activeExperiment({
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/pokebox/megabrave/'],
      targetQueries: ['メガブレイブ 買取'],
      primaryMetric: 'clicks',
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  });
  const candidate = {
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/pokebox/megabrave/'],
      targetQueries: ['メガブレイブ買取'], // no space — not an exact string match
      primaryMetric: 'clicks' as const,
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  };
  assert.doesNotThrow(() => assertNoActiveQueryConflict(candidate, [active]));
});

test('assertNoActiveQueryConflict: candidate with no targetQueries never conflicts', () => {
  const active = activeExperiment({
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/pokemon-box-price/'],
      targetQueries: ['ポケカ30周年 ボックス 買い取り'],
      primaryMetric: 'impressions',
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  });
  const candidate = {
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/some-other-page/'],
      primaryMetric: 'impressions' as const,
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  };
  assert.doesNotThrow(() => assertNoActiveQueryConflict(candidate, [active]));
});

test('assertNoActiveQueryConflict: active Experiment with no targetQueries never conflicts', () => {
  const active = activeExperiment({
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/pokemon-box-price/'],
      primaryMetric: 'impressions',
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  });
  const candidate = {
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/some-other-page/'],
      targetQueries: ['some query'],
      primaryMetric: 'impressions' as const,
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  };
  assert.doesNotThrow(() => assertNoActiveQueryConflict(candidate, [active]));
});

test('assertNoActiveQueryConflict: a concluded Experiment with the same query does not block', () => {
  const concluded = activeExperiment({
    status: 'concluded',
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/pokemon-box-price/'],
      targetQueries: ['ポケカ30周年 ボックス 買い取り'],
      primaryMetric: 'impressions',
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  });
  const candidate = {
    measurementPlan: {
      targetPages: ['https://rakusetsu.com/pokemon-box-price/'],
      targetQueries: ['ポケカ30周年 ボックス 買い取り'],
      primaryMetric: 'impressions' as const,
      secondaryMetrics: [],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
  };
  assert.doesNotThrow(() => assertNoActiveQueryConflict(candidate, [concluded]));
});

// --- runPropose integration: exact query overlap is rejected end-to-end ---

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'OPP-B',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    scope: { type: 'page', path: '/pokebox/megabrave/' },
    identity: { scopeKey: 'page:/pokebox/megabrave/', intentKey: 'ctr_title:x' },
    kind: 'ctr_title',
    title: 't',
    description: 'd',
    evidence: [],
    signals: { hasGscTraction: true, contentGapConfirmed: false, leveragesProprietaryData: false },
    status: 'open',
    history: [],
    ...overrides,
  };
}

test('runPropose: rejects a candidate whose targetQueries exactly overlap an active Experiment (ACTIVE_QUERY_EXPERIMENT_EXISTS)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seo-query-conflict-'));
  try {
    const paths = {
      opportunities: join(dir, 'opportunities.json'),
      experiments: join(dir, 'experiments.json'),
      rankHistory: join(dir, 'rank-history.json'),
      lock: join(dir, '.run.lock'),
    };
    const active = activeExperiment({
      opportunityId: 'OPP-A',
      measurementPlan: {
        targetPages: ['https://rakusetsu.com/pokemon-box-price/'],
        targetQueries: ['ポケカ30周年 ボックス 買い取り'],
        primaryMetric: 'impressions',
        secondaryMetrics: [],
        baselineWindowDays: 28,
        reviewWindowDays: 28,
      },
    });
    await saveExperiments(paths.experiments, [active]);
    await saveOpportunities(paths.opportunities, [opportunity()]);

    const result = await runPropose(paths, {
      opportunityId: 'OPP-B',
      input: {
        hypothesis: { statement: 's', expectedSignals: ['clicks'], rationale: 'r' },
        action: { type: 'REVISE', targetPaths: ['/pokebox/megabrave/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
        measurementPlan: {
          targetPages: ['https://rakusetsu.com/pokebox/megabrave/'], // different page
          targetQueries: ['ポケカ30周年 ボックス 買い取り'], // same query as the active Experiment
          primaryMetric: 'clicks',
          secondaryMetrics: [],
          baselineWindowDays: 28,
          reviewWindowDays: 28,
        },
      },
      today: '2026-09-22',
      now: '2026-09-22T00:00:00.000Z',
      finalDataLagDays: 0,
      metricsSource: 'gsc',
      maxActiveExperiments: 3,
      dryRun: true,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.report, /ACTIVE_QUERY_EXPERIMENT_EXISTS|already have an active Experiment/i);
    const experimentsAfter = await loadExperiments(paths.experiments);
    assert.equal(experimentsAfter.length, 1, 'no new Experiment should be created');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
