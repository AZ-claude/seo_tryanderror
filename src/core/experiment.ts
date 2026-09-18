import { generateId } from './id.js';
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

export function isActiveExperimentStatus(status: ExperimentStatus): boolean {
  return (ACTIVE_EXPERIMENT_STATUSES as string[]).includes(status);
}

export function hasActiveExperiment(experiments: Experiment[], opportunityId: string): boolean {
  return experiments.some((e) => e.opportunityId === opportunityId && isActiveExperimentStatus(e.status));
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
