import { acquireLock } from '../../infra/fs-lock.js';
import { loadExperiments, saveExperiments } from '../../infra/json-store.js';
import { addDays } from '../date.js';
import { transitionExperiment } from '../experiment.js';
import type { ApplyEvidence, Experiment } from '../types.js';

export type ApplyPaths = {
  experiments: string;
  lock: string;
};

export type ApplyOptions = {
  experimentId: string;
  evidence: ApplyEvidence;
  today: string;
  now: string;
  dryRun: boolean;
};

export type ApplyResult = {
  report: string;
  exitCode: 0 | 1;
};

/**
 * Minimal Milestone 2 apply (DESIGN.md 10.6/13, YAGNI-scoped): only
 * `action.type === 'REVISE'` on a single already-`proposed` Experiment.
 * Does not itself edit the site repo or call B — the site edit, B review,
 * test/build, commit and deploy already happened directly in the site repo;
 * this records that evidence as an append-only Experiment history
 * (proposed -> approved -> applied -> observing), validating it first.
 * CREATE/MERGE/SPLIT/RETIRE and any generalized SiteWriter/NaturalWriter
 * executor remain out of scope (DESIGN.md 9.6 NotImplementedActionExecutor).
 */
export async function runApply(paths: ApplyPaths, options: ApplyOptions): Promise<ApplyResult> {
  const { experimentId, evidence, today, now, dryRun } = options;
  const lock = await acquireLock(paths.lock);
  try {
    const experiments = await loadExperiments(paths.experiments);
    const experiment = experiments.find((e) => e.id === experimentId);

    const errors: string[] = [];
    if (!experiment) {
      errors.push(`no Experiment found with id ${experimentId}`);
    } else {
      if (experiment.action.type !== 'REVISE') {
        errors.push(`apply only supports action.type === 'REVISE' (this Experiment is ${experiment.action.type})`);
      }
      if (experiment.status !== 'proposed') {
        errors.push(`Experiment status must be 'proposed' to apply (currently '${experiment.status}')`);
      }
      if (!experiment.measurementPlan.targetPages.includes(evidence.targetPage)) {
        errors.push(
          `evidence.targetPage (${evidence.targetPage}) is not in this Experiment's measurementPlan.targetPages`,
        );
      }
    }
    if (evidence.bReview.claimPreservation.invented !== 0 || evidence.bReview.claimPreservation.modified !== 0) {
      errors.push(
        `B claim-preservation hard gate failed: invented=${evidence.bReview.claimPreservation.invented}, modified=${evidence.bReview.claimPreservation.modified} (both must be 0)`,
      );
    }
    if (evidence.liveVerification.httpStatus !== 200) {
      errors.push(`live verification HTTP status was ${evidence.liveVerification.httpStatus}, not 200`);
    }
    if (!evidence.liveVerification.sectionPresent) {
      errors.push('live verification: added section not confirmed present');
    }
    if (!evidence.liveVerification.canonicalUnchanged || !evidence.liveVerification.noindexUnchanged) {
      errors.push('live verification: canonical/noindex changed unexpectedly');
    }

    if (errors.length > 0 || !experiment) {
      return { exitCode: 1, report: generateApplyReport({ generatedAt: now, dryRun, experimentId, errors, evidence }) };
    }

    const reviewWindowDays = experiment.measurementPlan.reviewWindowDays;
    const observation = {
      start: today,
      end: addDays(today, reviewWindowDays),
      nextReviewDate: addDays(today, reviewWindowDays),
    };

    const approved = transitionExperiment(
      experiment,
      'approved',
      now,
      `Evidence validated: B claim-preservation hard gate passed (invented=0, modified=0); site validation ${evidence.siteValidation.lintContent} / ${evidence.siteValidation.build}; live verification HTTP ${evidence.liveVerification.httpStatus}, section present, canonical/noindex unchanged.`,
    );
    const applied = transitionExperiment(
      approved,
      'applied',
      now,
      `${evidence.actionSummary} Commit ${evidence.commitSha} on ${evidence.siteRepo}@${evidence.commitBranch}, files: ${evidence.changedFiles.join(', ')}. Deployed via ${evidence.deployMethod}.`,
    );
    const observing: Experiment = {
      ...transitionExperiment(
        applied,
        'observing',
        now,
        `Observation window started: ${observation.start} .. ${observation.end} (reviewWindowDays=${reviewWindowDays}).`,
      ),
      observation,
    };

    if (!dryRun) {
      await saveExperiments(
        paths.experiments,
        experiments.map((e) => (e.id === experimentId ? observing : e)),
      );
    }

    return {
      exitCode: 0,
      report: generateApplyReport({ generatedAt: now, dryRun, experimentId, errors: [], evidence, result: observing }),
    };
  } finally {
    await lock.release();
  }
}

function generateApplyReport(data: {
  generatedAt: string;
  dryRun: boolean;
  experimentId: string;
  errors: string[];
  evidence: ApplyEvidence;
  result?: Experiment;
}): string {
  const lines: string[] = [];
  lines.push(`# apply report — ${data.generatedAt}`);
  if (data.dryRun) lines.push('\n**DRY RUN** — no files were written.');
  lines.push(`\n## Experiment\n- id: ${data.experimentId}`);
  lines.push(`\n## Evidence`);
  lines.push(`- targetPage: ${data.evidence.targetPage}`);
  lines.push(`- siteRepo: ${data.evidence.siteRepo}`);
  lines.push(`- changedFiles: ${data.evidence.changedFiles.join(', ')}`);
  lines.push(`- commit: ${data.evidence.commitSha} (${data.evidence.commitBranch})`);
  lines.push(`- B claim preservation: ${JSON.stringify(data.evidence.bReview.claimPreservation)}`);
  lines.push(`- site validation: lint=${data.evidence.siteValidation.lintContent}, build=${data.evidence.siteValidation.build}`);
  lines.push(`- live verification: HTTP ${data.evidence.liveVerification.httpStatus}, sectionPresent=${data.evidence.liveVerification.sectionPresent}, existingSectionsIntact=${data.evidence.liveVerification.existingSectionsIntact.join(', ')}`);
  if (data.errors.length > 0) {
    lines.push(`\n## Errors (not applied)`);
    for (const e of data.errors) lines.push(`- ${e}`);
  } else if (data.result) {
    lines.push(`\n## Transition`);
    lines.push(`- status: proposed -> approved -> applied -> observing`);
    lines.push(`- observation: ${JSON.stringify(data.result.observation)}`);
    lines.push(`\n## History`);
    for (const h of data.result.history) lines.push(`- ${h.at} ${h.type}${h.note ? `: ${h.note}` : ''}`);
  }
  lines.push('\nRank/impression improvements are never predicted or guaranteed; only measured outcomes are reported.');
  return `${lines.join('\n')}\n`;
}
