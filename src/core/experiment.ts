import { generateId } from './id.js';
import { toComparablePath } from './text.js';
import type {
  Action,
  Experiment,
  ExperimentEvent,
  ExperimentStatus,
  Hypothesis,
  MeasurementPlan,
  MetricsSnapshot,
  Opportunity,
} from './types.js';
import { ACTIVE_EXPERIMENT_STATUSES } from './types.js';

export class ActiveExperimentGuardError extends Error {
  readonly code = 'ACTIVE_EXPERIMENT_EXISTS';
  constructor(message: string) {
    super(message);
    this.name = 'ActiveExperimentGuardError';
  }
}

export class OpportunityNotOpenError extends Error {
  readonly code = 'OPPORTUNITY_NOT_OPEN';
  constructor(message: string) {
    super(message);
    this.name = 'OpportunityNotOpenError';
  }
}

export class InvalidExperimentTransitionError extends Error {
  readonly code = 'INVALID_EXPERIMENT_TRANSITION';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidExperimentTransitionError';
  }
}

export class PageConflictError extends Error {
  readonly code = 'ACTIVE_PAGE_EXPERIMENT_EXISTS';
  constructor(message: string) {
    super(message);
    this.name = 'PageConflictError';
  }
}

export class MaxActiveExperimentsError extends Error {
  readonly code = 'MAX_ACTIVE_EXPERIMENTS_EXCEEDED';
  constructor(message: string) {
    super(message);
    this.name = 'MaxActiveExperimentsError';
  }
}

export class QueryConflictError extends Error {
  readonly code = 'ACTIVE_QUERY_EXPERIMENT_EXISTS';
  constructor(message: string) {
    super(message);
    this.name = 'QueryConflictError';
  }
}

export function isActiveExperimentStatus(status: ExperimentStatus): boolean {
  return (ACTIVE_EXPERIMENT_STATUSES as string[]).includes(status);
}

export function hasActiveExperiment(experiments: Experiment[], opportunityId: string): boolean {
  return experiments.some((e) => e.opportunityId === opportunityId && isActiveExperimentStatus(e.status));
}

/** Every page an Experiment touches, from both its Action and its MeasurementPlan scope, path-normalized. */
function experimentPagePaths(experiment: Pick<Experiment, 'action' | 'measurementPlan'>): string[] {
  return [...experiment.action.targetPaths, ...experiment.measurementPlan.targetPages].map(toComparablePath);
}

/**
 * DESIGN.md 13: two active Experiments touching the same page would make it
 * impossible to attribute an effect to either one. Different Opportunities
 * on the *same* page are blocked; different pages are always allowed to run
 * in parallel (V1 does not attempt cluster/keyword-overlap detection).
 */
export function assertNoActivePageConflict(
  candidate: Pick<Experiment, 'action' | 'measurementPlan'>,
  experiments: Experiment[],
): void {
  const candidatePaths = new Set(experimentPagePaths(candidate));
  for (const e of experiments) {
    if (!isActiveExperimentStatus(e.status)) continue;
    const conflicting = experimentPagePaths(e).filter((p) => candidatePaths.has(p));
    if (conflicting.length > 0) {
      throw new PageConflictError(
        `page(s) already have an active Experiment (${e.id}): ${[...new Set(conflicting)].join(', ')}`,
      );
    }
  }
}

/**
 * Exact-string overlap on `measurementPlan.targetQueries` between the
 * candidate and any active Experiment. Only runs when BOTH sides declare
 * targetQueries — an Experiment with no targetQueries (page-level
 * measurement) never participates in this guard. No normalization, no
 * semantic/similar-keyword judgment (that stays a Skill-level "avoid an
 * obviously-overlapping search intent" concern, not a core guard) — this is
 * strictly an exact string match, so it complements rather than replaces
 * assertNoActivePageConflict (which already blocks same-page Experiments
 * regardless of query scope).
 */
export function assertNoActiveQueryConflict(
  candidate: Pick<Experiment, 'measurementPlan'>,
  experiments: Experiment[],
): void {
  const candidateQueries = candidate.measurementPlan.targetQueries;
  if (!candidateQueries || candidateQueries.length === 0) return;
  const candidateSet = new Set(candidateQueries);

  for (const e of experiments) {
    if (!isActiveExperimentStatus(e.status)) continue;
    const existingQueries = e.measurementPlan.targetQueries;
    if (!existingQueries || existingQueries.length === 0) continue;
    const overlapping = existingQueries.filter((q) => candidateSet.has(q));
    if (overlapping.length > 0) {
      throw new QueryConflictError(
        `query(ies) already have an active Experiment (${e.id}): ${[...new Set(overlapping)].join(', ')}`,
      );
    }
  }
}

/** DESIGN.md: rolling PDCA runs several Experiments in parallel, bounded by config.experiment.maxActiveExperiments. */
export function assertUnderMaxActiveExperiments(experiments: Experiment[], max: number): void {
  const activeCount = experiments.filter((e) => isActiveExperimentStatus(e.status)).length;
  if (activeCount >= max) {
    throw new MaxActiveExperimentsError(`already at maxActiveExperiments (${activeCount}/${max}); refusing to create a new one`);
  }
}

/**
 * DESIGN.md 7.3 / 12: Active experiment guard. Must be checked even when the
 * caller (e.g. `propose --opportunity-id`) directly names the Opportunity.
 */
export function assertCanCreateExperiment(opportunity: Opportunity, experiments: Experiment[]): void {
  if (opportunity.status !== 'open') {
    throw new OpportunityNotOpenError(
      `Opportunity ${opportunity.id} is not open (status=${opportunity.status}); cannot create a new Experiment`,
    );
  }
  if (hasActiveExperiment(experiments, opportunity.id)) {
    throw new ActiveExperimentGuardError(
      `Opportunity ${opportunity.id} already has an active (non-terminal) Experiment; refusing to create a new one`,
    );
  }
}

const ALLOWED_TRANSITIONS: Record<ExperimentStatus, ExperimentStatus[]> = {
  proposed: ['approved', 'rejected'],
  approved: ['applied', 'rejected'],
  applied: ['observing', 'rejected'],
  observing: ['concluded', 'rejected'],
  concluded: [],
  rejected: [],
};

export function assertValidTransition(from: ExperimentStatus, to: ExperimentStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new InvalidExperimentTransitionError(`invalid experiment status transition: ${from} -> ${to}`);
  }
}

export function appendExperimentEvent(experiment: Experiment, event: ExperimentEvent): Experiment {
  return { ...experiment, history: [...experiment.history, event], updatedAt: event.at };
}

export function transitionExperiment(
  experiment: Experiment,
  to: ExperimentStatus,
  now: string,
  note?: string,
): Experiment {
  assertValidTransition(experiment.status, to);
  const next: Experiment = { ...experiment, status: to, updatedAt: now };
  return appendExperimentEvent(next, { at: now, type: to, note });
}

/** True once an Experiment has reached a terminal status (concluded/rejected). */
export function isTerminal(status: ExperimentStatus): boolean {
  return status === 'concluded' || status === 'rejected';
}

export function buildExperiment(input: {
  opportunity: Opportunity;
  hypothesis: Hypothesis;
  action: Action;
  measurementPlan: MeasurementPlan;
  before: MetricsSnapshot | null;
  now: string;
}): Experiment {
  const { opportunity, hypothesis, action, measurementPlan, before, now } = input;
  return {
    id: generateId(),
    opportunityId: opportunity.id,
    hypothesisId: hypothesis.id,
    action,
    measurementPlan,
    status: 'proposed',
    before,
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, type: 'proposed' }],
  };
}
