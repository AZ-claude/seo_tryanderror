import { acquireLock } from '../infra/fs-lock.js';
import {
  loadImprovementLog,
  loadRankHistory,
  loadWatchwords,
  saveImprovementLog,
  appendRankHistory,
} from '../infra/json-store.js';
import { addDays, computeMeasurementWindow } from './date.js';
import { generateReport } from './report.js';
import type { ObservingItem, RankMovement, ReportData, ReviewedItem } from './report.js';
import { getLatestMeasurementWithSource } from './rank-lookup.js';
import { applyReview } from './review.js';
import { selectKeyword, suggestUnregisteredQueries } from './select-keyword.js';
import { getStatus } from './status.js';
import type {
  GscAdapter,
  ImprovementAction,
  ImprovementKeywordState,
  ImprovementLog,
  NaturalWriterAdapter,
  RankHistory,
  RankHistoryEntry,
  RankSource,
  SearchAdapter,
  SeoConfig,
  SeoPlan,
  SerpInspection,
  SiteAdapter,
  UnregisteredQuery,
} from './types.js';

const SIGNIFICANT_RANK_DELTA = 3;

export type RunPaths = {
  watchwords: string;
  rankHistory: string;
  improvementLog: string;
  lock: string;
};

export type RunAdapters = {
  gsc: GscAdapter | null;
  search: SearchAdapter;
  writer: NaturalWriterAdapter;
  site: SiteAdapter;
};

export type RunOptions = {
  today: string;
  dryRun: boolean;
  /** Whether to attempt a GSC measurement this run. */
  fetchMeasurement: boolean;
  /** Injected SERP inspection, e.g. from --serp-file. Skips adapters.search when set. */
  serpOverride?: SerpInspection;
  /** Injected plan, e.g. from --plan-file. Required to attempt a new improvement. */
  planOverride?: SeoPlan;
};

export type RunResult = {
  exitCode: 0 | 1;
  report: string;
  reportData: ReportData;
};

function isGscErrorCode(code: unknown): code is 'GSC_NOT_CONFIGURED' | 'GSC_AUTH_FAILED' | 'GSC_FETCH_FAILED' {
  return code === 'GSC_NOT_CONFIGURED' || code === 'GSC_AUTH_FAILED' || code === 'GSC_FETCH_FAILED';
}

function upsertKeywordState(log: ImprovementLog, state: ImprovementKeywordState): ImprovementLog {
  const exists = log.keywords.some((k) => k.keyword === state.keyword);
  return {
    schemaVersion: 1,
    keywords: exists
      ? log.keywords.map((k) => (k.keyword === state.keyword ? state : k))
      : [...log.keywords, state],
  };
}

/**
 * Runs one full SEO loop iteration per DESIGN.md section 16:
 *   load -> lock -> measure -> review due -> select -> (plan/apply/validate) -> persist -> report
 *
 * State (improvement-log.json) is only ever written at a clean stopping
 * point (no candidate, no plan supplied, or full success) or discarded
 * entirely on validation failure — it is never partially written.
 */
export async function runSeoLoop(
  config: SeoConfig,
  paths: RunPaths,
  adapters: RunAdapters,
  options: RunOptions,
): Promise<RunResult> {
  const errors: string[] = [];
  const generatedAt = new Date().toISOString();
  const lock = await acquireLock(paths.lock);

  try {
    const watchwords = await loadWatchwords(paths.watchwords);
    let rankHistory: RankHistory = await loadRankHistory(paths.rankHistory);
    let improvementLog: ImprovementLog = await loadImprovementLog(paths.improvementLog);

    const previousLatestRank = new Map(
      watchwords.keywords.map((k) => [k.keyword, getLatestMeasurementWithSource(k.keyword, rankHistory)?.measurement.rank ?? null]),
    );

    // --- 1. measure ---
    let measurementInfo: ReportData['measurement'] = null;
    let unregisteredQueries: UnregisteredQuery[] = [];

    if (options.fetchMeasurement) {
      const alreadyMeasuredToday = rankHistory.entries.find(
        (e) => e.date === options.today && e.source === 'gsc',
      );
      if (alreadyMeasuredToday) {
        measurementInfo = { source: alreadyMeasuredToday.source, window: alreadyMeasuredToday.window };
      } else if (!adapters.gsc) {
        errors.push('GSC adapter not configured: skipped measurement fetch, using existing rank-history');
      } else {
        const window = computeMeasurementWindow({
          today: options.today,
          windowDays: config.gsc.defaultWindowDays,
          finalDataLagDays: config.gsc.finalDataLagDays,
        });
        try {
          const fetched = await adapters.gsc.fetchRankWindow({
            property: config.gsc.property,
            startDate: window.start,
            endDate: window.end,
            watchwords: watchwords.keywords,
          });
          unregisteredQueries = fetched.unregisteredQueries;
          const entry: RankHistoryEntry = {
            date: options.today,
            source: 'gsc',
            window,
            measurements: fetched.measurements,
          };
          rankHistory = options.dryRun
            ? { schemaVersion: 1, entries: [...rankHistory.entries, entry] }
            : await appendRankHistory(paths.rankHistory, entry);
          measurementInfo = { source: 'gsc', window };
        } catch (err) {
          const code = (err as { code?: unknown }).code;
          if (isGscErrorCode(code)) {
            errors.push(`GSC fetch failed (${code}): ${(err as Error).message}`);
          } else {
            throw err;
          }
        }
      }
    }

    // --- 2. review due experiments ---
    const statusBeforeReview = getStatus({
      watchwords: watchwords.keywords,
      improvementLog,
      rankHistory,
      today: options.today,
    });

    const reviewed: ReviewedItem[] = [];
    for (const kw of statusBeforeReview.dueForReview) {
      const state = improvementLog.keywords.find((k) => k.keyword === kw.keyword);
      if (!state) continue;
      const currentRank = getLatestMeasurementWithSource(kw.keyword, rankHistory)?.measurement.rank ?? null;
      const updated = applyReview({
        state,
        today: options.today,
        currentRank,
        notes: '',
        retryReviewDate: addDays(options.today, config.gsc.reviewWindowDays),
      });
      improvementLog = upsertKeywordState(improvementLog, updated);
      const review = updated.actions[updated.actions.length - 1]!.review!;
      reviewed.push({
        keyword: kw.keyword,
        outcome: review.outcome,
        previousRank: review.previousRank,
        currentRank: review.currentRank,
      });
    }

    // --- 3. select (at most one keyword, from buckets 1-4 only) ---
    const statusAfterReview = getStatus({
      watchwords: watchwords.keywords,
      improvementLog,
      rankHistory,
      today: options.today,
    });

    const observing: ObservingItem[] = statusAfterReview.observing.map((kw) => ({
      keyword: kw.keyword,
      nextReviewDate: improvementLog.keywords.find((k) => k.keyword === kw.keyword)?.nextReviewDate ?? null,
    }));

    const significantMovements: RankMovement[] = [];
    if (measurementInfo) {
      for (const kw of watchwords.keywords) {
        const prev = previousLatestRank.get(kw.keyword) ?? null;
        const curr = getLatestMeasurementWithSource(kw.keyword, rankHistory)?.measurement.rank ?? null;
        if (prev === null || curr === null) continue;
        if (Math.abs(prev - curr) >= SIGNIFICANT_RANK_DELTA) {
          significantMovements.push({ keyword: kw.keyword, previousRank: prev, currentRank: curr });
        }
      }
    }

    const selected = selectKeyword({
      activeCandidates: statusAfterReview.active,
      rankHistory,
      improvementLog,
    });

    const unregisteredQuerySuggestions = suggestUnregisteredQueries(unregisteredQueries);

    if (!selected) {
      if (!options.dryRun) await saveImprovementLog(paths.improvementLog, improvementLog);
      const reportData: ReportData = {
        generatedAt,
        dryRun: options.dryRun,
        measurement: measurementInfo,
        significantMovements,
        reviewed,
        observing,
        selection: null,
        validation: null,
        unregisteredQuerySuggestions,
        errors,
      };
      return { exitCode: 0, report: generateReport(reportData), reportData };
    }

    const plan = options.planOverride;
    if (!plan) {
      errors.push(
        `selected keyword "${selected.keyword}" but no plan was supplied (--plan-file required to proceed)`,
      );
      if (!options.dryRun) await saveImprovementLog(paths.improvementLog, improvementLog);
      const reportData: ReportData = {
        generatedAt,
        dryRun: options.dryRun,
        measurement: measurementInfo,
        significantMovements,
        reviewed,
        observing,
        selection: null,
        validation: null,
        unregisteredQuerySuggestions,
        errors,
      };
      return { exitCode: 1, report: generateReport(reportData), reportData };
    }

    const latest = getLatestMeasurementWithSource(selected.keyword, rankHistory);
    const reason = latest
      ? `latest rank ${latest.measurement.rank ?? 'null'}, impressions ${latest.measurement.impressions}`
      : 'no measurement yet (high priority, rank unknown)';

    // --- 4. dry run stops here: plan is computed but nothing is applied/persisted ---
    if (options.dryRun) {
      const reportData: ReportData = {
        generatedAt,
        dryRun: true,
        measurement: measurementInfo,
        significantMovements,
        reviewed,
        observing,
        selection: { keyword: selected, reason, plan, changeSummary: '(dry run - not applied)' },
        validation: null,
        unregisteredQuerySuggestions,
        errors,
      };
      return { exitCode: 0, report: generateReport(reportData), reportData };
    }

    // --- 5. apply + validate ---
    const targetPage = await adapters.site.readPage(selected.targetPath);
    const serp = options.serpOverride ?? (await adapters.search.inspectSerp({
      keyword: selected.keyword,
      targetUrl: `${config.site.baseUrl}${selected.targetPath}`,
      topN: 3,
    }));
    void serp; // SERP is consumed by the planner upstream of this call; kept for report/traceability hooks.

    const writerResult = await adapters.writer.transform({
      mode: targetPage.content.trim().length > 0 ? 'revise' : 'create',
      targetLanguage: 'ja',
      contentType: 'article',
      existingText: targetPage.content,
      searchNeed: plan.searchNeed,
      requiredFacts: plan.requiredFacts,
      requiredChanges: [plan.requestedChange],
      forbiddenChanges: plan.forbiddenChanges,
      targetKeyword: selected.keyword,
    });

    const applyResult = await adapters.site.apply({
      targetPath: selected.targetPath,
      newText: writerResult.text,
      plan,
    });
    const validation = await adapters.site.validate();

    if (!validation.ok) {
      try {
        await adapters.site.apply({ targetPath: selected.targetPath, newText: targetPage.content, plan });
      } catch (rollbackErr) {
        errors.push(`rollback failed: ${(rollbackErr as Error).message}`);
      }
      const reportData: ReportData = {
        generatedAt,
        dryRun: false,
        measurement: measurementInfo,
        significantMovements,
        reviewed,
        observing,
        selection: {
          keyword: selected,
          reason,
          plan,
          changeSummary: `${applyResult.summary} (rolled back: validation failed)`,
        },
        validation,
        unregisteredQuerySuggestions,
        errors,
      };
      // Improvement log is intentionally NOT persisted: a failed run must not
      // advance any state, including this run's review outcomes.
      return { exitCode: 1, report: generateReport(reportData), reportData };
    }

    // --- 6. success: append action, set observing, persist atomically ---
    const rankSource: RankSource = latest?.source ?? measurementInfo?.source ?? 'fixture';
    const newAction: ImprovementAction = {
      date: options.today,
      rankAtAction: latest?.measurement.rank ?? null,
      rankSource,
      searchNeed: plan.searchNeed,
      gap: plan.gaps,
      done: applyResult.summary,
      changeType: plan.changeType,
      sources: plan.sources,
      baseline: latest
        ? { impressions: latest.measurement.impressions, clicks: latest.measurement.clicks }
        : undefined,
    };

    const existingState = improvementLog.keywords.find((k) => k.keyword === selected.keyword);
    const nextState: ImprovementKeywordState = {
      keyword: selected.keyword,
      targetPath: selected.targetPath,
      status: 'observing',
      nextReviewDate: addDays(options.today, config.experiment.cooldownDays),
      actions: [...(existingState?.actions ?? []), newAction],
    };
    improvementLog = upsertKeywordState(improvementLog, nextState);
    await saveImprovementLog(paths.improvementLog, improvementLog);

    const reportData: ReportData = {
      generatedAt,
      dryRun: false,
      measurement: measurementInfo,
      significantMovements,
      reviewed,
      observing,
      selection: { keyword: selected, reason, plan, changeSummary: applyResult.summary },
      validation,
      unregisteredQuerySuggestions,
      errors,
    };
    return { exitCode: 0, report: generateReport(reportData), reportData };
  } finally {
    await lock.release();
  }
}
