import { acquireLock } from '../../infra/fs-lock.js';
import { loadExperiments, loadOpportunities, loadRankHistory, loadSiteUnderstanding, saveOpportunities } from '../../infra/json-store.js';
import { isIntentSlugTooCloseToTitle, mergeDiscoveredOpportunity } from '../opportunity.js';
import { generateDiscoverReport } from '../report.js';
import type {
  DiscoverOpportunityInput,
  Experiment,
  ExperimentMemory,
  GscSummaryRow,
  Opportunity,
  RankHistoryEntry,
  SiteUnderstanding,
} from '../types.js';

export type DiscoverPaths = {
  siteUnderstanding: string;
  opportunities: string;
  experiments: string;
  lock: string;
  rankHistory: string;
};

const MAX_GSC_EVIDENCE_ROWS = 500;
const MAX_EXPERIMENT_MEMORY = 50;

export type GscEvidence = {
  window?: { start: string; end: string; days: number };
  rows: GscSummaryRow[];
};

export type DiscoverDumpResult = {
  siteUnderstanding: SiteUnderstanding;
  gscEvidence?: GscEvidence;
  existingOpportunityIdentities: Array<{ id: string; scopeKey: string; intentKey: string; kind: string; title: string }>;
  experimentMemory: ExperimentMemory[];
  bootstrapModeSuggested: boolean;
};

/**
 * Bounded recent history of concluded Experiments (DESIGN.md rolling PDCA:
 * "did we already try this on this page, and what happened?"). Most
 * recently concluded first; capped so the dump stays bounded on a
 * long-running site.
 */
export function buildExperimentMemory(experiments: Experiment[]): ExperimentMemory[] {
  return experiments
    .filter((e) => e.status === 'concluded' && e.result)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, MAX_EXPERIMENT_MEMORY)
    .map((e) => ({
      experimentId: e.id,
      opportunityId: e.opportunityId,
      actionType: e.action.type,
      targetPaths: e.action.targetPaths,
      outcome: e.result!.outcome,
      ...(e.learning ? { learning: e.learning } : {}),
      concludedAt: e.updatedAt,
    }));
}

/**
 * Bounded, unfiltered query×page evidence from the most recent GSC
 * rank-history snapshot (DESIGN.md 10.3). Unlike
 * siteUnderstanding.gscSummary.topQueries (which applies an impressions
 * floor for the persisted understanding report), this keeps every row —
 * including 1-9 impression queries — since low-traffic sites need those as
 * discovery signal. Never mixes snapshots or non-'gsc' sources.
 */
async function loadGscEvidence(rankHistoryPath: string): Promise<GscEvidence | undefined> {
  const history = await loadRankHistory(rankHistoryPath);
  return buildGscEvidence(history.entries);
}

export function buildGscEvidence(entries: RankHistoryEntry[]): GscEvidence | undefined {
  const gscEntries = entries.filter((e) => e.source === 'gsc');
  if (gscEntries.length === 0) return undefined;
  const latest = gscEntries.reduce((a, b) => (b.date > a.date ? b : a));
  const rows = [...latest.rows].sort((a, b) => b.impressions - a.impressions).slice(0, MAX_GSC_EVIDENCE_ROWS);
  return { window: latest.window, rows };
}

/** `discover --dump-inputs`: structured material for the Skill, no persistence (DESIGN.md 10.3). */
export async function dumpDiscoverInputs(paths: DiscoverPaths): Promise<DiscoverDumpResult> {
  const siteUnderstanding = await loadSiteUnderstanding(paths.siteUnderstanding);
  const opportunities = await loadOpportunities(paths.opportunities);
  const experiments = await loadExperiments(paths.experiments);
  const gscEvidence = await loadGscEvidence(paths.rankHistory);
  return {
    siteUnderstanding,
    ...(gscEvidence ? { gscEvidence } : {}),
    existingOpportunityIdentities: opportunities.map((o) => ({
      id: o.id,
      scopeKey: o.identity.scopeKey,
      intentKey: o.identity.intentKey,
      kind: o.kind,
      title: o.title,
    })),
    experimentMemory: buildExperimentMemory(experiments),
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
