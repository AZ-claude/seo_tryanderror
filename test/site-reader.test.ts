import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpSiteReaderAdapter } from '../src/adapters/site-reader.js';
import { buildPageSnapshot } from '../src/core/site-understanding.js';
import type { FetchLike } from '../src/adapters/site-reader.js';

const REPO_ROOT = process.cwd();

function fixtureFetch(root: string): FetchLike {
  return async (url: string) => {
    const path = new URL(url).pathname; // e.g. /a.html, /sitemap.xml, /robots.txt
    try {
      const text = await readFile(join(root, path.replace(/^\/+/, '')), 'utf8');
      return { ok: true, text: async () => text };
    } catch {
      return { ok: false, text: async () => '' };
    }
  };
}

test('HttpSiteReaderAdapter: sitemap.xml is preferred, robots.txt Disallow is respected', async () => {
  const root = join(REPO_ROOT, 'fixtures/html/sitemap-site');
  const adapter = new HttpSiteReaderAdapter({ baseUrl: 'http://fixture.test', fetchImpl: fixtureFetch(root) });

  const pages = await adapter.listPages();
  const paths = pages.map((p) => p.path);
  assert.deepEqual(paths.sort(), ['http://fixture.test/a.html', 'http://fixture.test/b.html']);
  assert.ok(pages.every((p) => p.source === 'sitemap'));
});

test('HttpSiteReaderAdapter: sitemap listPages is capped by maxPages', async () => {
  const root = join(REPO_ROOT, 'fixtures/html/sitemap-site');
  const adapter = new HttpSiteReaderAdapter({ baseUrl: 'http://fixture.test', fetchImpl: fixtureFetch(root), maxPages: 1 });
  const pages = await adapter.listPages();
  assert.equal(pages.length, 1);
});

test('HttpSiteReaderAdapter: readPage extracts title, headings and body text', async () => {
  const root = join(REPO_ROOT, 'fixtures/html/sitemap-site');
  const adapter = new HttpSiteReaderAdapter({ baseUrl: 'http://fixture.test', fetchImpl: fixtureFetch(root) });
  const page = await adapter.readPage('http://fixture.test/a.html');
  assert.equal(page.title, 'Page A Title');
  assert.deepEqual(page.headings, ['Page A Heading', 'Sub heading']);
  assert.match(page.text, /body text of page A/);
  assert.doesNotMatch(page.text, /<h1>/);
});

test('HttpSiteReaderAdapter: falls back to a shallow crawl when there is no sitemap, following same-origin links only', async () => {
  const root = join(REPO_ROOT, 'fixtures/html/crawl-site');
  const adapter = new HttpSiteReaderAdapter({
    baseUrl: 'http://fixture.test/index.html',
    fetchImpl: fixtureFetch(root),
    maxCrawlDepth: 2,
    maxPages: 10,
  });
  const pages = await adapter.listPages();
  const paths = pages.map((p) => p.path).sort();
  assert.deepEqual(paths, [
    'http://fixture.test/index.html',
    'http://fixture.test/page1.html',
    'http://fixture.test/page2.html',
    'http://fixture.test/page3.html',
  ]);
  assert.ok(pages.every((p) => p.source === 'crawl'));
  assert.ok(!paths.includes('https://external.example.com/should-not-be-followed'));
});

test('HttpSiteReaderAdapter: shallow crawl respects maxCrawlDepth (page3 is depth 2, unreachable at depth 1)', async () => {
  const root = join(REPO_ROOT, 'fixtures/html/crawl-site');
  const adapter = new HttpSiteReaderAdapter({
    baseUrl: 'http://fixture.test/index.html',
    fetchImpl: fixtureFetch(root),
    maxCrawlDepth: 1,
    maxPages: 10,
  });
  const pages = await adapter.listPages();
  const paths = pages.map((p) => p.path);
  assert.ok(!paths.includes('http://fixture.test/page3.html'));
});

test('HttpSiteReaderAdapter: shallow crawl respects maxPages', async () => {
  const root = join(REPO_ROOT, 'fixtures/html/crawl-site');
  const adapter = new HttpSiteReaderAdapter({
    baseUrl: 'http://fixture.test/index.html',
    fetchImpl: fixtureFetch(root),
    maxCrawlDepth: 2,
    maxPages: 2,
  });
  const pages = await adapter.listPages();
  assert.equal(pages.length, 2);
});

test('buildPageSnapshot: excerpt is truncated at the configured limit and content is hashed, not stored in full', () => {
  const longText = 'a'.repeat(100);
  const snapshot = buildPageSnapshot({
    path: '/p/',
    headings: [],
    text: longText,
    fetchedAt: '2026-09-10T00:00:00.000Z',
    excerptMaxChars: 10,
  });
  assert.equal(snapshot.excerpt.length, 10);
  assert.equal(snapshot.excerptTruncated, true);
  assert.equal(snapshot.contentHash.length, 64); // sha256 hex
  assert.ok(!('text' in snapshot));
});

test('buildPageSnapshot: short text is not truncated', () => {
  const snapshot = buildPageSnapshot({
    path: '/p/',
    headings: [],
    text: 'short text',
    fetchedAt: '2026-09-10T00:00:00.000Z',
  });
  assert.equal(snapshot.excerptTruncated, false);
  assert.equal(snapshot.excerpt, 'short text');
});
