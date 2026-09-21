import { acquireLock } from '../../infra/fs-lock.js';
import { loadExperiments, loadOpportunities, saveExperiments, saveOpportunities } from '../../infra/json-store.js';
import { diffDays } from '../date.js';
import {
  assertOutcomeConsistentWithCheckpoint,
  computeDelta,
  decideCheckpoint,
  findDueCheckpoint,
  InvalidReviewOutcomeError,
  METRIC_DIRECTION,
} from '../review.js';
import { aggregateGscRows } from '../measurement-plan.js';
import { hasActiveExperiment, transitionExperiment } from '../experiment.js';
import { releaseOpportunity } from '../opportunity.js';
import type {
  CheckpointDay,
  Experiment,
  GscAdapter,
  MetricKey,
  MetricsSnapshot,
  ReviewCheckpoint,
  ReviewDecisionInput,
} from '../types.js';

export type ReviewPaths = {
  experiments: string;
  opportunities: string;
  lock: string;
};

export type ReviewDumpResult = {
  experiment: {
    id: string;
    opportunityId: string;
    status: string;
    action: Experiment['action'];
    measurementPlan: Experiment['measurementPlan'];
    observation?: Experiment['observation'];
    recordedCheckpointDays: CheckpointDay[];
  };
  elapsedDays: number;
  checkpoint: CheckpointDay | null;
  comparison: { before: MetricsSnapshot; after: MetricsSnapshot; delta: Partial<Record<MetricKey, number>> } | null;
  sufficientData: boolean;
  canConclude: boolean;
  metricDirection: typeof METRIC_DIRECTION;
  note: string;
};

async function fetchWindowSnapshot(
  gsc: GscAdapter,
  property: string,
  window: { start: string; end: string },
  measurementPlan: Pick<Experiment['measurementPlan'], 'targetPages' | 'targetQueries' | 'minimumImpressions'>,
  now: string,
): Promise<MetricsSnapshot> {
  const { rows } = await gsc.fetchQueryPageMatrix({ property, startDate: window.start, endDate: window.end });
  const { impressions, clicks, ctr, position, sufficientData } = aggregateGscRows(rows, measurementPlan);
  return {
    at: now,
    source: 'gsc',
    window: { start: window.start, end: window.end, days: diffDays(window.start, window.end) + 1 },
    scope: { targetPages: measurementPlan.targetPages, targetQueries: measurementPlan.targetQueries },
    metrics: { impressions, clicks, ctr, position },
    sufficientData,
  };
}

function experimentSummary(experiment: Experiment): ReviewDumpResult['experiment'] {
  return {
    id: experiment.id,
    opportunityId: experiment.opportunityId,
    status: experiment.status,
    action: experiment.action,
    measurementPlan: experiment.measurementPlan,
    observation: experiment.observation,
    recordedCheckpointDays: (experiment.checkpoints ?? []).map((c) => c.checkpointDay),
  };
}

/** `review --dump-inputs`: read-only, live exact-window GSC fetch, no persistence. */
export async function dumpReviewInputs(
  experiments: Experiment[],
  gsc: GscAdapter,
  options: { experimentId: string; property: string; today: string; finalDataLagDays: number; now: string },
): Promise<ReviewDumpResult | { error: string }> {
  const experiment = experiments.find((e) => e.id === options.experimentId);
  if (!experiment) return { error: `no Experiment found with id ${options.experimentId}` };
  if (experiment.status !== 'observing' || !experiment.observation) {
    return { error: `Experiment ${options.experimentId} is not observing (status=${experiment.status})` };
  }

  const recordedCheckpointDays = (experiment.checkpoints ?? []).map((c) => c.checkpointDay);
  const elapsedDays = diffDays(experiment.observation.start, options.today);
  const due = findDueCheckpoint({
    observationStart: experiment.observation.start,
    today: options.today,
    finalDataLagDays: options.finalDataLagDays,
    recordedCheckpointDays,
  });

  if (!due) {
    return {
      experiment: experimentSummary(experiment),
      elapsedDays,
      checkpoint: null,
      comparison: null,
      sufficientData: false,
      canConclude: false,
      metricDirection: METRIC_DIRECTION,
      note: 'no checkpoint due yet, or no post-change final GSC data available yet (bounded by finalDataLagDays)',
    };
  }

  const before = await fetchWindowSnapshot(
    gsc,
    options.property,
    { start: due.comparisonWindow.beforeStart, end: due.comparisonWindow.beforeEnd },
    experiment.measurementPlan,
    options.now,
  );
  const after = await fetchWindowSnapshot(
    gsc,
    options.property,
    { start: due.comparisonWindow.afterStart, end: due.comparisonWindow.afterEnd },
    experiment.measurementPlan,
    options.now,
  );
  const decision = decideCheckpoint(after, due.checkpointDay);

  return {
    experiment: experimentSummary(experiment),
    elapsedDays,
    checkpoint: due.checkpointDay,
    comparison: { before, after, delta: computeDelta(before, after) },
    sufficientData: after.sufficientData,
    canConclude: decision !== 'continue_observing',
    metricDirection: METRIC_DIRECTION,
    note: `mechanical decision: ${decision} (checkpointDay=${due.checkpointDay})`,
  };
}

export type ReviewDecisionOptions = {
  experimentId: string;
  property: string;
  today: string;
  finalDataLagDays: number;
  now: string;
  decisionInput: ReviewDecisionInput;
  dryRun: boolean;
};

export type ReviewDecisionResult = {
  report: string;
  exitCode: 0 | 1;
};

/** `review --review-file`: recomputes the due checkpoint fresh (never trusts client-supplied numbers), validates, and persists. */
export async function runReviewDecision(
  paths: ReviewPaths,
  gsc: GscAdapter,
  options: ReviewDecisionOptions,
): Promise<ReviewDecisionResult> {
  const lock = await acquireLock(paths.lock);
  try {
    const experiments = await loadExperiments(paths.experiments);
    const dump = await dumpReviewInputs(experiments, gsc, options);

    if ('error' in dump) {
      return { exitCode: 1, report: `# review report — ${options.now}\n\n## Error\n- ${dump.error}\n` };
    }
    if (!dump.checkpoint || !dump.comparison) {
      return {
        exitCode: 1,
        report: `# review report — ${options.now}\n\n## Error\n- no checkpoint is due for Experiment ${options.experimentId}; nothing to record\n`,
      };
    }

    const experiment = experiments.find((e) => e.id === options.experimentId)!;
    const checkpointDecision = decideCheckpoint(dump.comparison.after, dump.checkpoint);

    const checkpoint: ReviewCheckpoint = {
      at: options.now,
      checkpointDay: dump.checkpoint,
      elapsedDays: dump.elapsedDays,
      comparisonWindow: {
        beforeStart: dump.comparison.before.window.start,
        beforeEnd: dump.comparison.before.window.end,
        afterStart: dump.comparison.after.window.start,
        afterEnd: dump.comparison.after.window.end,
        days: dump.comparison.after.window.days,
      },
      before: dump.comparison.before,
      after: dump.comparison.after,
      decision: checkpointDecision,
      note: options.decisionInput.note,
    };

    if (options.decisionInput.decision === 'continue_observing') {
      const updated: Experiment = {
        ...experiment,
        checkpoints: [...(experiment.checkpoints ?? []), checkpoint],
        updatedAt: options.now,
      };
      if (!options.dryRun) {
        await saveExperiments(
          paths.experiments,
          experiments.map((e) => (e.id === updated.id ? updated : e)),
        );
      }
      return {
        exitCode: 0,
        report: generateReviewReport({ generatedAt: options.now, dryRun: options.dryRun, checkpoint, conclude: false }),
      };
    }

    // decision === 'conclude'
    try {
      assertOutcomeConsistentWithCheckpoint(checkpoint.decision, options.decisionInput.proposedOutcome!);
    } catch (err) {
      if (err instanceof InvalidReviewOutcomeError) {
        return { exitCode: 1, report: `# review report — ${options.now}\n\n## Error\n- ${err.message}\n` };
      }
      throw err;
    }

    const withCheckpoint: Experiment = { ...experiment, checkpoints: [...(experiment.checkpoints ?? []), checkpoint] };
    const concluded = transitionExperiment(withCheckpoint, 'concluded', options.now, options.decisionInput.note);
    const finalExperiment: Experiment = {
      ...concluded,
      after: checkpoint.after,
      result: { outcome: options.decisionInput.proposedOutcome!, notes: options.decisionInput.note },
      ...(options.decisionInput.learning ? { learning: options.decisionInput.learning } : {}),
    };

    const nextExperiments = experiments.map((e) => (e.id === finalExperiment.id ? finalExperiment : e));
    const opportunities = await loadOpportunities(paths.opportunities);
    const opportunity = opportunities.find((o) => o.id === finalExperiment.opportunityId);
    let nextOpportunities = opportunities;
    let released = false;
    if (opportunity && opportunity.status === 'promoted' && !hasActiveExperiment(nextExperiments, opportunity.id)) {
      const releasedOpportunity = releaseOpportunity(opportunity, finalExperiment.id, options.now);
      nextOpportunities = opportunities.map((o) => (o.id === releasedOpportunity.id ? releasedOpportunity : o));
      released = true;
    }

    if (!options.dryRun) {
      await saveExperiments(paths.experiments, nextExperiments);
      if (released) await saveOpportunities(paths.opportunities, nextOpportunities);
    }

    return {
      exitCode: 0,
      report: generateReviewReport({
        generatedAt: options.now,
        dryRun: options.dryRun,
        checkpoint,
        conclude: true,
        outcome: options.decisionInput.proposedOutcome,
        opportunityReleased: released,
      }),
    };
  } finally {
    await lock.release();
  }
}

function generateReviewReport(data: {
  generatedAt: string;
  dryRun: boolean;
  checkpoint: ReviewCheckpoint;
  conclude: boolean;
  outcome?: string;
  opportunityReleased?: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`# review report — ${data.generatedAt}`);
  if (data.dryRun) lines.push('\n**DRY RUN** — no files were written.');
  lines.push(`\n## Checkpoint`);
  lines.push(`- checkpointDay: ${data.checkpoint.checkpointDay}`);
  lines.push(`- elapsedDays: ${data.checkpoint.elapsedDays}`);
  lines.push(`- comparisonWindow: ${JSON.stringify(data.checkpoint.comparisonWindow)}`);
  lines.push(`- before: ${JSON.stringify(data.checkpoint.before.metrics)}`);
  lines.push(`- after: ${JSON.stringify(data.checkpoint.after.metrics)}`);
  lines.push(`- decision: ${data.checkpoint.decision}`);
  if (data.conclude) {
    lines.push(`\n## Conclude`);
    lines.push(`- outcome: ${data.outcome}`);
    lines.push(`- opportunityReleased: ${Boolean(data.opportunityReleased)}`);
  } else {
    lines.push(`\n## Continue observing`);
    lines.push('- checkpoint recorded; Experiment status unchanged');
  }
  lines.push('\nRank/impression improvements are never predicted or guaranteed; only measured outcomes are reported.');
  return `${lines.join('\n')}\n`;
}
