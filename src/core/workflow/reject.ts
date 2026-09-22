import { acquireLock } from '../../infra/fs-lock.js';
import { loadExperiments, loadOpportunities, saveExperiments, saveOpportunities } from '../../infra/json-store.js';
import { hasActiveExperiment, transitionExperiment } from '../experiment.js';
import { releaseOpportunity } from '../opportunity.js';
import type { Experiment } from '../types.js';

export type RejectPaths = {
  experiments: string;
  opportunities: string;
  lock: string;
};

export type RejectOptions = {
  experimentId: string;
  reason: string;
  now: string;
  dryRun: boolean;
};

export type RejectResult = {
  report: string;
  exitCode: 0 | 1;
};

/**
 * Rejects a non-terminal Experiment without discarding its history
 * (transitionExperiment appends a 'rejected' ExperimentEvent; the prior
 * proposed/approved/... events stay). Reuses the same active-experiment
 * release rule as a checkpoint conclude (review.ts): if the Opportunity is
 * still 'promoted' and no other active Experiment references it, it goes
 * back to 'open' so it can be re-proposed with a corrected shape.
 */
export async function runReject(paths: RejectPaths, options: RejectOptions): Promise<RejectResult> {
  const { experimentId, reason, now, dryRun } = options;
  const lock = await acquireLock(paths.lock);
  try {
    const experiments = await loadExperiments(paths.experiments);
    const experiment = experiments.find((e) => e.id === experimentId);
    if (!experiment) {
      return { exitCode: 1, report: `# reject report — ${now}\n\n## Error\n- no Experiment found with id ${experimentId}\n` };
    }

    let rejected: Experiment;
    try {
      rejected = transitionExperiment(experiment, 'rejected', now, reason);
    } catch (err) {
      return { exitCode: 1, report: `# reject report — ${now}\n\n## Error\n- ${(err as Error).message}\n` };
    }

    const nextExperiments = experiments.map((e) => (e.id === experimentId ? rejected : e));

    const opportunities = await loadOpportunities(paths.opportunities);
    const opportunity = opportunities.find((o) => o.id === rejected.opportunityId);
    let nextOpportunities = opportunities;
    let released = false;
    if (opportunity && opportunity.status === 'promoted' && !hasActiveExperiment(nextExperiments, opportunity.id)) {
      const releasedOpportunity = releaseOpportunity(opportunity, rejected.id, now);
      nextOpportunities = opportunities.map((o) => (o.id === releasedOpportunity.id ? releasedOpportunity : o));
      released = true;
    }

    if (!dryRun) {
      await saveExperiments(paths.experiments, nextExperiments);
      if (released) await saveOpportunities(paths.opportunities, nextOpportunities);
    }

    const lines: string[] = [];
    lines.push(`# reject report — ${now}`);
    if (dryRun) lines.push('\n**DRY RUN** — no files were written.');
    lines.push(`\n## Experiment`);
    lines.push(`- id: ${rejected.id}`);
    lines.push(`- opportunityId: ${rejected.opportunityId}`);
    lines.push(`- status: ${experiment.status} -> rejected`);
    lines.push(`- reason: ${reason}`);
    lines.push(`\n## Opportunity`);
    lines.push(`- released back to open: ${released}`);
    lines.push(`\n## History`);
    for (const h of rejected.history) lines.push(`- ${h.at} ${h.type}${h.note ? `: ${h.note}` : ''}`);

    return { exitCode: 0, report: `${lines.join('\n')}\n` };
  } finally {
    await lock.release();
  }
}
