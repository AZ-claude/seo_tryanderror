import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRankHistory,
  JsonStoreError,
  loadExperiments,
  loadOpportunities,
  loadRankHistory,
  saveExperiments,
  saveOpportunities,
  writeJsonFileAtomic,
} from '../src/infra/json-store.js';
import type { Experiment, Opportunity, RankHistory, RankHistoryEntry } from '../src/core/types.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'seo-store-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('writeJsonFileAtomic writes readable JSON and creates parent dirs', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'nested', 'file.json');
    await writeJsonFileAtomic(path, { hello: 'world' });
    const raw = await readFile(path, 'utf8');
    assert.deepEqual(JSON.parse(raw), { hello: 'world' });
  });
});

test('loadRankHistory returns an empty schemaVersion 2 doc when the file does not exist', async () => {
  await withTempDir(async (dir) => {
    const history = await loadRankHistory(join(dir, 'rank-history.json'));
    assert.deepEqual(history, { schemaVersion: 2, entries: [] });
  });
});

test('appendRankHistory: append works', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'rank-history.json');
    const initial: RankHistory = { schemaVersion: 2, entries: [] };
    await writeJsonFileAtomic(path, initial);

    const entry: RankHistoryEntry = {
      date: '2026-09-10',
      source: 'gsc',
      rows: [{ query: 'kw', page: '/p/', clicks: 1, impressions: 10, ctr: 0.1, position: 4 }],
    };
    const result = await appendRankHistory(path, entry);
    assert.equal(result.entries.length, 1);
    assert.deepEqual(result.entries[0], entry);
  });
});

test('appendRankHistory: duplicate date+source rejected', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'rank-history.json');
    await writeJsonFileAtomic(path, { schemaVersion: 2, entries: [] });

    const entry: RankHistoryEntry = {
      date: '2026-09-10',
      source: 'gsc',
      rows: [{ query: 'kw', page: '/p/', clicks: 1, impressions: 10, ctr: 0.1, position: 4 }],
    };
    await appendRankHistory(path, entry);

    await assert.rejects(() => appendRankHistory(path, entry), (err: unknown) => {
      assert.ok(err instanceof JsonStoreError);
      assert.equal(err.code, 'DUPLICATE_ENTRY');
      return true;
    });
  });
});

test('appendRankHistory: previous entry unchanged after new append', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'rank-history.json');
    await writeJsonFileAtomic(path, { schemaVersion: 2, entries: [] });

    const first: RankHistoryEntry = {
      date: '2026-09-01',
      source: 'gsc',
      rows: [{ query: 'kw', page: '/p/', clicks: 0, impressions: 5, ctr: 0, position: 6 }],
    };
    await appendRankHistory(path, first);

    const second: RankHistoryEntry = {
      date: '2026-09-08',
      source: 'gsc',
      rows: [{ query: 'kw', page: '/p/', clicks: 1, impressions: 10, ctr: 0.1, position: 4 }],
    };
    await appendRankHistory(path, second);

    const final = await loadRankHistory(path);
    assert.equal(final.entries.length, 2);
    assert.deepEqual(final.entries[0], first);
    assert.deepEqual(final.entries[1], second);
  });
});

test('opportunities.json: load default empty, save/load roundtrip', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'opportunities.json');
    assert.deepEqual(await loadOpportunities(path), []);

    const opportunity: Opportunity = {
      id: 'OPP1',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
      scope: { type: 'page', path: '/example/' },
      identity: { scopeKey: 'page:/example/', intentKey: 'content_gap:missing-definition' },
      kind: 'content_gap',
      title: 'title',
      description: 'desc',
      evidence: [],
      signals: { hasGscTraction: false, contentGapConfirmed: false, leveragesProprietaryData: false },
      status: 'open',
      history: [{ at: '2026-09-10T00:00:00.000Z', type: 'discovered' }],
    };
    await saveOpportunities(path, [opportunity]);
    const loaded = await loadOpportunities(path);
    assert.deepEqual(loaded, [opportunity]);
  });
});

test('experiments.json: load default empty, save/load roundtrip', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'experiments.json');
    assert.deepEqual(await loadExperiments(path), []);

    const experiment: Experiment = {
      id: 'EXP1',
      opportunityId: 'OPP1',
      hypothesisId: 'HYP1',
      action: { type: 'REVISE', targetPaths: ['/example/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
      measurementPlan: {
        targetPages: ['/example/'],
        primaryMetric: 'ctr',
        secondaryMetrics: [],
        baselineWindowDays: 28,
        reviewWindowDays: 7,
      },
      status: 'proposed',
      before: null,
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
      history: [{ at: '2026-09-10T00:00:00.000Z', type: 'proposed' }],
    };
    await saveExperiments(path, [experiment]);
    const loaded = await loadExperiments(path);
    assert.deepEqual(loaded, [experiment]);
  });
});
