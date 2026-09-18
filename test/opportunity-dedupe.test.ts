import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveScopeKey, mergeDiscoveredOpportunity } from '../src/core/opportunity.js';
import type { MergeOutcome } from '../src/core/opportunity.js';
import type { DiscoverOpportunityInput, Opportunity } from '../src/core/types.js';

function opportunityOf(outcome: MergeOutcome): Opportunity {
  if (outcome.kind === 'skipped_promoted' || outcome.kind === 'skipped_rejected_needs_reopen') {
    throw new Error(`expected an Opportunity but got outcome.kind=${outcome.kind}`);
  }
  return outcome.opportunity;
}

function candidate(overrides: Partial<DiscoverOpportunityInput> = {}): DiscoverOpportunityInput {
  return {
    scope: { type: 'page', path: '/example/' },
    kind: 'content_gap',
    intentSlug: 'missing-definition',
    title: 'title',
    description: 'desc',
    evidence: [{ source: 'gsc_query', summary: 'traction', collectedAt: '2026-09-10T00:00:00.000Z' }],
    ...overrides,
  };
}

test('deriveScopeKey: page scope normalizes trailing slash', () => {
  assert.equal(deriveScopeKey({ type: 'page', path: '/example/' }), deriveScopeKey({ type: 'page', path: '/example' }));
});

test('deriveScopeKey: cluster scope normalizes and sorts queries', () => {
  const a = deriveScopeKey({ type: 'cluster', representativeQueries: ['B query', 'a query'] });
  const b = deriveScopeKey({ type: 'cluster', representativeQueries: ['A Query', 'b   query'] });
  assert.equal(a, b);
});

test('deriveScopeKey: site scope is constant', () => {
  assert.equal(deriveScopeKey({ type: 'site' }), 'site');
});

test('same identity is not duplicated: second discover appends evidence instead of creating a new Opportunity', () => {
  const first = mergeDiscoveredOpportunity([], candidate(), '2026-09-10T00:00:00.000Z');
  assert.equal(first.kind, 'created');
  const existing = [opportunityOf(first)];

  const second = mergeDiscoveredOpportunity(
    existing,
    candidate({ evidence: [{ source: 'serp', summary: 'gap confirmed', collectedAt: '2026-09-11T00:00:00.000Z' }] }),
    '2026-09-11T00:00:00.000Z',
  );
  assert.equal(second.kind, 'evidence_appended');
  assert.equal(opportunityOf(second).evidence.length, 2);
  assert.equal(opportunityOf(second).id, opportunityOf(first).id);
});

test('same scopeKey but different intentKey co-exist as separate Opportunities', () => {
  const first = mergeDiscoveredOpportunity([], candidate({ intentSlug: 'missing-definition' }), '2026-09-10T00:00:00.000Z');
  const existing = [opportunityOf(first)];
  const second = mergeDiscoveredOpportunity(
    existing,
    candidate({ intentSlug: 'ctr-improvement', kind: 'ctr_title' }),
    '2026-09-10T00:00:00.000Z',
  );
  assert.equal(second.kind, 'created');
  assert.notEqual(opportunityOf(second).id, opportunityOf(first).id);
  assert.equal(opportunityOf(second).identity.scopeKey, opportunityOf(first).identity.scopeKey);
  assert.notEqual(opportunityOf(second).identity.intentKey, opportunityOf(first).identity.intentKey);
});

test('promoted Opportunity is skipped, not duplicated or overwritten', () => {
  const created = mergeDiscoveredOpportunity([], candidate(), '2026-09-10T00:00:00.000Z');
  const promoted: Opportunity = { ...opportunityOf(created), status: 'promoted' };
  const outcome = mergeDiscoveredOpportunity([promoted], candidate(), '2026-09-12T00:00:00.000Z');
  assert.equal(outcome.kind, 'skipped_promoted');
});

test('rejected Opportunity does not auto-reopen without explicit reopen+reason', () => {
  const created = mergeDiscoveredOpportunity([], candidate(), '2026-09-10T00:00:00.000Z');
  const rejected: Opportunity = { ...opportunityOf(created), status: 'rejected' };

  const withoutReopen = mergeDiscoveredOpportunity([rejected], candidate(), '2026-09-12T00:00:00.000Z');
  assert.equal(withoutReopen.kind, 'skipped_rejected_needs_reopen');

  const withReopenNoReason = mergeDiscoveredOpportunity(
    [rejected],
    candidate({ reopen: true }),
    '2026-09-12T00:00:00.000Z',
  );
  assert.equal(withReopenNoReason.kind, 'skipped_rejected_needs_reopen');
});

test('rejected Opportunity reopens with explicit reopen=true and a reason', () => {
  const created = mergeDiscoveredOpportunity([], candidate(), '2026-09-10T00:00:00.000Z');
  const rejected: Opportunity = { ...opportunityOf(created), status: 'rejected' };

  const outcome = mergeDiscoveredOpportunity(
    [rejected],
    candidate({ reopen: true, reopenReason: '新しい根拠が見つかったため' }),
    '2026-09-12T00:00:00.000Z',
  );
  assert.equal(outcome.kind, 'reopened');
  const opportunity = opportunityOf(outcome);
  assert.equal(opportunity.status, 'open');
  const lastEvent = opportunity.history[opportunity.history.length - 1]!;
  assert.equal(lastEvent.type, 'reopened');
  assert.equal(lastEvent.note, '新しい根拠が見つかったため');
});
