import type { MergeOutcome } from './opportunity.js';
import type { ExcludedOpportunity } from './prioritize.js';
import type { Action, Experiment, Hypothesis, MetricsSnapshot, Opportunity, PageSnapshot, StatusView } from './types.js';

function renderList(lines: string[]): string {
  return lines.length > 0 ? lines.map((l) => `- ${l}`).join('\n') : '- (none)';
}

const DISCLAIMER = 'Rank/impression improvements are never predicted or guaranteed; only measured outcomes are reported.';

// --- understand ---

export type UnderstandReportData = {
  generatedAt: string;
  dryRun: boolean;
  baseUrl: string;
  pagesRead: number;
  pagesFailed: Array<{ path: string; error: string }>;
  gsc: { status: 'ok' | 'GSC_NOT_CONFIGURED' | 'GSC_FETCH_FAILED'; window?: { start: string; end: string; days: number }; message?: string };
  themes: string[];
  proprietaryDataNotes: string[];
  errors: string[];
};

export function generateUnderstandReport(data: UnderstandReportData): string {
  const lines: string[] = [];
  lines.push(`# understand report — ${data.generatedAt}`);
  if (data.dryRun) lines.push('\n**DRY RUN** — no files were written.');
  lines.push(`\n## Site`);
  lines.push(`- baseUrl: ${data.baseUrl}`);
  lines.push(`- pages read: ${data.pagesRead}`);
  lines.push(`- pages failed: ${data.pagesFailed.length}`);
  if (data.pagesFailed.length > 0) {
    lines.push(renderList(data.pagesFailed.map((p) => `${p.path}: ${p.error}`)));
  }
  lines.push(`\n## GSC`);
  lines.push(`- status: ${data.gsc.status}`);
  if (data.gsc.window) lines.push(`- window: ${data.gsc.window.start} .. ${data.gsc.window.end} (${data.gsc.window.days} days)`);
  if (data.gsc.message) lines.push(`- ${data.gsc.message}`);
  lines.push(`\n## Themes (draft)`);
  lines.push(renderList(data.themes));
  lines.push(`\n## Proprietary data notes`);
  lines.push(renderList(data.proprietaryDataNotes));
  if (data.errors.length > 0) {
    lines.push('\n## Errors');
    lines.push(renderList(data.errors));
  }
  lines.push(`\n${DISCLAIMER}`);
  return `${lines.join('\n')}\n`;
}

// --- discover ---

export type DiscoverReportData = {
  generatedAt: string;
  dryRun: boolean;
  created: Opportunity[];
  evidenceAppended: Opportunity[];
  skippedPromoted: string[];
  skippedRejectedNeedsReopen: string[];
  reopened: Opportunity[];
  intentSlugWarnings: string[];
  bootstrapModeSuggested: boolean;
};

export function generateDiscoverReport(data: DiscoverReportData): string {
  const lines: string[] = [];
  lines.push(`# discover report — ${data.generatedAt}`);
  if (data.dryRun) lines.push('\n**DRY RUN** — no files were written.');
  lines.push(`\n## New Opportunities (${data.created.length})`);
  lines.push(
    renderList(
      data.created.map((o) => `${o.title} [${o.kind}] scope=${JSON.stringify(o.scope)} evidence=${o.evidence.length}`),
    ),
  );
  lines.push(`\n## Existing Opportunities updated (evidence appended) (${data.evidenceAppended.length})`);
  lines.push(renderList(data.evidenceAppended.map((o) => `${o.id}: ${o.title}`)));
  lines.push(`\n## Reopened (${data.reopened.length})`);
  lines.push(renderList(data.reopened.map((o) => `${o.id}: ${o.title}`)));
  lines.push(`\n## Skipped: already promoted (${data.skippedPromoted.length})`);
  lines.push(renderList(data.skippedPromoted));
  lines.push(`\n## Skipped: rejected, needs explicit reopen+reason (${data.skippedRejectedNeedsReopen.length})`);
  lines.push(renderList(data.skippedRejectedNeedsReopen));
  if (data.intentSlugWarnings.length > 0) {
    lines.push('\n## Warnings');
    lines.push(renderList(data.intentSlugWarnings));
  }
  if (data.bootstrapModeSuggested) {
    lines.push(
      '\n## Note\n- no pages/GSC data in site-understanding.json: this looks like Bootstrap Mode. Market/SERP research-driven discovery is not automated in Milestone 1A.',
    );
  }
  lines.push(`\n${DISCLAIMER}`);
  return `${lines.join('\n')}\n`;
}

// --- prioritize ---

export type PrioritizeReportData = {
  generatedAt: string;
  ranked: Opportunity[];
  excluded: ExcludedOpportunity[];
};

export function generatePrioritizeReport(data: PrioritizeReportData): string {
  const lines: string[] = [];
  lines.push(`# prioritize report — ${data.generatedAt}`);
  lines.push(`\n## Ranked Opportunities (${data.ranked.length})`);
  lines.push(
    renderList(
      data.ranked.map((o, i) => `${i + 1}. [${o.id}] ${o.title} (kind=${o.kind}, evidence=${o.evidence.length})`),
    ),
  );
  lines.push(`\n## Excluded (${data.excluded.length})`);
  lines.push(renderList(data.excluded.map((e) => `${e.id}: ${e.reason}`)));
  lines.push(`\n${DISCLAIMER}`);
  return `${lines.join('\n')}\n`;
}

// --- propose ---

export type ProposeReportData = {
  generatedAt: string;
  dryRun: boolean;
  opportunity: Opportunity;
  hypothesis: Hypothesis;
  action: Action;
  experiment: Experiment | null;
  before: MetricsSnapshot | null;
  serpEvidenceQuery?: string;
  error?: string;
};

export function generateProposeReport(data: ProposeReportData): string {
  const lines: string[] = [];
  lines.push(`# propose report — ${data.generatedAt}`);
  if (data.dryRun) lines.push('\n**DRY RUN** — no files were written.');
  lines.push(`\n## Opportunity`);
  lines.push(`- id: ${data.opportunity.id}`);
  lines.push(`- title: ${data.opportunity.title}`);
  lines.push(`- kind: ${data.opportunity.kind}`);
  lines.push(`\n## Hypothesis`);
  lines.push(`- statement: ${data.hypothesis.statement}`);
  lines.push(`- rationale: ${data.hypothesis.rationale}`);
  lines.push(`- expectedSignals: ${data.hypothesis.expectedSignals.join(', ')}`);
  lines.push(`\n## Action (proposed, not applied)`);
  lines.push(`- type: ${data.action.type}`);
  lines.push(`- targetPaths: ${data.action.targetPaths.join(', ')}`);
  lines.push(`- summary: ${data.action.summary}`);
  lines.push(`\n## Before snapshot`);
  if (data.before && data.before.sufficientData) {
    lines.push(`- window: ${data.before.window.start} .. ${data.before.window.end}`);
    lines.push(`- metrics: ${JSON.stringify(data.before.metrics)}`);
  } else {
    lines.push('- insufficient_data (not enough measured history in scope; this is not the same as "no effect")');
  }
  if (data.serpEvidenceQuery) {
    lines.push(`\n## SERP evidence\n- query: ${data.serpEvidenceQuery}`);
  }
  if (data.experiment) {
    lines.push(`\n## Experiment`);
    lines.push(`- id: ${data.experiment.id}`);
    lines.push(`- status: ${data.experiment.status}`);
  }
  if (data.error) {
    lines.push(`\n## Error\n- ${data.error}`);
  }
  lines.push(`\n${DISCLAIMER}`);
  return `${lines.join('\n')}\n`;
}

// --- status ---

export function generateStatusReport(generatedAt: string, status: StatusView): string {
  const lines: string[] = [];
  lines.push(`# status — ${generatedAt}`);
  lines.push(`\n- openOpportunities: ${status.openOpportunities}`);
  lines.push(`- proposedExperiments: ${status.proposedExperiments}`);
  lines.push(`\n## Observing`);
  lines.push(renderList(status.observingExperiments.map((e) => `${e.id}: ${e.opportunityTitle} (nextReviewDate=${e.nextReviewDate})`)));
  lines.push(`\n## Due for review`);
  lines.push(renderList(status.dueForReviewExperiments.map((e) => `${e.id}: ${e.opportunityTitle}`)));
  lines.push(`\n## Concluded recently`);
  lines.push(renderList(status.concludedRecently.map((e) => `${e.id}: ${e.result?.outcome ?? 'n/a'}`)));
  return `${lines.join('\n')}\n`;
}

export function summarizeMergeOutcome(outcome: MergeOutcome): string {
  return outcome.kind;
}

export function pageSnapshotSummary(page: PageSnapshot): string {
  return `${page.path}: ${page.wordCount} words${page.excerptTruncated ? ' (truncated)' : ''}`;
}
