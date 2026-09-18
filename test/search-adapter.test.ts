import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSearchAdapter, FixtureSearchAdapter, SearchAdapterError } from '../src/adapters/search.js';
import type { SerpInspection } from '../src/core/types.js';

const serp: SerpInspection = {
  query: 'example keyword',
  results: [
    { rank: 1, title: 'A', url: 'https://a.example.com', summary: 'a' },
    { rank: 2, title: 'B', url: 'https://b.example.com', summary: 'b' },
    { rank: 3, title: 'C', url: 'https://c.example.com', summary: 'c' },
  ],
};

test('FixtureSearchAdapter returns the matching fixture, truncated to topN', async () => {
  const adapter = new FixtureSearchAdapter({ 'example keyword': serp });
  const result = await adapter.inspectSerp({ query: 'example keyword', topN: 2 });
  assert.equal(result.results.length, 2);
  assert.equal(result.query, 'example keyword');
});

test('FixtureSearchAdapter throws for an unknown query', async () => {
  const adapter = new FixtureSearchAdapter({});
  await assert.rejects(() => adapter.inspectSerp({ query: 'missing', topN: 3 }), SearchAdapterError);
});

test('FileSearchAdapter reads and validates a --serp-file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seo-search-test-'));
  try {
    const path = join(dir, 'serp.json');
    await writeFile(path, JSON.stringify(serp), 'utf8');
    const adapter = new FileSearchAdapter(path);
    const result = await adapter.inspectSerp({ query: 'example keyword', topN: 1 });
    assert.equal(result.results.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('FileSearchAdapter rejects an invalid serp file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seo-search-test-'));
  try {
    const path = join(dir, 'bad.json');
    await writeFile(path, JSON.stringify({ nope: true }), 'utf8');
    const adapter = new FileSearchAdapter(path);
    await assert.rejects(() => adapter.inspectSerp({ query: 'example keyword', topN: 1 }), SearchAdapterError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
