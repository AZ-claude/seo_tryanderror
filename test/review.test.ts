import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReview, changeTypeToAvoid, judgeReview } from '../src/core/review.js';
import type { ImprovementKeywordState } from '../src/core/types.js';

test('judgeReview: currentRank 1 is achieved', () => {
  assert.equal(judgeReview({ previousRank: 5, currentRank: 1 }), 'achieved');
});

test('judgeReview: lower rank number is improved_not_achieved', () => {
  assert.equal(judgeReview({ previousRank: 8, currentRank: 4 }), 'improved_not_achieved');
});

test('judgeReview: same rank is no_effect', () => {
  assert.equal(judgeReview({ previousRank: 8, currentRank: 8 }), 'no_effect');
});

test('judgeReview: higher rank number is worse', () => {
  assert.equal(judgeReview({ previousRank: 4, currentRank: 9 }), 'worse');
});

test('judgeReview: missing rank is insufficient_data, not no_effect', () => {
  assert.equal(judgeReview({ previousRank: 4, currentRank: null }), 'insufficient_data');
  assert.equal(judgeReview({ previousRank: null, currentRank: 4 }), 'insufficient_data');
});

function baseState(): ImprovementKeywordState {
  return {
    keyword: 'kw',
    targetPath: '/kw/',
    status: 'observing',
    nextReviewDate: '2026-09-10',
    actions: [
      {
        date: '2026-09-03',
        rankAtAction: 8,
        rankSource: 'gsc',
        searchNeed: 'need',
        gap: ['gap'],
        done: 'did something',
        changeType: 'intro',
        sources: [],
      },
    ],
  };
}

test('applyReview: achieved sets status achieved and clears nextReviewDate', () => {
  const next = applyReview({ state: baseState(), today: '2026-09-10', currentRank: 1, notes: '' });
  assert.equal(next.status, 'achieved');
  assert.equal(next.nextReviewDate, null);
  assert.equal(next.actions[0]!.review!.outcome, 'achieved');
});

test('applyReview: insufficient_data keeps observing', () => {
  const state = baseState();
  state.actions[0]!.rankAtAction = null;
  const next = applyReview({
    state,
    today: '2026-09-10',
    currentRank: null,
    notes: '',
    retryReviewDate: '2026-09-17',
  });
  assert.equal(next.status, 'observing');
  assert.equal(next.nextReviewDate, '2026-09-17');
  assert.equal(next.actions[0]!.review!.outcome, 'insufficient_data');
});

test('applyReview: worse returns to active', () => {
  const next = applyReview({ state: baseState(), today: '2026-09-10', currentRank: 12, notes: '' });
  assert.equal(next.status, 'active');
  assert.equal(next.nextReviewDate, null);
});

test('applyReview does not mutate the input state', () => {
  const state = baseState();
  const snapshot = JSON.stringify(state);
  applyReview({ state, today: '2026-09-10', currentRank: 1, notes: '' });
  assert.equal(JSON.stringify(state), snapshot);
});

test('changeTypeToAvoid: returns last changeType after no_effect/worse', () => {
  const state = baseState();
  state.actions[0]!.review = {
    date: '2026-09-10',
    outcome: 'no_effect',
    previousRank: 8,
    currentRank: 8,
    notes: '',
  };
  assert.equal(changeTypeToAvoid(state), 'intro');
});

test('changeTypeToAvoid: null when improved or achieved', () => {
  const state = baseState();
  state.actions[0]!.review = {
    date: '2026-09-10',
    outcome: 'improved_not_achieved',
    previousRank: 8,
    currentRank: 4,
    notes: '',
  };
  assert.equal(changeTypeToAvoid(state), null);
});
