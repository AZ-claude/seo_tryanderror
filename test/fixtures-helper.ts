import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverInputFileSchema, proposeInputSchema } from '../src/core/schemas.js';
import { readJsonFile } from '../src/infra/json-store.js';
import { FixtureSiteReaderAdapter } from '../src/adapters/site-reader.js';
import type { FixturePage } from '../src/adapters/site-reader.js';
import type { GscAdapter, GscSummaryRow } from '../src/core/types.js';

const REPO_ROOT = process.cwd();

export type FixtureWorkdir = {
  dir: string;
  paths: {
    siteUnderstanding: string;
    opportunities: string;
    experiments: string;
    rankHistory: string;
    lock: string;
  };
};

/** Copies the checked-in fixture data into an isolated temp dir so tests never mutate repo fixtures. */
export async function setupFixtureWorkdir(): Promise<FixtureWorkdir> {
  const dir = await mkdtemp(join(tmpdir(), 'seo-fixture-'));
  const dataDir = join(dir, 'data', 'seo');
  await mkdir(dataDir, { recursive: true });
  await cp(join(REPO_ROOT, 'fixtures/data/seo'), dataDir, { recursive: true });

  return {
    dir,
    paths: {
      siteUnderstanding: join(dataDir, 'site-understanding.json'),
      opportunities: join(dataDir, 'opportunities.json'),
      experiments: join(dataDir, 'experiments.json'),
      rankHistory: join(dataDir, 'rank-history.json'),
      lock: join(dataDir, '.run.lock'),
    },
  };
}

export async function loadFixtureSitePages(): Promise<FixturePage[]> {
  const raw = await readFile(join(REPO_ROOT, 'fixtures/site-v2/pages.json'), 'utf8');
  return JSON.parse(raw) as FixturePage[];
}

export async function buildFixtureSiteReader(): Promise<FixtureSiteReaderAdapter> {
  return new FixtureSiteReaderAdapter(await loadFixtureSitePages());
}

export async function buildFixtureGscAdapter(): Promise<GscAdapter> {
  const raw = await readFile(join(REPO_ROOT, 'fixtures/gsc/query-page-matrix.json'), 'utf8');
  const rows = JSON.parse(raw) as GscSummaryRow[];
  return {
    async fetchQueryPageMatrix() {
      return { rows };
    },
  };
}

export async function loadFixtureDiscoverInput() {
  return readJsonFile(join(REPO_ROOT, 'fixtures/discover/opportunities.json'), discoverInputFileSchema);
}

export async function loadFixtureProposeInput() {
  return readJsonFile(join(REPO_ROOT, 'fixtures/propose/hypothesis.json'), proposeInputSchema);
}
