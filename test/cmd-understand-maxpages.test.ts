import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdUnderstand } from '../src/cli.js';

const REPO_ROOT = process.cwd();

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

async function writeConfig(dir: string, maxPages: number | undefined): Promise<string> {
  const configPath = join(dir, 'seo.config.json');
  const site: Record<string, unknown> = {
    key: 'maxpages-test-site',
    baseUrl: 'http://fixture.test',
    mode: 'existing',
    reader: 'http',
    repoRoot: null,
    contentRoot: null,
  };
  if (maxPages !== undefined) site.maxPages = maxPages;
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 2,
      site,
      gsc: {
        property: 'sc-domain:fixture.test',
        credentialsEnv: 'SEO_TEST_GSC_ENV_UNSET',
        defaultWindowDays: 28,
        reviewWindowDays: 7,
        finalDataLagDays: 3,
      },
      experiment: { cooldownDays: 7 },
      commands: { build: null, test: null },
      adapters: { writer: 'stub', site: 'http-readonly', search: 'fixture' },
    }),
    'utf8',
  );
  return configPath;
}

/** fixtures/html/sitemap-site has 2 pages (a.html, b.html; private/secret.html is robots-disallowed). */
async function runUnderstandDryRunCapturingReport(configPath: string): Promise<string> {
  const originalCwd = process.cwd();
  const workDir = await mkdtemp(join(tmpdir(), 'seo-cmd-understand-'));
  await mkdir(join(workDir, 'data/seo'), { recursive: true });
  process.chdir(workDir);
  let captured = '';
  const originalLog = console.log;
  console.log = (msg?: unknown) => {
    captured += String(msg);
  };
  try {
    const code = await cmdUnderstand({ config: configPath, 'dry-run': true });
    assert.equal(code, 0);
    return captured;
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
    await rm(workDir, { recursive: true, force: true });
  }
}

test('cmdUnderstand: config.site.maxPages controls the number of pages actually read end-to-end', async () => {
  await withFixtureFetch(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seo-config-'));
    try {
      const configPath = await writeConfig(dir, 1);
      const report = await runUnderstandDryRunCapturingReport(configPath);
      assert.match(report, /pages read: 1/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('cmdUnderstand: config.site.maxPages unset reads all pages under the default cap (unaffected)', async () => {
  await withFixtureFetch(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seo-config-'));
    try {
      const configPath = await writeConfig(dir, undefined);
      const report = await runUnderstandDryRunCapturingReport(configPath);
      assert.match(report, /pages read: 2/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
