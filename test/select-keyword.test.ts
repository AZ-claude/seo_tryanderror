import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectKeyword } from '../src/core/select-keyword.js';
import type { ImprovementLog, KeywordRecord, RankHistory } from '../src/core/types.js';

function historyWith(measurements: Array<{ keyword: string; rank: number | null; impressions: number }>): RankHistory {
  return {
    schemaVersion: 1,
    entries: [
      {
        date: '2026-09-01',
        source: 'gsc',
        measurements: measurements.map((m) => ({ ...m, clicks: 0 })),
      },
    ],
  };
}

const emptyLog: ImprovementLog = { schemaVersion: 1, keywords: [] };

test('bucket 1: prefers rank 2-10 with impressions', () => {
  const candidates: KeywordRecord[] = [
    { keyword: 'a', targetPath: '/a/', priority: 'medium' },
    { keyword: 'b', targetPath: '/b/', priority: 'medium' },
  ];
  const rankHistory = historyWith([
    { keyword: 'a', rank: 15, impressions: 100 },
    { keyword: 'b', rank: 4, impressions: 50 },
  ]);
  const picked = selectKeyword({ activeCandidates: candidates, rankHistory, improvementLog: emptyLog });
  assert.equal(picked?.keyword, 'b');
});

test('bucket 1: excludes rank in range but zero impressions', () => {
  const candidates: KeywordRecord[] = [{ keyword: 'a', targetPath: '/a/', priority: 'high' }];
  const rankHistory = historyWith([{ keyword: 'a', rank: 5, impressions: 0 }]);
  const picked = selectKeyword({ activeCandidates: candidates, rankHistory, improvementLog: emptyLog });
  assert.equal(picked, null);
});

test('bucket 1: rank asc, then impressions desc, then priority', () => {
  const candidates: KeywordRecord[] = [
    { keyword: 'a', targetPath: '/a/', priority: 'low' },
    { keyword: 'b', targetPath: '/b/', priority: 'high' },
  ];
  const rankHistory = historyWith([
    { keyword: 'a', rank: 3, impressions: 10 },
    { keyword: 'b', rank: 3, impressions: 10 },
  ]);
  const picked = selectKeyword({ activeCandidates: candidates, rankHistory, improvementLog: emptyLog });
  assert.equal(picked?.keyword, 'b');
});

test('bucket 2: rank 11-20 with impressions when bucket 1 empty', () => {
  const candidates: KeywordRecord[] = [{ keyword: 'a', targetPath: '/a/', priority: 'medium' }];
  const rankHistory = historyWith([{ keyword: 'a', rank: 15, impressions: 100 }]);
  const picked = selectKeyword({ activeCandidates: candidates, rankHistory, improvementLog: emptyLog });
  assert.equal(picked?.keyword, 'a');
});

test('bucket 3: previously actioned keyword picked when 1/2 empty, oldest review first', () => {
  const candidates: KeywordRecord[] = [
    { keyword: 'old', targetPath: '/old/', priority: 'medium' },
    { keyword: 'new', targetPath: '/new/', priority: 'medium' },
  ];
  const rankHistory = historyWith([
    { keyword: 'old', rank: 30, impressions: 0 },
    { keyword: 'new', rank: 30, impressions: 0 },
  ]);
  const improvementLog: ImprovementLog = {
    schemaVersion: 1,
    keywords: [
      {
        keyword: 'old',
        targetPath: '/old/',
        status: 'active',
        nextReviewDate: null,
        actions: [
          {
            date: '2026-08-01',
            rankAtAction: 30,
            rankSource: 'gsc',
            searchNeed: 'x',
            gap: ['x'],
            done: 'x',
            changeType: 'intro',
            sources: [],
            review: {
              date: '2026-08-08',
              outcome: 'no_effect',
              previousRank: 30,
              currentRank: 30,
              notes: '',
            },
          },
        ],
      },
      {
        keyword: 'new',
        targetPath: '/new/',
        status: 'active',
        nextReviewDate: null,
        actions: [
          {
            date: '2026-09-01',
            rankAtAction: 30,
            rankSource: 'gsc',
            searchNeed: 'x',
            gap: ['x'],
            done: 'x',
            changeType: 'intro',
            sources: [],
            review: {
              date: '2026-09-08',
              outcome: 'no_effect',
              previousRank: 30,
              currentRank: 30,
              notes: '',
            },
          },
        ],
      },
    ],
  };
  const picked = selectKeyword({ activeCandidates: candidates, rankHistory, improvementLog });
  assert.equal(picked?.keyword, 'old');
});

test('bucket 4: rank null and priority high', () => {
  const candidates: KeywordRecord[] = [
    { keyword: 'low-null', targetPath: '/a/', priority: 'low' },
    { keyword: 'high-null', targetPath: '/b/', priority: 'high' },
  ];
  const rankHistory: RankHistory = { schemaVersion: 1, entries: [] };
  const picked = selectKeyword({ activeCandidates: candidates, rankHistory, improvementLog: emptyLog });
  assert.equal(picked?.keyword, 'high-null');
});

test('no candidate returns null', () => {
  const candidates: KeywordRecord[] = [{ keyword: 'low-null', targetPath: '/a/', priority: 'low' }];
  const rankHistory: RankHistory = { schemaVersion: 1, entries: [] };
  const picked = selectKeyword({ activeCandidates: candidates, rankHistory, improvementLog: emptyLog });
  assert.equal(picked, null);
});

test('exactly one keyword is ever returned', () => {
  const candidates: KeywordRecord[] = [
    { keyword: 'a', targetPath: '/a/', priority: 'high' },
    { keyword: 'b', targetPath: '/b/', priority: 'high' },
    { keyword: 'c', targetPath: '/c/', priority: 'high' },
  ];
  const rankHistory = historyWith([
    { keyword: 'a', rank: 3, impressions: 10 },
    { keyword: 'b', rank: 4, impressions: 10 },
    { keyword: 'c', rank: 5, impressions: 10 },
  ]);
  const picked = selectKeyword({ activeCandidates: candidates, rankHistory, improvementLog: emptyLog });
  assert.equal(typeof picked?.keyword, 'string');
});
