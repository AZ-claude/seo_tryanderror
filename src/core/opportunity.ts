import { generateId } from './id.js';
import { normalizePath, normalizeQuery } from './text.js';
import type {
  DiscoverOpportunityInput,
  Evidence,
  Opportunity,
  OpportunityEvent,
  OpportunityIdentity,
  OpportunityScope,
  OpportunitySignals,
} from './types.js';

/** Pure function: DESIGN.md 6.1.1 scopeKey derivation rules. */
export function deriveScopeKey(scope: OpportunityScope): string {
  switch (scope.type) {
    case 'page':
      return `page:${normalizePath(scope.path)}`;
    case 'cluster': {
      const sorted = [...scope.representativeQueries].map(normalizeQuery).sort();
      return `cluster:${sorted.join('|')}`;
    }
    case 'site':
      return 'site';
  }
}

export function buildIdentity(input: { scope: OpportunityScope; kind: string; intentSlug: string }): OpportunityIdentity {
  return {
    scopeKey: deriveScopeKey(input.scope),
    intentKey: `${input.kind}:${input.intentSlug}`,
  };
}

/**
 * A warning-only guard (DESIGN.md 6.1.1): an intentSlug that is just the
 * title's own normalization defeats the point of a controlled vocabulary.
 * Does not block creation; callers surface this as a report warning.
 */
export function isIntentSlugTooCloseToTitle(intentSlug: string, title: string): boolean {
  const normalizedTitle = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalizedTitle.length > 0 && normalizedTitle === intentSlug;
}

/** DESIGN.md 6.1.2: signals are derived mechanically from evidence, never self-reported. */
export function computeSignals(evidence: Evidence[]): OpportunitySignals {
  return {
    hasGscTraction: evidence.some((e) => e.source === 'gsc_query' || e.source === 'gsc_page'),
    contentGapConfirmed: evidence.some((e) => e.source === 'serp'),
    leveragesProprietaryData: evidence.some((e) => e.source === 'proprietary_data'),
  };
}

export type MergeOutcome =
  | { kind: 'created'; opportunity: Opportunity }
  | { kind: 'evidence_appended'; opportunity: Opportunity }
  | { kind: 'skipped_promoted'; opportunityId: string }
  | { kind: 'skipped_rejected_needs_reopen'; opportunityId: string }
  | { kind: 'reopened'; opportunity: Opportunity };

/**
 * Merges one discover-input candidate into the existing opportunity set,
 * per the reopen/reject/promote table in DESIGN.md 6.1.3. Does not mutate
 * `existing`; returns the outcome plus (when relevant) the opportunity to
 * upsert into the persisted list.
 */
export function mergeDiscoveredOpportunity(
  existing: Opportunity[],
  input: DiscoverOpportunityInput,
  now: string,
): MergeOutcome {
  const identity = buildIdentity(input);
  const match = existing.find(
    (o) => o.identity.scopeKey === identity.scopeKey && o.identity.intentKey === identity.intentKey,
  );

  if (!match) {
    const opportunity: Opportunity = {
      id: generateId(),
      createdAt: now,
      updatedAt: now,
      scope: input.scope,
      identity,
      kind: input.kind,
      title: input.title,
      description: input.description,
      evidence: input.evidence,
      signals: computeSignals(input.evidence),
      status: 'open',
      history: [{ at: now, type: 'discovered' }],
    };
    return { kind: 'created', opportunity };
  }

  if (match.status === 'open') {
    const mergedEvidence = [...match.evidence, ...input.evidence];
    const opportunity: Opportunity = {
      ...match,
      evidence: mergedEvidence,
      signals: computeSignals(mergedEvidence),
      updatedAt: now,
    };
    return { kind: 'evidence_appended', opportunity };
  }

  if (match.status === 'promoted') {
    return { kind: 'skipped_promoted', opportunityId: match.id };
  }

  if (match.status === 'rejected') {
    if (!input.reopen || !input.reopenReason) {
      return { kind: 'skipped_rejected_needs_reopen', opportunityId: match.id };
    }
    const event: OpportunityEvent = { at: now, type: 'reopened', note: input.reopenReason };
    const mergedEvidence = [...match.evidence, ...input.evidence];
    const opportunity: Opportunity = {
      ...match,
      status: 'open',
      evidence: mergedEvidence,
      signals: computeSignals(mergedEvidence),
      updatedAt: now,
      history: [...match.history, event],
    };
    return { kind: 'reopened', opportunity };
  }

  // status === 'stale': not reachable in Milestone 1A (no automatic stale transition exists yet).
  return { kind: 'skipped_promoted', opportunityId: match.id };
}

export function appendOpportunityEvent(opportunity: Opportunity, event: OpportunityEvent): Opportunity {
  return { ...opportunity, history: [...opportunity.history, event], updatedAt: event.at };
}

export function promoteOpportunity(opportunity: Opportunity, experimentId: string, now: string): Opportunity {
  const promoted: Opportunity = { ...opportunity, status: 'promoted', updatedAt: now };
  return appendOpportunityEvent(promoted, { at: now, type: 'promoted', relatedExperimentId: experimentId });
}

export function releaseOpportunity(opportunity: Opportunity, experimentId: string, now: string): Opportunity {
  const released: Opportunity = { ...opportunity, status: 'open', updatedAt: now };
  return appendOpportunityEvent(released, { at: now, type: 'released', relatedExperimentId: experimentId });
}

export function rejectOpportunity(opportunity: Opportunity, reason: string, now: string): Opportunity {
  const rejected: Opportunity = { ...opportunity, status: 'rejected', updatedAt: now };
  return appendOpportunityEvent(rejected, { at: now, type: 'rejected', note: reason });
}
