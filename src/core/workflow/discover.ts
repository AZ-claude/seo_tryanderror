import { acquireLock } from '../../infra/fs-lock.js';
import { loadOpportunities, loadSiteUnderstanding, saveOpportunities } from '../../infra/json-store.js';
import { isIntentSlugTooCloseToTitle, mergeDiscoveredOpportunity } from '../opportunity.js';
import { generateDiscoverReport } from '../report.js';
import type { DiscoverOpportunityInput, Opportunity, SiteUnderstanding } from '../types.js';

export type DiscoverPaths = {
  siteUnderstanding: string;
  opportunities: string;
  lock: string;
};

export type DiscoverDumpResult = {
  siteUnderstanding: SiteUnderstanding;
  existingOpportunityIdentities: Array<{ id: string; scopeKey: string; intentKey: string; kind: string; title: string }>;
  bootstrapModeSuggested: boolean;
};

/** `discover --dump-inputs`: structured material for the Skill, no persistence (DESIGN.md 10.3). */
export async function dumpDiscoverInputs(paths: DiscoverPaths): Promise<DiscoverDumpResult> {
  const siteUnderstanding = await loadSiteUnderstanding(paths.siteUnderstanding);
  const opportunities = await loadOpportunities(paths.opportunities);
  return {
    siteUnderstanding,
    existingOpportunityIdentities: opportunities.map((o) => ({
      id: o.id,
      scopeKey: o.identity.scopeKey,
      intentKey: o.identity.intentKey,
      kind: o.kind,
      title: o.title,
    })),
    bootstrapModeSuggested: siteUnderstanding.pages.length === 0 && siteUnderstanding.gscSummary === undefined,
  };
}

export type DiscoverResult = {
  opportunities: Opportunity[];
  report: string;
};

export async function runDiscover(
  paths: DiscoverPaths,
  candidates: DiscoverOpportunityInput[],
  now: string,
  dryRun: boolean,
): Promise<DiscoverResult> {
  const generatedAt = now;
  const lock = await acquireLock(paths.lock);
  try {
    const siteUnderstanding = await loadSiteUnderstanding(paths.siteUnderstanding).catch(
      () => null as SiteUnderstanding | null,
    );
    let opportunities = await loadOpportunities(paths.opportunities);

    const created: Opportunity[] = [];
    const evidenceAppended: Opportunity[] = [];
    const skippedPromoted: string[] = [];
    const skippedRejectedNeedsReopen: string[] = [];
    const reopened: Opportunity[] = [];
    const intentSlugWarnings: string[] = [];

    for (const candidate of candidates) {
      if (isIntentSlugTooCloseToTitle(candidate.intentSlug, candidate.title)) {
        intentSlugWarnings.push(
          `intentSlug "${candidate.intentSlug}" looks like a normalized copy of title "${candidate.title}" — consider a distinct intent slug`,
        );
      }
      const outcome = mergeDiscoveredOpportunity(opportunities, candidate, now);
      switch (outcome.kind) {
        case 'created':
          opportunities = [...opportunities, outcome.opportunity];
          created.push(outcome.opportunity);
          break;
        case 'evidence_appended':
          opportunities = opportunities.map((o) => (o.id === outcome.opportunity.id ? outcome.opportunity : o));
          evidenceAppended.push(outcome.opportunity);
          break;
        case 'reopened':
          opportunities = opportunities.map((o) => (o.id === outcome.opportunity.id ? outcome.opportunity : o));
          reopened.push(outcome.opportunity);
          break;
        case 'skipped_promoted':
          skippedPromoted.push(outcome.opportunityId);
          break;
        case 'skipped_rejected_needs_reopen':
          skippedRejectedNeedsReopen.push(outcome.opportunityId);
          break;
      }
    }

    if (!dryRun) {
      await saveOpportunities(paths.opportunities, opportunities);
    }

    const bootstrapModeSuggested = siteUnderstanding
      ? siteUnderstanding.pages.length === 0 && siteUnderstanding.gscSummary === undefined
      : false;

    const report = generateDiscoverReport({
      generatedAt,
      dryRun,
      created,
      evidenceAppended,
      skippedPromoted,
      skippedRejectedNeedsReopen,
      reopened,
      intentSlugWarnings,
      bootstrapModeSuggested,
    });

    return { opportunities, report };
  } finally {
    await lock.release();
  }
}
