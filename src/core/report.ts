import type {
  ChangeType,
  KeywordRecord,
  RankHistoryEntry,
  ReviewOutcome,
  SeoPlan,
  UnregisteredQuery,
} from './types.js';

export type RankMovement = {
  keyword: string;
  previousRank: number | null;
  currentRank: number | null;
};

export type ReviewedItem = {
  keyword: string;
  outcome: ReviewOutcome;
  previousRank: number | null;
  currentRank: number | null;
};

export type ObservingItem = {
  keyword: string;
  nextReviewDate: string | null;
};

export type SelectionReport = {
  keyword: KeywordRecord;
  reason: string;
  plan: SeoPlan;
  changeSummary: string;
} | null;

export type ValidationReport = {
  ok: boolean;
  output: string;
} | null;

export type ReportData = {
  generatedAt: string;
  dryRun: boolean;
  measurement: {
    source: RankHistoryEntry['source'];
    window?: RankHistoryEntry['window'];
  } | null;
  significantMovements: RankMovement[];
  reviewed: ReviewedItem[];
  observing: ObservingItem[];
  selection: SelectionReport;
  validation: ValidationReport;
  unregisteredQuerySuggestions: UnregisteredQuery[];
  errors: string[];
};

const CHANGE_TYPE_LABEL: Record<ChangeType, string> = {
  title: 'title',
  description: 'description',
  intro: 'intro',
  faq: 'faq',
  content: 'content',
  internal_link: 'internal_link',
  data: 'data',
  other: 'other',
};

function renderList(lines: string[]): string {
  return lines.length > 0 ? lines.map((l) => `- ${l}`).join('\n') : '- (none)';
}

export function generateReport(data: ReportData): string {
  const lines: string[] = [];
  lines.push(`# SEO run report — ${data.generatedAt}`);
  if (data.dryRun) lines.push('\n**DRY RUN** — no files were written.');

  lines.push('\n## Measurement');
  if (data.measurement) {
    const w = data.measurement.window;
    lines.push(
      `- source: ${data.measurement.source}` +
        (w ? `\n- window: ${w.start} .. ${w.end} (${w.days} days)` : ''),
    );
  } else {
    lines.push('- (no new measurement this run)');
  }

  lines.push('\n## Significant rank movements');
  lines.push(
    renderList(
      data.significantMovements.map(
        (m) => `${m.keyword}: ${m.previousRank ?? 'null'} -> ${m.currentRank ?? 'null'}`,
      ),
    ),
  );

  lines.push('\n## Reviewed experiments');
  lines.push(
    renderList(
      data.reviewed.map(
        (r) =>
          `${r.keyword}: ${r.outcome} (${r.previousRank ?? 'null'} -> ${r.currentRank ?? 'null'})`,
      ),
    ),
  );

  lines.push('\n## Observing');
  lines.push(
    renderList(data.observing.map((o) => `${o.keyword}: nextReviewDate=${o.nextReviewDate ?? 'n/a'}`)),
  );

  lines.push('\n## Selected keyword');
  if (data.selection) {
    const { keyword, reason, plan, changeSummary } = data.selection;
    lines.push(`- keyword: ${keyword.keyword} (${keyword.targetPath})`);
    lines.push(`- reason: ${reason}`);
    lines.push(`- searchNeed: ${plan.searchNeed}`);
    lines.push(`- gap: ${plan.selectedGap}`);
    lines.push(`- requestedChange (${CHANGE_TYPE_LABEL[plan.changeType]}): ${plan.requestedChange}`);
    lines.push(`- applied: ${changeSummary}`);
  } else {
    lines.push('- (no candidate this run)');
  }

  lines.push('\n## Validation');
  lines.push(data.validation ? `- ok=${data.validation.ok}\n\n\`\`\`\n${data.validation.output}\n\`\`\`` : '- (not run)');

  lines.push('\n## Unregistered query suggestions');
  lines.push(
    renderList(
      data.unregisteredQuerySuggestions.map(
        (q) => `${q.query}: rank=${q.rank}, impressions=${q.impressions}, clicks=${q.clicks}`,
      ),
    ),
  );

  if (data.errors.length > 0) {
    lines.push('\n## Errors');
    lines.push(renderList(data.errors));
  }

  lines.push('\nRank improvements are never predicted or guaranteed; only measured outcomes are reported.');

  return `${lines.join('\n')}\n`;
}
