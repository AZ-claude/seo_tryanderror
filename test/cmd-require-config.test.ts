import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cmdApply,
  cmdDiscover,
  cmdPrioritize,
  cmdPropose,
  cmdReject,
  cmdRejectOpportunity,
  cmdReview,
  cmdStatus,
  cmdUnderstand,
} from '../src/cli.js';
import { saveOpportunities } from '../src/infra/json-store.js';
import type { Opportunity } from '../src/core/types.js';

async function withWorkdir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), 'seo-require-config-'));
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
}

async function captureError<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const originalError = console.error;
  let stderr = '';
  console.error = (msg?: unknown) => {
    stderr += `${String(msg)}\n`;
  };
  try {
    const result = await fn();
    return { result, stderr };
  } finally {
    console.error = originalError;
  }
}

async function captureLog<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const originalLog = console.log;
  let output = '';
  console.log = (msg?: unknown) => {
    output += `${String(msg)}\n`;
  };
  try {
    const result = await fn();
    return { result, output };
  } finally {
    console.log = originalLog;
  }
}

test('every real (non-fixture) state-touching command errors clearly with exit 1 when --config is omitted, instead of falling back to legacy data/seo/', async () => {
  await withWorkdir(async () => {
    const cases: Array<{ name: string; run: () => Promise<number> }> = [
      { name: 'understand', run: () => cmdUnderstand({}) },
      { name: 'discover', run: () => cmdDiscover({ 'dump-inputs': true }) },
      { name: 'prioritize', run: () => cmdPrioritize({}) },
      { name: 'propose', run: () => cmdPropose({ 'opportunity-id': 'X', 'hypothesis-file': '/nonexistent.json' }) },
      { name: 'apply', run: () => cmdApply({ 'experiment-id': 'X', 'evidence-file': '/nonexistent.json' }) },
      { name: 'reject', run: () => cmdReject({ 'experiment-id': 'X', reason: 'r' }) },
      { name: 'reject-opportunity', run: () => cmdRejectOpportunity({ 'opportunity-id': 'X', reason: 'r' }) },
      { name: 'review', run: () => cmdReview({ 'experiment-id': 'X', 'dump-inputs': true }) },
      { name: 'status', run: () => cmdStatus({}) },
    ];

    for (const { name, run } of cases) {
      const { result: exitCode, stderr } = await captureError(run);
      assert.equal(exitCode, 1, `${name} must exit 1 without --config`);
      assert.match(stderr, new RegExp(`${name} requires --config`), `${name} must print a clear usage error`);
    }
  });
});

test('a real config missing site.key is also rejected (not just a missing --config flag)', async () => {
  await withWorkdir(async (dir) => {
    const configPath = join(dir, 'no-key.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 2,
        site: { baseUrl: 'http://fixture.test', mode: 'existing', reader: 'http', repoRoot: null, contentRoot: null },
        gsc: { property: 'sc-domain:fixture.test', credentialsEnv: 'SEO_TEST_GSC_ENV_UNSET', defaultWindowDays: 28, reviewWindowDays: 7, finalDataLagDays: 3 },
        experiment: { cooldownDays: 7 },
        commands: { build: null, test: null },
        adapters: { writer: 'stub', site: 'http-readonly', search: 'fixture' },
      }),
      'utf8',
    );

    const { result: exitCode, stderr } = await captureError(() => cmdStatus({ config: configPath }));
    assert.equal(exitCode, 1);
    assert.match(stderr, /site\.key is required/);
  });
});

test('--fixture mode is unaffected: status/prioritize still work without --config', async () => {
  // Deliberately does NOT chdir — --fixture mode resolves its default config
  // and runtime copy relative to process.cwd(), the same way a real
  // `npm run seo -- ... --fixture` invocation does (repo root). discover
  // --dump-inputs is not exercised here: it legitimately requires a prior
  // `understand --fixture` run to have seeded site-understanding.json in
  // the shared .tmp/fixture-run runtime copy — a pre-existing precondition
  // unrelated to this hardening change.
  const statusCode = await cmdStatus({ fixture: true });
  assert.equal(statusCode, 0);

  const prioritizeCode = await cmdPrioritize({ fixture: true });
  assert.equal(prioritizeCode, 0);
});

function opportunity(id: string): Opportunity {
  return {
    id,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    scope: { type: 'page', path: '/a/' },
    identity: { scopeKey: `page:/a/-${id}`, intentKey: 'content_gap:x' },
    kind: 'content_gap',
    title: id,
    description: 'd',
    evidence: [],
    signals: { hasGscTraction: false, contentGapConfirmed: false, leveragesProprietaryData: false },
    status: 'open',
    history: [],
  };
}

test('the real committed configs route to their own site.key state dir, and never touch each other (cross-site mutation 0)', async () => {
  await withWorkdir(async (dir) => {
    const repoRoot = join(import.meta.dirname, '..');
    const rakusetsuConfigSrc = await readFile(join(repoRoot, 'config/seo.rakusetsu.config.json'), 'utf8');
    const pokecaConfigSrc = await readFile(join(repoRoot, 'config/seo.pokeca.config.json'), 'utf8');

    const rakusetsuConfigPath = join(dir, 'seo.rakusetsu.config.json');
    const pokecaConfigPath = join(dir, 'seo.pokeca.config.json');
    await writeFile(rakusetsuConfigPath, rakusetsuConfigSrc, 'utf8');
    await writeFile(pokecaConfigPath, pokecaConfigSrc, 'utf8');

    await mkdir(join(dir, 'data/seo/rakusetsu-main'), { recursive: true });
    await mkdir(join(dir, 'data/seo/pokeca'), { recursive: true });
    await saveOpportunities(join(dir, 'data/seo/rakusetsu-main/opportunities.json'), [opportunity('R1')]);
    await saveOpportunities(join(dir, 'data/seo/pokeca/opportunities.json'), [opportunity('P1'), opportunity('P2')]);
    const pokecaBefore = await readFile(join(dir, 'data/seo/pokeca/opportunities.json'), 'utf8');

    const { output: rakusetsuOut } = await captureLog(() => cmdStatus({ config: rakusetsuConfigPath }));
    assert.match(rakusetsuOut, /openOpportunities: 1/, 'rakusetsu config must read data/seo/rakusetsu-main/, not pokeca');

    const { output: pokecaOut } = await captureLog(() => cmdStatus({ config: pokecaConfigPath }));
    assert.match(pokecaOut, /openOpportunities: 2/, 'pokeca config must read data/seo/pokeca/, not rakusetsu-main');

    const pokecaAfter = await readFile(join(dir, 'data/seo/pokeca/opportunities.json'), 'utf8');
    assert.equal(pokecaAfter, pokecaBefore, 'reading rakusetsu status must not mutate pokeca state at all');
  });
});
