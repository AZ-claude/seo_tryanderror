import { createHash } from 'node:crypto';
import { countWords } from './text.js';
import type { Experiment, GscSummaryRow, PageSnapshot, SiteMaturity, SiteUnderstanding } from './types.js';

export const DEFAULT_EXCERPT_MAX_CHARS = 4000;
export const DEFAULT_GSC_TOP_QUERIES = 20;
const UNREGISTERED_IMPRESSIONS_FLOOR = 10;

/** DESIGN.md 6.7 / 12: bounded excerpt + content hash, never the full page text. */
export function buildPageSnapshot(input: {
  path: string;
  title?: string;
  headings: string[];
  text: string;
  fetchedAt: string;
  excerptMaxChars?: number;
}): PageSnapshot {
  const maxChars = input.excerptMaxChars ?? DEFAULT_EXCERPT_MAX_CHARS;
  const cleaned = input.text.replace(/\s+/g, ' ').trim();
  const truncated = cleaned.length > maxChars;
  const excerpt = truncated ? cleaned.slice(0, maxChars) : cleaned;
  const contentHash = createHash('sha256').update(cleaned).digest('hex');

  return {
    path: input.path,
    title: input.title,
    headings: input.headings,
    excerpt,
    excerptTruncated: truncated,
    contentHash,
    wordCount: countWords(cleaned),
    fetchedAt: input.fetchedAt,
  };
}

/** DESIGN.md 12: GSC top-query list is bounded, never the raw unbounded matrix. */
export function selectTopQueries(rows: GscSummaryRow[], limit = DEFAULT_GSC_TOP_QUERIES): GscSummaryRow[] {
  return [...rows]
    .filter((r) => r.impressions >= UNREGISTERED_IMPRESSIONS_FLOOR)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit);
}

/** DESIGN.md 4.3: heuristic maturity classification, display-only in Milestone 1A. */
export function computeMaturity(input: {
  pageCount: number;
  hasGscData: boolean;
  observingOrConcludedCount: number;
}): SiteMaturity {
  if (input.pageCount === 0) return 'bootstrap';
  if (!input.hasGscData || input.observingOrConcludedCount === 0) return 'exploring';
  if (input.observingOrConcludedCount < 5) return 'growing';
  return 'optimizing';
}

export function countObservingOrConcluded(experiments: Experiment[]): number {
  return experiments.filter((e) => e.status === 'observing' || e.status === 'concluded').length;
}

export function buildSiteUnderstanding(input: {
  baseUrl: string;
  pages: PageSnapshot[];
  themes: string[];
  proprietaryDataNotes: string[];
  gscSummary?: SiteUnderstanding['gscSummary'];
  maturity: SiteMaturity;
  generatedAt: string;
}): SiteUnderstanding {
  return {
    schemaVersion: 2,
    site: { baseUrl: input.baseUrl },
    generatedAt: input.generatedAt,
    pages: input.pages,
    themes: input.themes,
    proprietaryDataNotes: input.proprietaryDataNotes,
    gscSummary: input.gscSummary,
    maturity: input.maturity,
  };
}
