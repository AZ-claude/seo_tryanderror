import { acquireLock } from '../../infra/fs-lock.js';
import { appendRankHistory, loadRankHistory, saveSiteUnderstanding } from '../../infra/json-store.js';
import { computeMeasurementWindow } from '../date.js';
import { GscError } from '../../adapters/gsc.js';
import { generateUnderstandReport } from '../report.js';
import type { UnderstandReportData } from '../report.js';
import { buildPageSnapshot, computeMaturity, selectTopQueries } from '../site-understanding.js';
import type { Experiment, GscAdapter, PageSnapshot, RankHistoryEntry, SiteReaderAdapter, SiteUnderstanding } from '../types.js';

export type UnderstandPaths = {
  siteUnderstanding: string;
  rankHistory: string;
  lock: string;
};

export type UnderstandOptions = {
  baseUrl: string;
  /** GSC Search Console property identifier (e.g. "sc-domain:example.com"), distinct from baseUrl. */
  gscProperty: string;
  today: string;
  dryRun: boolean;
  maxPages?: number;
  excerptMaxChars?: number;
  /** Skill-provided draft themes/proprietaryDataNotes (structured-JSON injection, DESIGN.md 10.2). */
  understandingOverride?: { themes: string[]; proprietaryDataNotes: string[] };
  gscWindowDays: number;
  finalDataLagDays: number;
  gscSource: 'gsc' | 'fixture';
  existingExperiments?: Experiment[];
  gscPagePrefix?: string;
  gscExcludePagePrefix?: string;
};

export type UnderstandResult = {
  siteUnderstanding: SiteUnderstanding;
  report: string;
};

const DEFAULT_MAX_PAGES = 50;

export async function runUnderstand(
  paths: UnderstandPaths,
  siteReader: SiteReaderAdapter,
  gsc: GscAdapter | null,
  options: UnderstandOptions,
): Promise<UnderstandResult> {
  const generatedAt = new Date().toISOString();
  const lock = await acquireLock(paths.lock);
  try {
    const errors: string[] = [];
    const pagesFailed: Array<{ path: string; error: string }> = [];
    const pages: PageSnapshot[] = [];

    const listed = await siteReader.listPages();
    const limited = listed.slice(0, options.maxPages ?? DEFAULT_MAX_PAGES);
    for (const entry of limited) {
      try {
        const read = await siteReader.readPage(entry.path);
        pages.push(
          buildPageSnapshot({
            path: read.path,
            title: read.title,
            headings: read.headings,
            text: read.text,
            fetchedAt: generatedAt,
            excerptMaxChars: options.excerptMaxChars,
          }),
        );
      } catch (err) {
        pagesFailed.push({ path: entry.path, error: (err as Error).message });
      }
    }

    let gscStatus: UnderstandReportData['gsc'] = { status: 'GSC_NOT_CONFIGURED' };
    let gscSummary: SiteUnderstanding['gscSummary'];

    if (gsc) {
      const window = computeMeasurementWindow({
        today: options.today,
        windowDays: options.gscWindowDays,
        finalDataLagDays: options.finalDataLagDays,
      });
      try {
        const matrix = await gsc.fetchQueryPageMatrix({
          property: options.gscProperty,
          startDate: window.start,
          endDate: window.end,
          pagePrefix: options.gscPagePrefix,
          excludePagePrefix: options.gscExcludePagePrefix,
        });
        const entry: RankHistoryEntry = {
          date: options.today,
          source: options.gscSource,
          window,
          rows: matrix.rows,
        };
        const alreadyRecorded = (await loadRankHistory(paths.rankHistory)).entries.some(
          (e) => e.date === entry.date && e.source === entry.source,
        );
        if (!options.dryRun && !alreadyRecorded) {
          await appendRankHistory(paths.rankHistory, entry);
        }
        gscSummary = { window, topQueries: selectTopQueries(matrix.rows) };
        gscStatus = { status: 'ok', window };
      } catch (err) {
        if (err instanceof GscError && err.code === 'GSC_NOT_CONFIGURED') {
          gscStatus = { status: 'GSC_NOT_CONFIGURED', message: err.message };
        } else if (err instanceof GscError) {
          gscStatus = { status: 'GSC_FETCH_FAILED', message: err.message };
          errors.push(`GSC fetch failed (${err.code}): ${err.message}`);
        } else {
          throw err;
        }
      }
    }

    const maturity = computeMaturity({
      pageCount: pages.length,
      hasGscData: gscSummary !== undefined,
      observingOrConcludedCount: (options.existingExperiments ?? []).filter(
        (e) => e.status === 'observing' || e.status === 'concluded',
      ).length,
    });

    const siteUnderstanding: SiteUnderstanding = {
      schemaVersion: 2,
      site: { baseUrl: options.baseUrl },
      generatedAt,
      pages,
      themes: options.understandingOverride?.themes ?? [],
      proprietaryDataNotes: options.understandingOverride?.proprietaryDataNotes ?? [],
      gscSummary,
      maturity,
    };

    if (!options.dryRun) {
      await saveSiteUnderstanding(paths.siteUnderstanding, siteUnderstanding);
    }

    const report = generateUnderstandReport({
      generatedAt,
      dryRun: options.dryRun,
      baseUrl: options.baseUrl,
      pagesRead: pages.length,
      pagesFailed,
      gsc: gscStatus,
      themes: siteUnderstanding.themes,
      proprietaryDataNotes: siteUnderstanding.proprietaryDataNotes,
      errors,
    });

    return { siteUnderstanding, report };
  } finally {
    await lock.release();
  }
}
