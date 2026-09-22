import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GscError, RealGscAdapter } from '../src/adapters/gsc.js';
import { readJsonFile } from '../src/infra/json-store.js';
import { seoConfigSchema } from '../src/core/schemas.js';

async function withFakeServiceAccount<T>(fn: (envVar: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'seo-fake-sa-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const path = join(dir, 'fake-service-account.json');
  await writeFile(
    path,
    JSON.stringify({ client_email: 'fake@example.iam.gserviceaccount.com', private_key: pem }),
    'utf8',
  );
  const envVar = 'SEO_TEST_FAKE_GSC_JSON';
  const original = process.env[envVar];
  process.env[envVar] = path;
  try {
    return await fn(envVar);
  } finally {
    if (original === undefined) delete process.env[envVar];
    else process.env[envVar] = original;
    await rm(dir, { recursive: true, force: true });
  }
}

test('RealGscAdapter: pagePrefix/excludePagePrefix reach the actual searchAnalytics request body as dimensionFilterGroups', async () => {
  await withFakeServiceAccount(async (envVar) => {
    const originalFetch = global.fetch;
    let capturedBody: unknown;
    global.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'fake-token' }) } as Response;
      }
      if (u.includes('searchAnalytics/query')) {
        capturedBody = JSON.parse(String(init!.body));
        return { ok: true, json: async () => ({ rows: [] }) } as Response;
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;

    try {
      const adapter = new RealGscAdapter(envVar);
      await adapter.fetchQueryPageMatrix({
        property: 'sc-domain:rakusetsu.com',
        startDate: '2026-08-24',
        endDate: '2026-09-20',
        pagePrefix: 'https://pokeca.rakusetsu.com/',
      });
      assert.deepEqual((capturedBody as { dimensionFilterGroups?: unknown }).dimensionFilterGroups, [
        { filters: [{ dimension: 'page', operator: 'contains', expression: 'https://pokeca.rakusetsu.com/' }] },
      ]);

      await adapter.fetchQueryPageMatrix({
        property: 'sc-domain:rakusetsu.com',
        startDate: '2026-08-24',
        endDate: '2026-09-20',
        excludePagePrefix: 'https://pokeca.rakusetsu.com/',
      });
      assert.deepEqual((capturedBody as { dimensionFilterGroups?: unknown }).dimensionFilterGroups, [
        { filters: [{ dimension: 'page', operator: 'notContains', expression: 'https://pokeca.rakusetsu.com/' }] },
      ]);

      await adapter.fetchQueryPageMatrix({
        property: 'sc-domain:rakusetsu.com',
        startDate: '2026-08-24',
        endDate: '2026-09-20',
      });
      assert.equal((capturedBody as { dimensionFilterGroups?: unknown }).dimensionFilterGroups, undefined, 'no filter -> no dimensionFilterGroups key sent at all');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('RealGscAdapter: a fetch failure error message never includes the private key content', async () => {
  await withFakeServiceAccount(async (envVar) => {
    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'fake-token' }) } as Response;
      }
      if (u.includes('searchAnalytics/query')) {
        return { ok: false, status: 403, text: async () => 'permission denied' } as Response;
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;

    try {
      const adapter = new RealGscAdapter(envVar);
      await assert.rejects(
        () => adapter.fetchQueryPageMatrix({ property: 'sc-domain:rakusetsu.com', startDate: '2026-08-24', endDate: '2026-09-20' }),
        (err: unknown) => {
          assert.ok(err instanceof GscError);
          assert.equal(err.code, 'GSC_FETCH_FAILED');
          assert.doesNotMatch(err.message, /BEGIN RSA PRIVATE KEY/);
          assert.doesNotMatch(err.message, /fake-token/);
          return true;
        },
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test('RealGscAdapter: a missing/unreadable credential file error never echoes file content, only the path/env var name', async () => {
  const adapter = new RealGscAdapter('SEO_TEST_GSC_ENV_DEFINITELY_UNSET');
  await assert.rejects(
    () => adapter.fetchQueryPageMatrix({ property: 'sc-domain:rakusetsu.com', startDate: '2026-08-24', endDate: '2026-09-20' }),
    (err: unknown) => {
      assert.ok(err instanceof GscError);
      assert.equal(err.code, 'GSC_NOT_CONFIGURED');
      assert.match(err.message, /SEO_TEST_GSC_ENV_DEFINITELY_UNSET/);
      assert.doesNotMatch(err.message, /PRIVATE KEY/);
      return true;
    },
  );
});

test('config resolution regression: the real committed multi-site configs both validate against seoConfigSchema with distinct site.key/gsc scoping', async () => {
  const rakusetsu = await readJsonFile(join(process.cwd(), 'config/seo.rakusetsu.config.json'), seoConfigSchema);
  const pokeca = await readJsonFile(join(process.cwd(), 'config/seo.pokeca.config.json'), seoConfigSchema);

  assert.equal(rakusetsu.site.key, 'rakusetsu-main');
  assert.equal(pokeca.site.key, 'pokeca');
  assert.notEqual(rakusetsu.site.key, pokeca.site.key);

  assert.equal(rakusetsu.gsc.excludePagePrefix, 'https://pokeca.rakusetsu.com/');
  assert.equal(rakusetsu.gsc.pagePrefix, undefined, 'rakusetsu-main must not scope itself down with pagePrefix');
  assert.equal(pokeca.gsc.pagePrefix, 'https://pokeca.rakusetsu.com/');
  assert.equal(pokeca.gsc.excludePagePrefix, undefined, 'pokeca must not exclude its own pages');

  assert.equal(pokeca.experiment.maxActiveExperiments, 2);
});
