import { acquireLock } from '../../infra/fs-lock.js';
import { loadOpportunities, saveOpportunities } from '../../infra/json-store.js';
import { rejectOpportunity } from '../opportunity.js';

export type RejectOpportunityPaths = {
  opportunities: string;
  lock: string;
};

export type RejectOpportunityOptions = {
  opportunityId: string;
  reason: string;
  now: string;
  dryRun: boolean;
};

export type RejectOpportunityResult = {
  report: string;
  exitCode: 0 | 1;
};

/**
 * Rejects an `open` Opportunity (reuses opportunity.rejectOpportunity(),
 * which appends a 'rejected' OpportunityEvent — history is never rewritten).
 * Refuses anything other than `open`: a `promoted` Opportunity has an active
 * Experiment attached (reject that Experiment first, which releases the
 * Opportunity back to open), and `rejected`/`stale` are already terminal.
 */
export async function runRejectOpportunity(
  paths: RejectOpportunityPaths,
  options: RejectOpportunityOptions,
): Promise<RejectOpportunityResult> {
  const { opportunityId, reason, now, dryRun } = options;
  const lock = await acquireLock(paths.lock);
  try {
    const opportunities = await loadOpportunities(paths.opportunities);
    const opportunity = opportunities.find((o) => o.id === opportunityId);
    if (!opportunity) {
      return { exitCode: 1, report: `# reject-opportunity report — ${now}\n\n## Error\n- no Opportunity found with id ${opportunityId}\n` };
    }
    if (opportunity.status !== 'open') {
      return {
        exitCode: 1,
        report: `# reject-opportunity report — ${now}\n\n## Error\n- Opportunity ${opportunityId} is not 'open' (status=${opportunity.status}); cannot reject. If it is 'promoted', reject its active Experiment first.\n`,
      };
    }

    const rejected = rejectOpportunity(opportunity, reason, now);
    const nextOpportunities = opportunities.map((o) => (o.id === opportunityId ? rejected : o));

    if (!dryRun) {
      await saveOpportunities(paths.opportunities, nextOpportunities);
    }

    const lines: string[] = [];
    lines.push(`# reject-opportunity report — ${now}`);
    if (dryRun) lines.push('\n**DRY RUN** — no files were written.');
    lines.push(`\n## Opportunity`);
    lines.push(`- id: ${rejected.id}`);
    lines.push(`- status: ${opportunity.status} -> rejected`);
    lines.push(`- reason: ${reason}`);
    lines.push(`\n## History`);
    for (const h of rejected.history) lines.push(`- ${h.at} ${h.type}${h.note ? `: ${h.note}` : ''}`);

    return { exitCode: 0, report: `${lines.join('\n')}\n` };
  } finally {
    await lock.release();
  }
}
