#!/usr/bin/env node
import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RealGscAdapter } from './adapters/gsc.js';
import { loadSerpFromFile } from './adapters/search.js';
import { FixtureSiteReaderAdapter, HttpSiteReaderAdapter, FilesystemSiteReaderAdapter } from './adapters/site-reader.js';
import type { FixturePage } from './adapters/site-reader.js';
import { todayString } from './core/date.js';
import {
  applyEvidenceSchema,
  discoverInputFileSchema,
  gscSummaryRowSchema,
  proposeInputSchema,
  reviewDecisionInputSchema,
  seoConfigSchema,
} from './core/schemas.js';
import { prioritizeOpportunities } from './core/prioritize.js';
import { generatePrioritizeReport, generateStatusReport } from './core/report.js';
import { getStatusView } from './core/status.js';
import { runApply } from './core/workflow/apply.js';
import { dumpDiscoverInputs, runDiscover } from './core/workflow/discover.js';
import { runPropose } from './core/workflow/propose.js';
import { runReject } from './core/workflow/reject.js';
import { runRejectOpportunity } from './core/workflow/reject-opportunity.js';
import { dumpReviewInputs, runReviewDecision } from './core/workflow/review.js';
import { runUnderstand } from './core/workflow/understand.js';
import type { GscAdapter, GscSummaryRow, SeoConfig, SiteReaderAdapter } from './core/types.js';
import { loadExperiments, loadOpportunities, readJsonFile } from './infra/json-store.js';
import { z } from 'zod';

export type Flags = Record<string, string | boolean>;

const DEFAULT_MAX_ACTIVE_EXPERIMENTS = 3;

export function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const [command, ...rest] = argv;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg || !arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command: command ?? '', flags };
}

function flagString(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

async function loadConfig(path: string): Promise<SeoConfig> {
  return readJsonFile(path, seoConfigSchema);
}

type DataPaths = {
  siteUnderstanding: string;
  opportunities: string;
  experiments: string;
  rankHistory: string;
  lock: string;
};

function dataPathsFromDir(dataDir: string): DataPaths {
  return {
    siteUnderstanding: join(dataDir, 'site-understanding.json'),
    opportunities: join(dataDir, 'opportunities.json'),
    experiments: join(dataDir, 'experiments.json'),
    rankHistory: join(dataDir, 'rank-history.json'),
    lock: join(dataDir, '.run.lock'),
  };
}

/**
 * Loads config from `--config` when given. Commands that historically never
 * looked at config (discover/prioritize/apply/status) treat it as optional
 * so a bare invocation (no --config) keeps resolving the legacy data/seo/
 * state dir untouched — multi-site opt-in only kicks in once a config with
 * site.key is passed.
 */
async function loadConfigIfProvided(flags: Flags): Promise<SeoConfig | null> {
  const configPath = flagString(flags, 'config');
  return configPath ? loadConfig(configPath) : null;
}

/**
 * `--fixture` runs must never mutate the checked-in fixtures/ directory. The
 * first fixture run seeds a gitignored working copy under .tmp/fixture-run/;
 * subsequent runs reuse it, so `understand -> discover -> prioritize ->
 * propose` can progress state across invocations without dirtying the repo.
 */
async function ensureFixtureRuntimeCopy(rootDir: string): Promise<{ dataDir: string }> {
  const runtimeRoot = join(rootDir, '.tmp', 'fixture-run');
  const dataDir = join(runtimeRoot, 'data', 'seo');
  const marker = join(runtimeRoot, '.seeded');

  const alreadySeeded = await stat(marker).then(
    () => true,
    () => false,
  );
  if (!alreadySeeded) {
    await mkdir(dataDir, { recursive: true });
    await cp(join(rootDir, 'fixtures/data/seo'), dataDir, { recursive: true });
    await writeFile(marker, new Date().toISOString(), 'utf8');
  }
  return { dataDir };
}

function resolveDataPaths(rootDir: string, fixtureMode: boolean, siteKey?: string): DataPaths {
  const base = fixtureMode ? 'fixtures/data/seo' : 'data/seo';
  return dataPathsFromDir(join(rootDir, base, ...(fixtureMode || !siteKey ? [] : [siteKey])));
}

const fixturePageSchema = z.object({
  path: z.string().min(1),
  title: z.string().optional(),
  headings: z.array(z.string()),
  text: z.string(),
  html: z.string().optional(),
});

async function loadFixturePages(rootDir: string): Promise<FixturePage[]> {
  const pages = await readJsonFile(join(rootDir, 'fixtures/site-v2/pages.json'), z.array(fixturePageSchema));
  return pages as FixturePage[];
}

class FixtureGscAdapter implements GscAdapter {
  constructor(private readonly rows: GscSummaryRow[]) {}
  async fetchQueryPageMatrix(): ReturnType<GscAdapter['fetchQueryPageMatrix']> {
    return { rows: this.rows };
  }
}

async function loadFixtureGscAdapter(rootDir: string): Promise<GscAdapter> {
  const rows = await readJsonFile(join(rootDir, 'fixtures/gsc/query-page-matrix.json'), z.array(gscSummaryRowSchema));
  return new FixtureGscAdapter(rows as GscSummaryRow[]);
}

export function buildSiteReader(config: SeoConfig, opts: { fixtureMode: boolean; fixturePages: FixturePage[] }): SiteReaderAdapter {
  if (opts.fixtureMode || config.adapters.site === 'fixture') {
    return new FixtureSiteReaderAdapter(opts.fixturePages);
  }
  if (config.adapters.site === 'filesystem-readonly') {
    if (!config.site.contentRoot) throw new Error('site.contentRoot is required for adapters.site="filesystem-readonly"');
    return new FilesystemSiteReaderAdapter(config.site.contentRoot);
  }
  return new HttpSiteReaderAdapter({ baseUrl: config.site.baseUrl, maxPages: config.site.maxPages });
}

function reportFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.md`;
}

async function writeReport(report: string, dryRun: boolean, siteKey?: string): Promise<void> {
  console.log(report);
  if (!dryRun) {
    const dir = siteKey ? join(process.cwd(), 'reports', siteKey) : join(process.cwd(), 'reports');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, reportFileName()), report, 'utf8');
  }
}

export async function cmdUnderstand(flags: Flags): Promise<number> {
  const fixtureMode = Boolean(flags.fixture);
  const configPath = flagString(flags, 'config') ?? (fixtureMode ? 'config/seo.config.example.json' : 'config/seo.config.json');
  const config = await loadConfig(configPath);
  const today = flagString(flags, 'date') ?? todayString();
  const dryRun = Boolean(flags['dry-run']);

  const runtime = fixtureMode ? await ensureFixtureRuntimeCopy(process.cwd()) : null;
  const paths = runtime ? dataPathsFromDir(runtime.dataDir) : resolveDataPaths(process.cwd(), false, config.site.key);

  const fixturePages = fixtureMode ? await loadFixturePages(process.cwd()) : [];
  const siteReader = buildSiteReader(config, { fixtureMode, fixturePages });
  const gsc = fixtureMode ? await loadFixtureGscAdapter(process.cwd()) : new RealGscAdapter(config.gsc.credentialsEnv);

  const understandingFile = flagString(flags, 'understanding-file');
  const understandingOverride = understandingFile
    ? ((await readJsonFile(
        understandingFile,
        z.object({ themes: z.array(z.string()), proprietaryDataNotes: z.array(z.string()) }),
      )) as { themes: string[]; proprietaryDataNotes: string[] })
    : undefined;

  const existingExperiments = await loadExperiments(paths.experiments).catch(() => []);

  const result = await runUnderstand(paths, siteReader, gsc, {
    baseUrl: config.site.baseUrl,
    gscProperty: config.gsc.property,
    today,
    dryRun,
    maxPages: config.site.maxPages,
    understandingOverride,
    gscWindowDays: config.gsc.defaultWindowDays,
    finalDataLagDays: config.gsc.finalDataLagDays,
    gscSource: fixtureMode ? 'fixture' : 'gsc',
    existingExperiments,
    gscPagePrefix: config.gsc.pagePrefix,
    gscExcludePagePrefix: config.gsc.excludePagePrefix,
  });

  await writeReport(result.report, dryRun, config.site.key);
  return 0;
}

export async function cmdDiscover(flags: Flags): Promise<number> {
  const fixtureMode = Boolean(flags.fixture);
  const dryRun = Boolean(flags['dry-run']);
  const config = fixtureMode ? null : await loadConfigIfProvided(flags);
  const runtime = fixtureMode ? await ensureFixtureRuntimeCopy(process.cwd()) : null;
  const paths = runtime ? dataPathsFromDir(runtime.dataDir) : resolveDataPaths(process.cwd(), false, config?.site.key);

  if (flags['dump-inputs']) {
    const dumped = await dumpDiscoverInputs(paths);
    console.log(JSON.stringify(dumped, null, 2));
    return 0;
  }

  const opportunitiesFile = flagString(flags, 'opportunities-file');
  if (!opportunitiesFile) {
    console.error('discover requires --opportunities-file <path> (or --dump-inputs)');
    return 1;
  }
  const input = await readJsonFile(opportunitiesFile, discoverInputFileSchema);
  const now = new Date().toISOString();

  const result = await runDiscover(paths, input.opportunities, now, dryRun);
  await writeReport(result.report, dryRun, config?.site.key);
  return 0;
}

export async function cmdPrioritize(flags: Flags): Promise<number> {
  const fixtureMode = Boolean(flags.fixture);
  const config = fixtureMode ? null : await loadConfigIfProvided(flags);
  const runtime = fixtureMode ? await ensureFixtureRuntimeCopy(process.cwd()) : null;
  const paths = runtime ? dataPathsFromDir(runtime.dataDir) : resolveDataPaths(process.cwd(), false, config?.site.key);

  const opportunities = await loadOpportunities(paths.opportunities);
  const experiments = await loadExperiments(paths.experiments);
  const result = prioritizeOpportunities({ opportunities, experiments });

  const report = generatePrioritizeReport({ generatedAt: new Date().toISOString(), ranked: result.ranked, excluded: result.excluded });
  console.log(report);
  return 0;
}

export async function cmdPropose(flags: Flags): Promise<number> {
  const fixtureMode = Boolean(flags.fixture);
  const dryRun = Boolean(flags['dry-run']);
  const configPath = flagString(flags, 'config') ?? (fixtureMode ? 'config/seo.config.example.json' : 'config/seo.config.json');
  const config = await loadConfig(configPath);
  const today = flagString(flags, 'date') ?? todayString();

  const runtime = fixtureMode ? await ensureFixtureRuntimeCopy(process.cwd()) : null;
  const paths = runtime ? dataPathsFromDir(runtime.dataDir) : resolveDataPaths(process.cwd(), false, config.site.key);

  const opportunityId = flagString(flags, 'opportunity-id');
  const hypothesisFile = flagString(flags, 'hypothesis-file');
  if (!opportunityId || !hypothesisFile) {
    console.error('propose requires --opportunity-id <id> --hypothesis-file <path>');
    return 1;
  }
  const input = await readJsonFile(hypothesisFile, proposeInputSchema);

  const serpFilePath = flagString(flags, 'serp-file');
  const serp = serpFilePath ? await loadSerpFromFile(serpFilePath) : undefined;

  const result = await runPropose(paths, {
    opportunityId,
    input,
    today,
    now: new Date().toISOString(),
    finalDataLagDays: config.gsc.finalDataLagDays,
    metricsSource: fixtureMode ? 'fixture' : 'gsc',
    maxActiveExperiments: config.experiment.maxActiveExperiments ?? DEFAULT_MAX_ACTIVE_EXPERIMENTS,
    serp,
    dryRun,
  });

  await writeReport(result.report, dryRun || result.exitCode !== 0, config.site.key);
  return result.exitCode;
}

export async function cmdApply(flags: Flags): Promise<number> {
  const dryRun = Boolean(flags['dry-run']);
  const today = flagString(flags, 'date') ?? todayString();
  const config = await loadConfigIfProvided(flags);
  const paths = resolveDataPaths(process.cwd(), false, config?.site.key);

  const experimentId = flagString(flags, 'experiment-id');
  const evidenceFile = flagString(flags, 'evidence-file');
  if (!experimentId || !evidenceFile) {
    console.error('apply requires --experiment-id <id> --evidence-file <path>');
    return 1;
  }
  const evidence = await readJsonFile(evidenceFile, applyEvidenceSchema);

  const result = await runApply(paths, {
    experimentId,
    evidence,
    today,
    now: new Date().toISOString(),
    dryRun,
  });

  await writeReport(result.report, dryRun || result.exitCode !== 0, config?.site.key);
  return result.exitCode;
}

export async function cmdReject(flags: Flags): Promise<number> {
  const dryRun = Boolean(flags['dry-run']);
  const config = await loadConfigIfProvided(flags);
  const paths = resolveDataPaths(process.cwd(), false, config?.site.key);

  const experimentId = flagString(flags, 'experiment-id');
  const reason = flagString(flags, 'reason');
  if (!experimentId || !reason) {
    console.error('reject requires --experiment-id <id> --reason <text>');
    return 1;
  }

  const result = await runReject(paths, {
    experimentId,
    reason,
    now: new Date().toISOString(),
    dryRun,
  });

  await writeReport(result.report, dryRun || result.exitCode !== 0, config?.site.key);
  return result.exitCode;
}

export async function cmdRejectOpportunity(flags: Flags): Promise<number> {
  const dryRun = Boolean(flags['dry-run']);
  const config = await loadConfigIfProvided(flags);
  const paths = resolveDataPaths(process.cwd(), false, config?.site.key);

  const opportunityId = flagString(flags, 'opportunity-id');
  const reason = flagString(flags, 'reason');
  if (!opportunityId || !reason) {
    console.error('reject-opportunity requires --opportunity-id <id> --reason <text>');
    return 1;
  }

  const result = await runRejectOpportunity(paths, {
    opportunityId,
    reason,
    now: new Date().toISOString(),
    dryRun,
  });

  await writeReport(result.report, dryRun || result.exitCode !== 0, config?.site.key);
  return result.exitCode;
}

export async function cmdReview(flags: Flags): Promise<number> {
  const fixtureMode = Boolean(flags.fixture);
  const dryRun = Boolean(flags['dry-run']);
  const configPath = flagString(flags, 'config') ?? (fixtureMode ? 'config/seo.config.example.json' : 'config/seo.config.json');
  const config = await loadConfig(configPath);
  const today = flagString(flags, 'date') ?? todayString();
  const now = new Date().toISOString();

  const runtime = fixtureMode ? await ensureFixtureRuntimeCopy(process.cwd()) : null;
  const paths = runtime ? dataPathsFromDir(runtime.dataDir) : resolveDataPaths(process.cwd(), false, config.site.key);

  const experimentId = flagString(flags, 'experiment-id');
  if (!experimentId) {
    console.error('review requires --experiment-id <id> (with --dump-inputs, or --review-file <path>)');
    return 1;
  }
  const gsc: GscAdapter = fixtureMode
    ? await loadFixtureGscAdapter(process.cwd())
    : new RealGscAdapter(config.gsc.credentialsEnv);

  if (flags['dump-inputs']) {
    const experiments = await loadExperiments(paths.experiments);
    const dumped = await dumpReviewInputs(experiments, gsc, {
      experimentId,
      property: config.gsc.property,
      today,
      finalDataLagDays: config.gsc.finalDataLagDays,
      now,
      gscPagePrefix: config.gsc.pagePrefix,
      gscExcludePagePrefix: config.gsc.excludePagePrefix,
    });
    console.log(JSON.stringify(dumped, null, 2));
    return 'error' in dumped ? 1 : 0;
  }

  const reviewFile = flagString(flags, 'review-file');
  if (!reviewFile) {
    console.error('review requires --dump-inputs or --review-file <path>');
    return 1;
  }
  const decisionInput = await readJsonFile(reviewFile, reviewDecisionInputSchema);

  const result = await runReviewDecision(paths, gsc, {
    experimentId,
    property: config.gsc.property,
    today,
    finalDataLagDays: config.gsc.finalDataLagDays,
    now,
    decisionInput,
    dryRun,
    gscPagePrefix: config.gsc.pagePrefix,
    gscExcludePagePrefix: config.gsc.excludePagePrefix,
  });

  await writeReport(result.report, dryRun || result.exitCode !== 0, config.site.key);
  return result.exitCode;
}

export async function cmdStatus(flags: Flags): Promise<number> {
  const fixtureMode = Boolean(flags.fixture);
  const today = flagString(flags, 'date') ?? todayString();
  const config = fixtureMode ? null : await loadConfigIfProvided(flags);
  const runtime = fixtureMode ? await ensureFixtureRuntimeCopy(process.cwd()) : null;
  const paths = runtime ? dataPathsFromDir(runtime.dataDir) : resolveDataPaths(process.cwd(), false, config?.site.key);

  const opportunities = await loadOpportunities(paths.opportunities);
  const experiments = await loadExperiments(paths.experiments);
  const status = getStatusView({ opportunities, experiments, today });
  console.log(generateStatusReport(new Date().toISOString(), status));
  return 0;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  let exitCode: number;
  switch (command) {
    case 'understand':
      exitCode = await cmdUnderstand(flags);
      break;
    case 'discover':
      exitCode = await cmdDiscover(flags);
      break;
    case 'prioritize':
      exitCode = await cmdPrioritize(flags);
      break;
    case 'propose':
      exitCode = await cmdPropose(flags);
      break;
    case 'apply':
      exitCode = await cmdApply(flags);
      break;
    case 'reject':
      exitCode = await cmdReject(flags);
      break;
    case 'reject-opportunity':
      exitCode = await cmdRejectOpportunity(flags);
      break;
    case 'review':
      exitCode = await cmdReview(flags);
      break;
    case 'status':
      exitCode = await cmdStatus(flags);
      break;
    default:
      console.error(`unknown command: "${command}"\nusage: seo <understand|discover|prioritize|propose|apply|reject|reject-opportunity|review|status> [options]`);
      exitCode = 1;
  }
  process.exitCode = exitCode;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  });
}
