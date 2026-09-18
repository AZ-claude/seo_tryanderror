import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetricsSnapshot } from '../src/core/measurement-plan.js';
import type { RankHistory } from '../src/core/types.js';

const rankHistory: RankHistory = {
  schemaVersion: 2,
  entries: [
    {
      date: '2026-09-01',
      source: 'fixture',
      rows: [
        { query: 'target query', page: '/target/', clicks: 40, impressions: 500, ctr: 0.08, position: 4.2 },
        { query: 'other query on target page', page: '/target/', clicks: 5, impressions: 60, ctr: 0.08, position: 9 },
        { query: 'unrelated', page: '/other/', clicks: 100, impressions: 1000, ctr: 0.1, position: 1 },
      ],
    },
  ],
};

test('before snapshot only aggregates rows matching targetPages+targetQueries, never other pages/queries', () => {
  const snapshot = computeMetricsSnapshot({
    rankHistory,
    measurementPlan: { targetPages: ['/target/'], targetQueries: ['target query'], minimumImpressions: 10 },
    today: '2026-09-10',
    windowDays: 28,
    finalDataLagDays: 0,
    source: 'fixture',
    now: '2026-09-10T00:00:00.000Z',
  });
  assert.equal(snapshot.metrics.impressions, 500);
  assert.equal(snapshot.metrics.clicks, 40);
  assert.equal(snapshot.sufficientData, true);
});

test('omitting targetQueries aggregates all queries on the target pages', () => {
  const snapshot = computeMetricsSnapshot({
    rankHistory,
    measurementPlan: { targetPages: ['/target/'], minimumImpressions: 10 },
    today: '2026-09-10',
    windowDays: 28,
    finalDataLagDays: 0,
    source: 'fixture',
    now: '2026-09-10T00:00:00.000Z',
  });
  assert.equal(snapshot.metrics.impressions, 560);
  assert.equal(snapshot.metrics.clicks, 45);
});

test('no matching rows at all -> insufficient_data, not zero-effect', () => {
  const snapshot = computeMetricsSnapshot({
    rankHistory,
    measurementPlan: { targetPages: ['/does-not-exist/'] },
    today: '2026-09-10',
    windowDays: 28,
    finalDataLagDays: 0,
    source: 'fixture',
    now: '2026-09-10T00:00:00.000Z',
  });
  assert.equal(snapshot.sufficientData, false);
});

test('below minimumImpressions -> insufficient_data even though matching rows exist', () => {
  const snapshot = computeMetricsSnapshot({
    rankHistory,
    measurementPlan: { targetPages: ['/target/'], targetQueries: ['other query on target page'], minimumImpressions: 1000 },
    today: '2026-09-10',
    windowDays: 28,
    finalDataLagDays: 0,
    source: 'fixture',
    now: '2026-09-10T00:00:00.000Z',
  });
  assert.equal(snapshot.metrics.impressions, 60);
  assert.equal(snapshot.sufficientData, false);
});

test('entries outside the computed window are excluded', () => {
  const history: RankHistory = {
    schemaVersion: 2,
    entries: [
      { date: '2026-01-01', source: 'fixture', rows: [{ query: 'q', page: '/target/', clicks: 999, impressions: 9999, ctr: 0.1, position: 1 }] },
    ],
  };
  const snapshot = computeMetricsSnapshot({
    rankHistory: history,
    measurementPlan: { targetPages: ['/target/'] },
    today: '2026-09-10',
    windowDays: 28,
    finalDataLagDays: 0,
    source: 'fixture',
    now: '2026-09-10T00:00:00.000Z',
  });
  assert.equal(snapshot.sufficientData, false);
  assert.equal(snapshot.metrics.impressions, 0);
});
