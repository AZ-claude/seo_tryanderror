import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSiteReader } from '../src/cli.js';
import type { SeoConfig } from '../src/core/types.js';

const REPO_ROOT = process.cwd();

function baseConfig(overrides: Partial<SeoConfig['site']>): SeoConfig {
  return {
    schemaVersion: 2,
    site: {
      baseUrl: 'http://fixture.test',
      mode: 'existing',
      reader: 'http',
      repoRoot: null,
      contentRoot: null,
      ...overrides,
    },
    gsc: {
      property: 'sc-domain:fixture.test',
      credentialsEnv: 'GSC_SERVICE_ACCOUNT_JSON',
      defaultWindowDays: 28,
      reviewWindowDays: 7,
      finalDataLagDays: 3,
    },
    experiment: { cooldownDays: 7 },
    commands: { build: null, test: null },
    adapters: { writer: 'stub', site: 'http-readonly', search: 'fixture' },
  };
}

/** Serves the checked-in fixtures/html/sitemap-site directory (2 URLs) over global fetch. */
async function withFixtureFetch<T>(fn: () => Promise<T>): Promise<T> {
  const root = join(REPO_ROOT, 'fixtures/html/sitemap-site');
  const originalFetch = global.fetch;
  global.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    try {
      const text = await readFile(join(root, path.replace(/^\/+/, '')), 'utf8');
      return { ok: true, text: async () => text } as Response;
    } catch {
      return { ok: false, text: async () => '' } as Response;
    }
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

test('buildSiteReader: config.site.maxPages unset falls back to the adapter default (unbounded for this 2-url fixture)', async () => {
  await withFixtureFetch(async () => {
    const reader = buildSiteReader(baseConfig({}), { fixtureMode: false, fixturePages: [] });
    const pages = await reader.listPages();
    assert.equal(pages.length, 2);
  });
});

test('buildSiteReader: config.site.maxPages is passed through to the HttpSiteReaderAdapter and caps listPages', async () => {
  await withFixtureFetch(async () => {
    const reader = buildSiteReader(baseConfig({ maxPages: 1 }), { fixtureMode: false, fixturePages: [] });
    const pages = await reader.listPages();
    assert.equal(pages.length, 1);
  });
});
