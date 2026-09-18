import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prioritizeOpportunities } from '../src/core/prioritize.js';
import type { Experiment, Opportunity } from '../src/core/types.js';

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'ID',
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

test('bucket 1 beats all others: gsc traction + content gap confirmed on a page', () => {
  const bucket1 = opportunity({ id: 'b1', signals: { hasGscTraction: true, contentGapConfirmed: true, leveragesProprietaryData: false } });
  const bucket3 = opportunity({ id: 'b3', signals: { hasGscTraction: false, contentGapConfirmed: false, leveragesProprietaryData: true } });
  const result = prioritizeOpportunities({ opportunities: [bucket3, bucket1], experiments: [] });
  assert.deepEqual(result.ranked.map((o) => o.id), ['b1', 'b3']);
});

test('bucket 2: gsc traction on a cluster scope (no confirmed page gap) ranks below bucket 1', () => {
  const bucket1 = opportunity({
    id: 'b1',
    scope: { type: 'page', path: '/a/' },
    signals: { hasGscTraction: true, contentGapConfirmed: true, leveragesProprietaryData: false },
  });
  const bucket2 = opportunity({
    id: 'b2',
    scope: { type: 'cluster', representativeQueries: ['q'] },
    signals: { hasGscTraction: true, contentGapConfirmed: false, leveragesProprietaryData: false },
  });
  const result = prioritizeOpportunities({ opportunities: [bucket2, bucket1], experiments: [] });
  assert.deepEqual(result.ranked.map((o) => o.id), ['b1', 'b2']);
});

test('bucket 4: retry only when concluded with a non-supporting outcome and new evidence since then', () => {
  const opp = opportunity({
    id: 'retry',
    evidence: [{ source: 'manual', summary: 'new finding', collectedAt: '2026-09-15T00:00:00.000Z' }],
  });
  const experiments: Experiment[] = [
    {
      id: 'exp1',
      opportunityId: 'retry',
      hypothesisId: 'hyp1',
      action: { type: 'REVISE', targetPaths: ['/a/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
      measurementPlan: { targetPages: ['/a/'], primaryMetric: 'ctr', secondaryMetrics: [], baselineWindowDays: 28, reviewWindowDays: 7 },
      status: 'concluded',
      before: null,
      result: { outcome: 'no_effect', notes: '' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
      history: [],
    },
  ];
  const other = opportunity({ id: 'other' });
  const result = prioritizeOpportunities({ opportunities: [other, opp], experiments });
  assert.deepEqual(result.ranked.map((o) => o.id), ['retry', 'other']);
});

test('bucket 4: not a retry candidate without new evidence after the concluded experiment', () => {
  const opp = opportunity({
    id: 'stale-retry',
    evidence: [{ source: 'manual', summary: 'old finding', collectedAt: '2026-08-01T00:00:00.000Z' }],
  });
  const experiments: Experiment[] = [
    {
      id: 'exp1',
      opportunityId: 'stale-retry',
      hypothesisId: 'hyp1',
      action: { type: 'REVISE', targetPaths: ['/a/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
      measurementPlan: { targetPages: ['/a/'], primaryMetric: 'ctr', secondaryMetrics: [], baselineWindowDays: 28, reviewWindowDays: 7 },
      status: 'concluded',
      before: null,
      result: { outcome: 'no_effect', notes: '' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
      history: [],
    },
  ];
  const result = prioritizeOpportunities({ opportunities: [opp], experiments });
  assert.equal(result.ranked[0]!.id, 'stale-retry');
  // bucket 5, not bucket 4 — verified indirectly via ordering against a bucket-3 opportunity below.
  const proprietary = opportunity({ id: 'proprietary', signals: { hasGscTraction: false, contentGapConfirmed: false, leveragesProprietaryData: true } });
  const result2 = prioritizeOpportunities({ opportunities: [opp, proprietary], experiments });
  assert.deepEqual(result2.ranked.map((o) => o.id), ['proprietary', 'stale-retry']);
});

test('non-open Opportunities are excluded with a reason', () => {
  const promoted = opportunity({ id: 'promoted', status: 'promoted' });
  const rejected = opportunity({ id: 'rejected', status: 'rejected' });
  const open = opportunity({ id: 'open' });
  const result = prioritizeOpportunities({ opportunities: [promoted, rejected, open], experiments: [] });
  assert.deepEqual(result.ranked.map((o) => o.id), ['open']);
  assert.equal(result.excluded.length, 2);
});

test('tie breaker: more evidence first, then older createdAt, then id', () => {
  const a = opportunity({ id: 'a', createdAt: '2026-09-05T00:00:00.000Z', evidence: [] });
  const b = opportunity({ id: 'b', createdAt: '2026-09-01T00:00:00.000Z', evidence: [{ source: 'manual', summary: 'x', collectedAt: '2026-09-01T00:00:00.000Z' }] });
  const c = opportunity({ id: 'c', createdAt: '2026-09-02T00:00:00.000Z', evidence: [] });
  // all bucket 5 (no signals set)
  const result = prioritizeOpportunities({ opportunities: [a, c, b], experiments: [] });
  assert.deepEqual(result.ranked.map((o) => o.id), ['b', 'c', 'a']);
});
