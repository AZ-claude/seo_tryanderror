import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunPaths } from '../src/core/run.js';
import type { SeoConfig, SeoPlan, SerpInspection } from '../src/core/types.js';

const REPO_ROOT = process.cwd();

export type FixtureWorkdir = {
  dir: string;
  siteDir: string;
  paths: RunPaths;
};

/** Copies the checked-in fixtures into an isolated temp dir so tests never mutate repo fixtures. */
export async function setupFixtureWorkdir(): Promise<FixtureWorkdir> {
  const dir = await mkdtemp(join(tmpdir(), 'seo-fixture-'));
  const dataDir = join(dir, 'data', 'seo');
  await mkdir(dataDir, { recursive: true });
  await cp(join(REPO_ROOT, 'fixtures/data/seo/watchwords.json'), join(dataDir, 'watchwords.json'));
  await cp(join(REPO_ROOT, 'fixtures/data/seo/rank-history.json'), join(dataDir, 'rank-history.json'));
  await cp(join(REPO_ROOT, 'fixtures/data/seo/improvement-log.json'), join(dataDir, 'improvement-log.json'));

  const siteDir = join(dir, 'site');
  await mkdir(siteDir, { recursive: true });
  await cp(join(REPO_ROOT, 'fixtures/site/example.md'), join(siteDir, 'example.md'));

  return {
    dir,
    siteDir,
    paths: {
      watchwords: join(dataDir, 'watchwords.json'),
      rankHistory: join(dataDir, 'rank-history.json'),
      improvementLog: join(dataDir, 'improvement-log.json'),
      lock: join(dataDir, '.run.lock'),
    },
  };
}

export function fixtureConfig(overrides: Partial<SeoConfig> = {}): SeoConfig {
  return {
    schemaVersion: 1,
    site: { baseUrl: 'https://example.com', repoRoot: '.', contentRoot: 'content' },
    gsc: {
      property: 'sc-domain:example.com',
      credentialsEnv: 'GSC_SERVICE_ACCOUNT_JSON',
      defaultWindowDays: 28,
      reviewWindowDays: 7,
      finalDataLagDays: 3,
    },
    experiment: { cooldownDays: 7, oneKeywordPerRun: true },
    commands: { build: 'true', test: 'true' },
    adapters: { writer: 'stub', site: 'fixture', search: 'fixture' },
    ...overrides,
  };
}

export const exampleKeywordSerp: SerpInspection = {
  keyword: 'example keyword',
  results: [
    { rank: 1, title: 'Example Keyword: The Complete Guide', url: 'https://competitor-a.example.com', summary: 'Leads with a clear definition.' },
  ],
};

export const exampleKeywordPlan: SeoPlan = {
  searchNeed: '「example keyword」を検索する人は、まず用語の定義を知りたい',
  evidence: ['上位ページは冒頭で定義を明示している'],
  gaps: ['本文冒頭に定義がない'],
  selectedGap: '本文冒頭に定義がない',
  changeType: 'intro',
  requestedChange: '冒頭にexample keywordの定義を1文で追加する',
  requiredFacts: ['example keywordの定義'],
  forbiddenChanges: [],
  sources: [],
};

export async function readFileUtf8(path: string): Promise<string> {
  return readFile(path, 'utf8');
}
