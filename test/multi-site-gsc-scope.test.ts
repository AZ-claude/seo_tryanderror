import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { buildPageDimensionFilters } from '../src/adapters/gsc.js';
import { runUnderstand } from '../src/core/workflow/understand.js';
import { dumpReviewInputs } from '../src/core/workflow/review.js';
import type { Experiment, GscAdapter } from '../src/core/types.js';
import { buildFixtureSiteReader, setupFixtureWorkdir } from './fixtures-helper.js';

test('buildPageDimensionFilters: no prefix -> undefined (no filter group sent)', () => {
  assert.equal(buildPageDimensionFilters({}), undefined);
});

test('buildPageDimensionFilters: pagePrefix -> single "contains" filter (used to scope a domain property down to one subdomain)', () => {
  const groups = buildPageDimensionFilters({ pagePrefix: 'https://pokeca.rakusetsu.com/' });
  assert.deepEqual(groups, [
    { filters: [{ dimension: 'page', operator: 'contains', expression: 'https://pokeca.rakusetsu.com/' }] },
  ]);
});

test('buildPageDimensionFilters: excludePagePrefix -> single "notContains" filter (used to keep a subdomain out of the parent site property)', () => {
  const groups = buildPageDimensionFilters({ excludePagePrefix: 'https://pokeca.rakusetsu.com/' });
  assert.deepEqual(groups, [
    { filters: [{ dimension: 'page', operator: 'notContains', expression: 'https://pokeca.rakusetsu.com/' }] },
  ]);
});

test('buildPageDimensionFilters: both set -> AND of contains + notContains in one filter group', () => {
  const groups = buildPageDimensionFilters({ pagePrefix: 'https://pokeca.rakusetsu.com/', excludePagePrefix: 'https://other.rakusetsu.com/' });
  assert.deepEqual(groups, [
    {
      filters: [
        { dimension: 'page', operator: 'contains', expression: 'https://pokeca.rakusetsu.com/' },
        { dimension: 'page', operator: 'notContains', expression: 'https://other.rakusetsu.com/' },
      ],
    },
  ]);
});

test('understand: config.gsc.pagePrefix/excludePagePrefix reach the GscAdapter call (main-site exclusion, sub-site inclusion)', async () => {
  const { dir, paths } = await setupFixtureWorkdir();
  try {
    const siteReader = await buildFixtureSiteReader();
    const received: Array<{ pagePrefix?: string; excludePagePrefix?: string }> = [];
    const recordingGsc: GscAdapter = {
      async fetchQueryPageMatrix(input) {
        received.push({ pagePrefix: input.pagePrefix, excludePagePrefix: input.excludePagePrefix });
        return { rows: [] };
      },
    };

    await runUnderstand(paths, siteReader, recordingGsc, {
      baseUrl: 'https://pokeca.rakusetsu.com/',
      gscProperty: 'sc-domain:rakusetsu.com',
      today: '2026-09-10',
      dryRun: true,
      gscWindowDays: 28,
      finalDataLagDays: 0,
      gscSource: 'fixture',
      gscPagePrefix: 'https://pokeca.rakusetsu.com/',
    });
    assert.deepEqual(received, [{ pagePrefix: 'https://pokeca.rakusetsu.com/', excludePagePrefix: undefined }]);

    received.length = 0;
    await runUnderstand(paths, siteReader, recordingGsc, {
      baseUrl: 'https://rakusetsu.com/',
      gscProperty: 'sc-domain:rakusetsu.com',
      today: '2026-09-10',
      dryRun: true,
      gscWindowDays: 28,
      finalDataLagDays: 0,
      gscSource: 'fixture',
      gscExcludePagePrefix: 'https://pokeca.rakusetsu.com/',
    });
    assert.deepEqual(received, [{ pagePrefix: undefined, excludePagePrefix: 'https://pokeca.rakusetsu.com/' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

test('review: config.gsc.pagePrefix/excludePagePrefix reach the GscAdapter call for both before/after checkpoint windows', async () => {
  const received: Array<{ pagePrefix?: string; excludePagePrefix?: string }> = [];
  const recordingGsc: GscAdapter = {
    async fetchQueryPageMatrix(input) {
      received.push({ pagePrefix: input.pagePrefix, excludePagePrefix: input.excludePagePrefix });
      return { rows: [{ query: 'q', page: '/a/', clicks: 1, impressions: 20, ctr: 0.05, position: 10 }] };
    },
  };

  const result = await dumpReviewInputs([experiment()], recordingGsc, {
    experimentId: 'EXP1',
    property: 'sc-domain:rakusetsu.com',
    today: '2026-09-09', // elapsed 8 days -> checkpoint 3 is due
    finalDataLagDays: 0,
    now: '2026-09-09T00:00:00.000Z',
    gscPagePrefix: 'https://pokeca.rakusetsu.com/',
  });
  assert.ok('checkpoint' in result && result.checkpoint === 3);
  assert.equal(received.length, 2, 'both before and after windows must be fetched');
  for (const call of received) {
    assert.equal(call.pagePrefix, 'https://pokeca.rakusetsu.com/');
  }
});
