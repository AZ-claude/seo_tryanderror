import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, LockError } from '../src/infra/fs-lock.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'seo-lock-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('acquireLock creates a lock file when none exists', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, '.run.lock');
    const lock = await acquireLock(lockPath);
    await lock.release();
  });
});

test('acquireLock rejects a fresh concurrent lock with RUN_ALREADY_ACTIVE', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, '.run.lock');
    const lock = await acquireLock(lockPath);
    await assert.rejects(() => acquireLock(lockPath), (err: unknown) => {
      assert.ok(err instanceof LockError);
      assert.equal(err.code, 'RUN_ALREADY_ACTIVE');
      return true;
    });
    await lock.release();
  });
});

test('acquireLock replaces a stale lock', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, '.run.lock');
    const first = await acquireLock(lockPath);
    // Backdate the lock file well past the stale threshold instead of sleeping.
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    const second = await acquireLock(lockPath, 1000);
    await second.release();
    // first.release() on an already-removed file should not throw.
    await first.release();
  });
});

test('release allows the lock to be re-acquired', async () => {
  await withTempDir(async (dir) => {
    const lockPath = join(dir, '.run.lock');
    const lock = await acquireLock(lockPath);
    await lock.release();
    const again = await acquireLock(lockPath);
    await again.release();
  });
});
