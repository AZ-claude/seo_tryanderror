import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStatus } from '../src/core/status.js';
import type { ImprovementLog, KeywordRecord, RankHistory } from '../src/core/types.js';

const watchwords: KeywordRecord[] = [
  { keyword: 'active kw', targetPath: '/a/', priority: 'high' },
  { keyword: 'observing future', targetPath: '/b/', priority: 'medium' },
  { keyword: 'observing due', targetPath: '/c/', priority: 'medium' },
  { keyword: 'achieved kw', targetPath: '/d/', priority: 'low' },
];

const improvementLog: ImprovementLog = {
  schemaVersion: 1,
  keywords: [
    {
      keyword: 'observing future',
      targetPath: '/b/',
      status: 'observing',
      nextReviewDate: '2026-09-20',
      actions: [],
    },
    {
      keyword: 'observing due',
      targetPath: '/c/',
      status: 'observing',
      nextReviewDate: '2026-09-10',
      actions: [],
    },
    {
      keyword: 'achieved kw',
      targetPath: '/d/',
      status: 'achieved',
      nextReviewDate: null,
      actions: [],
    },
  ],
};

const rankHistory: RankHistory = { schemaVersion: 1, entries: [] };

test('classifies keywords with no state as active', () => {
  const status = getStatus({ watchwords, improvementLog, rankHistory, today: '2026-09-10' });
  assert.deepEqual(
    status.active.map((k) => k.keyword),
    ['active kw'],
  );
});

test('observing before nextReviewDate stays observing', () => {
  const status = getStatus({ watchwords, improvementLog, rankHistory, today: '2026-09-10' });
  assert.deepEqual(
    status.observing.map((k) => k.keyword),
    ['observing future'],
  );
});

test('observing at/after nextReviewDate is dueForReview', () => {
  const status = getStatus({ watchwords, improvementLog, rankHistory, today: '2026-09-10' });
  assert.deepEqual(
    status.dueForReview.map((k) => k.keyword),
    ['observing due'],
  );
});

test('achieved stays achieved', () => {
  const status = getStatus({ watchwords, improvementLog, rankHistory, today: '2026-09-10' });
  assert.deepEqual(
    status.achieved.map((k) => k.keyword),
    ['achieved kw'],
  );
});

test('active bucket sorted by latest rank ascending, nulls last', () => {
  const kws: KeywordRecord[] = [
    { keyword: 'no-rank', targetPath: '/x/', priority: 'high' },
    { keyword: 'rank-5', targetPath: '/y/', priority: 'high' },
    { keyword: 'rank-2', targetPath: '/z/', priority: 'high' },
  ];
  const history: RankHistory = {
    schemaVersion: 1,
    entries: [
      {
        date: '2026-09-01',
        source: 'gsc',
        measurements: [
          { keyword: 'rank-5', rank: 5, impressions: 10, clicks: 1 },
          { keyword: 'rank-2', rank: 2, impressions: 10, clicks: 1 },
        ],
      },
    ],
  };
  const status = getStatus({
    watchwords: kws,
    improvementLog: { schemaVersion: 1, keywords: [] },
    rankHistory: history,
    today: '2026-09-10',
  });
  assert.deepEqual(
    status.active.map((k) => k.keyword),
    ['rank-2', 'rank-5', 'no-rank'],
  );
});
