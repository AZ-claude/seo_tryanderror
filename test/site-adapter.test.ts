import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureSiteAdapter, resolveContentFile } from '../src/adapters/site.js';
import type { SeoPlan } from '../src/core/types.js';

const plan: SeoPlan = {
  searchNeed: 'need',
  evidence: [],
  gaps: ['gap'],
  selectedGap: 'gap',
  changeType: 'intro',
  requestedChange: 'add intro',
  requiredFacts: [],
  forbiddenChanges: [],
  sources: [],
};

test('resolveContentFile maps a targetPath to a Markdown file under the root', () => {
  assert.equal(resolveContentFile('/root', '/example/'), join('/root', 'example.md'));
  assert.equal(resolveContentFile('/root', '/'), join('/root', 'index.md'));
});

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'seo-site-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('FixtureSiteAdapter readPage/apply roundtrip', async () => {
  await withTempDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'example.md'), 'original content', 'utf8');
    const adapter = new FixtureSiteAdapter(dir);

    const before = await adapter.readPage('/example/');
    assert.equal(before.content, 'original content');

    const applyResult = await adapter.apply({ targetPath: '/example/', newText: 'updated content', plan });
    assert.equal(applyResult.changedFiles.length, 1);

    const after = await adapter.readPage('/example/');
    assert.equal(after.content, 'updated content');
  });
});

test('FixtureSiteAdapter validate ok by default, forced failure when configured', async () => {
  await withTempDir(async (dir) => {
    const ok = new FixtureSiteAdapter(dir);
    assert.equal((await ok.validate()).ok, true);

    const failing = new FixtureSiteAdapter(dir, { forceValidationFailure: true });
    assert.equal((await failing.validate()).ok, false);
  });
});
