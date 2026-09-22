import { acquireLock } from '../../infra/fs-lock.js';
import { loadExperiments, loadOpportunities, loadRankHistory, saveExperiments, saveOpportunities } from '../../infra/json-store.js';
import {
  ActiveExperimentGuardError,
  MaxActiveExperimentsError,
  OpportunityNotOpenError,
  PageConflictError,
  QueryConflictError,
  assertCanCreateExperiment,
  assertNoActivePageConflict,
  assertNoActiveQueryConflict,
  assertUnderMaxActiveExperiments,
  buildExperiment,
} from '../experiment.js';
import { generateId } from '../id.js';
import { computeMetricsSnapshot } from '../measurement-plan.js';
import { promoteOpportunity } from '../opportunity.js';
import { generateProposeReport } from '../report.js';
import type { Hypothesis, MetricsSnapshotSource, ProposeInput, SerpInspection } from '../types.js';

export type ProposePaths = {
  opportunities: string;
  experiments: string;
  rankHistory: string;
  lock: string;
};

export type ProposeOptions = {
  opportunityId: string;
  input: ProposeInput;
  today: string;
  now: string;
  finalDataLagDays: number;
  metricsSource: MetricsSnapshotSource;
  maxActiveExperiments: number;
  serp?: SerpInspection;
  dryRun: boolean;
};

export type ProposeResult = {
  report: string;
  exitCode: 0 | 1;
};

export async function runPropose(paths: ProposePaths, options: ProposeOptions): Promise<ProposeResult> {
  const generatedAt = options.now;
  const lock = await acquireLock(paths.lock);
  try {
    const opportunities = await loadOpportunities(paths.opportunities);
    const experiments = await loadExperiments(paths.experiments);
    const rankHistory = await loadRankHistory(paths.rankHistory);

    const opportunity = opportunities.find((o) => o.id === options.opportunityId);
    if (!opportunity) {
      return {
        exitCode: 1,
        report: `# propose report — ${generatedAt}\n\n## Error\n- no Opportunity found with id ${options.opportunityId}\n`,
      };
    }

    try {
      assertCanCreateExperiment(opportunity, experiments);
      assertUnderMaxActiveExperiments(experiments, options.maxActiveExperiments);
      assertNoActivePageConflict(
        { action: options.input.action, measurementPlan: options.input.measurementPlan },
        experiments,
      );
      assertNoActiveQueryConflict({ measurementPlan: options.input.measurementPlan }, experiments);
    } catch (err) {
      if (
        err instanceof ActiveExperimentGuardError ||
        err instanceof OpportunityNotOpenError ||
        err instanceof MaxActiveExperimentsError ||
        err instanceof PageConflictError ||
        err instanceof QueryConflictError
      ) {
        return {
          exitCode: 1,
          report: generateProposeReport({
            generatedAt,
            dryRun: options.dryRun,
            opportunity,
            hypothesis: {
              id: '(rejected)',
              opportunityId: opportunity.id,
              createdAt: generatedAt,
              statement: options.input.hypothesis.statement,
              expectedSignals: options.input.hypothesis.expectedSignals,
              rationale: options.input.hypothesis.rationale,
            },
            action: options.input.action,
            experiment: null,
            before: null,
            error: err.message,
          }),
        };
      }
      throw err;
    }

    const hypothesis: Hypothesis = {
      id: generateId(),
      opportunityId: opportunity.id,
      createdAt: generatedAt,
      statement: options.input.hypothesis.statement,
      expectedSignals: options.input.hypothesis.expectedSignals,
      rationale: options.input.hypothesis.rationale,
    };

    const rawSnapshot = computeMetricsSnapshot({
      rankHistory,
      measurementPlan: options.input.measurementPlan,
      today: options.today,
      windowDays: options.input.measurementPlan.baselineWindowDays,
      finalDataLagDays: options.finalDataLagDays,
      source: options.metricsSource,
      now: generatedAt,
    });
    const before = rawSnapshot.sufficientData ? rawSnapshot : null;

    const experiment = buildExperiment({
      opportunity,
      hypothesis,
      action: options.input.action,
      measurementPlan: options.input.measurementPlan,
      before,
      now: generatedAt,
    });

    const promotedOpportunity = promoteOpportunity(opportunity, experiment.id, generatedAt);

    if (!options.dryRun) {
      await saveExperiments(paths.experiments, [...experiments, experiment]);
      await saveOpportunities(
        paths.opportunities,
        opportunities.map((o) => (o.id === opportunity.id ? promotedOpportunity : o)),
      );
    }

    const report = generateProposeReport({
      generatedAt,
      dryRun: options.dryRun,
      opportunity: promotedOpportunity,
      hypothesis,
      action: options.input.action,
      experiment,
      before,
      serpEvidenceQuery: options.serp?.query,
    });

    return { exitCode: 0, report };
  } finally {
    await lock.release();
  }
}
