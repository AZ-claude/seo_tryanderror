#!/usr/bin/env node
import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RealGscAdapter } from './adapters/gsc.js';
import { CliNaturalWriterAdapter, StubNaturalWriterAdapter } from './adapters/natural-writer.js';
import { FileSearchAdapter, FixtureSearchAdapter, loadSerpFromFile } from './adapters/search.js';
import { FilesystemSiteAdapter, FixtureSiteAdapter } from './adapters/site.js';
import { computeMeasurementWindow, todayString } from './core/date.js';
import { seoConfigSchema, seoPlanSchema } from './core/schemas.js';
import { runSeoLoop, type RunAdapters, type RunPaths } from './core/run.js';
import { getStatus } from './core/status.js';
import type { NaturalWriterAdapter, RankMeasurement, SearchAdapter, SeoConfig, SeoPlan, SiteAdapter } from './core/types.js';
import {
  appendRankHistory,
  loadImprovementLog,
  loadRankHistory,
  loadWatchwords,
  readJsonFile,
} from './infra/json-store.js';

export type Flags = Record<string, string | boolean>;

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

async function loadPlanFromFile(path: string): Promise<SeoPlan> {
  return readJsonFile(path, seoPlanSchema);
}

/**
 * `--fixture` runs must never mutate the checked-in fixtures/ directory
 * (those are git-tracked example data, reused by the test suite). The first
 * fixture run seeds a gitignored working copy under .tmp/fixture-run/ and
 * subsequent runs reuse it, so repeated invocations progress the SEO loop's
 * state (active -> observing -> ...) without dirtying the repo.
 */
async function ensureFixtureRuntimeCopy(rootDir: string): Promise<{ dataDir: string; siteDir: string }> {
  const runtimeRoot = join(rootDir, '.tmp', 'fixture-run');
  const dataDir = join(runtimeRoot, 'data', 'seo');
  const siteDir = join(runtimeRoot, 'site');
  const marker = join(runtimeRoot, '.seeded');

  const alreadySeeded = await stat(marker).then(
    () => true,
    () => false,
  );
  if (!alreadySeeded) {
    await mkdir(dataDir, { recursive: true });
    await mkdir(siteDir, { recursive: true });
    await cp(join(rootDir, 'fixtures/data/seo'), dataDir, { recursive: true });
    await cp(join(rootDir, 'fixtures/site'), siteDir, { recursive: true });
    await writeFile(marker, new Date().toISOString(), 'utf8');
  }
  return { dataDir, siteDir };
}

function runPathsFromDataDir(dataDir: string): RunPaths {
  return {
    watchwords: join(dataDir, 'watchwords.json'),
    rankHistory: join(dataDir, 'rank-history.json'),
    improvementLog: join(dataDir, 'improvement-log.json'),
    lock: join(dataDir, '.run.lock'),
  };
}

function resolveRunPaths(rootDir: string, fixtureMode: boolean): RunPaths {
  return runPathsFromDataDir(join(rootDir, fixtureMode ? 'fixtures/data/seo' : 'data/seo'));
}

async function loadFixtureSerpMap(dir: string): Promise<Record<string, ReturnType<typeof loadSerpFromFile> extends Promise<infer T> ? T : never>> {
  const map: Record<string, Awaited<ReturnType<typeof loadSerpFromFile>>> = {};
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return map;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const serp = await loadSerpFromFile(join(dir, file));
    map[serp.keyword] = serp;
  }
  return map;
}

async function buildAdapters(
  config: SeoConfig,
  opts: {
    fixtureMode: boolean;
    serpFilePath?: string;
    fixtureSerpDir: string;
    fixtureSiteRoot: string;
  },
): Promise<RunAdapters> {
  const gsc = new RealGscAdapter(config.gsc.credentialsEnv);

  const writer: NaturalWriterAdapter =
    opts.fixtureMode || config.adapters.writer === 'stub'
      ? new StubNaturalWriterAdapter()
      : new CliNaturalWriterAdapter(process.env.SEO_WRITER_COMMAND ?? 'writer-command', join(process.cwd(), '.tmp'));

  const site: SiteAdapter =
    opts.fixtureMode || config.adapters.site === 'fixture'
      ? new FixtureSiteAdapter(opts.fixtureSiteRoot)
      : new FilesystemSiteAdapter({
          repoRoot: config.site.repoRoot,
          contentRoot: config.site.contentRoot,
          buildCommand: config.commands.build,
          testCommand: config.commands.test,
        });

  let search: SearchAdapter;
  if (opts.serpFilePath) {
    search = new FileSearchAdapter(opts.serpFilePath);
  } else if (opts.fixtureMode || config.adapters.search === 'fixture') {
    search = new FixtureSearchAdapter(await loadFixtureSerpMap(opts.fixtureSerpDir));
  } else {
    throw new Error('adapters.search="file" requires --serp-file <path>');
  }

  return { gsc, search, writer, site };
}

function reportFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.md`;
}

export async function cmdRun(flags: Flags): Promise<number> {
  const fixtureMode = Boolean(flags.fixture);
  const configPath = flagString(flags, 'config') ?? (fixtureMode ? 'config/seo.config.example.json' : 'config/seo.config.json');
  const config = await loadConfig(configPath);
  const today = flagString(flags, 'date') ?? todayString();
  const dryRun = Boolean(flags['dry-run']);

  const runtime = fixtureMode ? await ensureFixtureRuntimeCopy(process.cwd()) : null;
  const paths = runtime ? runPathsFromDataDir(runtime.dataDir) : resolveRunPaths(process.cwd(), false);

  const planFile = flagString(flags, 'plan-file');
  let planOverride = planFile ? await loadPlanFromFile(planFile) : undefined;
  if (!planOverride && fixtureMode) {
    // Keeps the bare `run --fixture` quick start (README) working end to end
    // without extra flags, for the one keyword the checked-in fixtures cover.
    planOverride = await loadPlanFromFile(join(process.cwd(), 'fixtures/plan/example-keyword.json')).catch(
      () => undefined,
    );
  }
  const serpFilePath = flagString(flags, 'serp-file');

  const adapters = await buildAdapters(config, {
    fixtureMode,
    serpFilePath,
    fixtureSerpDir: join(process.cwd(), 'fixtures/search'),
    fixtureSiteRoot: runtime ? runtime.siteDir : join(process.cwd(), config.site.contentRoot),
  });

  const result = await runSeoLoop(config, paths, adapters, {
    today,
    dryRun,
    fetchMeasurement: !fixtureMode,
    planOverride,
  });

  console.log(result.report);

  if (!dryRun) {
    const dir = join(process.cwd(), 'reports');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, reportFileName()), result.report, 'utf8');
  }

  return result.exitCode;
}

export async function cmdStatus(flags: Flags): Promise<number> {
  const fixtureMode = Boolean(flags.fixture);
  const configPath = flagString(flags, 'config') ?? (fixtureMode ? 'config/seo.config.example.json' : 'config/seo.config.json');
  await loadConfig(configPath); // validated for consistency, not otherwise needed here
  const today = flagString(flags, 'date') ?? todayString();
  const runtime = fixtureMode ? await ensureFixtureRuntimeCopy(process.cwd()) : null;
  const paths = runtime ? runPathsFromDataDir(runtime.dataDir) : resolveRunPaths(process.cwd(), false);

  const watchwords = await loadWatchwords(paths.watchwords);
  const rankHistory = await loadRankHistory(paths.rankHistory);
  const improvementLog = await loadImprovementLog(paths.improvementLog);

  const status = getStatus({ watchwords: watchwords.keywords, improvementLog, rankHistory, today });
  console.log(JSON.stringify(status, null, 2));
  return 0;
}

export async function cmdFetchRanks(flags: Flags): Promise<number> {
  const configPath = flagString(flags, 'config') ?? 'config/seo.config.json';
  const config = await loadConfig(configPath);
  const today = flagString(flags, 'date') ?? todayString();
  const daysFlag = flagString(flags, 'days');
  const days = daysFlag ? Number(daysFlag) : config.gsc.defaultWindowDays;
  const paths = resolveRunPaths(process.cwd(), false);
  const watchwords = await loadWatchwords(paths.watchwords);

  const gsc = new RealGscAdapter(config.gsc.credentialsEnv);
  const window = computeMeasurementWindow({ today, windowDays: days, finalDataLagDays: config.gsc.finalDataLagDays });

  let fetched: Awaited<ReturnType<typeof gsc.fetchRankWindow>>;
  try {
    fetched = await gsc.fetchRankWindow({
      property: config.gsc.property,
      startDate: window.start,
      endDate: window.end,
      watchwords: watchwords.keywords,
    });
  } catch (err) {
    console.error((err as Error).message);
    const code = (err as { code?: unknown }).code;
    return code === 'GSC_NOT_CONFIGURED' ? 2 : 1;
  }

  if (fetched.measurements.length === 0) {
    console.error('attempted fetch but no measurable registered watchwords were found in this window');
    return 1;
  }

  const entry = { date: today, source: 'gsc' as const, window, measurements: fetched.measurements };
  if (flags.append) {
    await appendRankHistory(paths.rankHistory, entry);
  }
  console.log(JSON.stringify({ entry, unregisteredQueries: fetched.unregisteredQueries }, null, 2));
  return 0;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function cmdRecordRanks(flags: Flags): Promise<number> {
  const fixtureMode = Boolean(flags.fixture);
  const source = flagString(flags, 'source') ?? 'manual';
  if (source !== 'websearch' && source !== 'manual') {
    console.error('--source must be "websearch" or "manual"');
    return 1;
  }
  const today = flagString(flags, 'date') ?? todayString();
  const runtime = fixtureMode ? await ensureFixtureRuntimeCopy(process.cwd()) : null;
  const paths = runtime ? runPathsFromDataDir(runtime.dataDir) : resolveRunPaths(process.cwd(), false);
  const watchwords = await loadWatchwords(paths.watchwords);
  const registered = new Set(watchwords.keywords.map((k) => k.keyword));

  const raw = await readStdin();
  const parsed = JSON.parse(raw) as RankMeasurement[];
  const unregistered = parsed.filter((m) => !registered.has(m.keyword));
  if (unregistered.length > 0) {
    console.error(`rejected: unregistered watchwords: ${unregistered.map((m) => m.keyword).join(', ')}`);
    return 1;
  }

  const entry = { date: today, source: source as 'websearch' | 'manual', measurements: parsed };
  await appendRankHistory(paths.rankHistory, entry);
  console.log(JSON.stringify(entry, null, 2));
  return 0;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  let exitCode: number;
  switch (command) {
    case 'run':
      exitCode = await cmdRun(flags);
      break;
    case 'status':
      exitCode = await cmdStatus(flags);
      break;
    case 'fetch-ranks':
      exitCode = await cmdFetchRanks(flags);
      break;
    case 'record-ranks':
      exitCode = await cmdRecordRanks(flags);
      break;
    default:
      console.error(`unknown command: "${command}"\nusage: seo <run|status|fetch-ranks|record-ranks> [options]`);
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
