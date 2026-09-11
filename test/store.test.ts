import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRankHistory,
  JsonStoreError,
  loadRankHistory,
  writeJsonFileAtomic,
} from '../src/infra/json-store.js';
import type { RankHistory, RankHistoryEntry } from '../src/core/types.js';

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

test('appendRankHistory: append works', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'rank-history.json');
    const initial: RankHistory = { schemaVersion: 1, entries: [] };
    await writeJsonFileAtomic(path, initial);

    const entry: RankHistoryEntry = {
      date: '2026-09-10',
      source: 'gsc',
      measurements: [{ keyword: 'kw', rank: 4, impressions: 10, clicks: 1 }],
    };
    const result = await appendRankHistory(path, entry);
    assert.equal(result.entries.length, 1);
    assert.deepEqual(result.entries[0], entry);
  });
});

test('appendRankHistory: duplicate date+source rejected', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'rank-history.json');
    await writeJsonFileAtomic(path, { schemaVersion: 1, entries: [] });

    const entry: RankHistoryEntry = {
      date: '2026-09-10',
      source: 'gsc',
      measurements: [{ keyword: 'kw', rank: 4, impressions: 10, clicks: 1 }],
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
    await writeJsonFileAtomic(path, { schemaVersion: 1, entries: [] });

    const first: RankHistoryEntry = {
      date: '2026-09-01',
      source: 'gsc',
      measurements: [{ keyword: 'kw', rank: 6, impressions: 5, clicks: 0 }],
    };
    await appendRankHistory(path, first);

    const second: RankHistoryEntry = {
      date: '2026-09-08',
      source: 'gsc',
      measurements: [{ keyword: 'kw', rank: 4, impressions: 10, clicks: 1 }],
    };
    await appendRankHistory(path, second);

    const final = await loadRankHistory(path);
    assert.equal(final.entries.length, 2);
    assert.deepEqual(final.entries[0], first);
    assert.deepEqual(final.entries[1], second);
  });
});
