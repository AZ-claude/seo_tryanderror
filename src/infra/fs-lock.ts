import { open, stat, unlink } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export class LockError extends Error {
  readonly code = 'RUN_ALREADY_ACTIVE';
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

export type Lock = { release: () => Promise<void> };

const DEFAULT_STALE_MS = 10 * 60 * 1000;

/**
 * Exclusive file lock to prevent double execution (DESIGN.md section 7).
 * - no lock -> create
 * - lock present and fresh -> throw LockError (RUN_ALREADY_ACTIVE)
 * - lock present and stale -> warn, replace, proceed
 */
export async function acquireLock(lockPath: string, staleMs = DEFAULT_STALE_MS): Promise<Lock> {
  await mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
      return { release: () => unlink(lockPath).catch(() => {}) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const info = await stat(lockPath);
      const age = Date.now() - info.mtimeMs;
      if (age < staleMs) {
        throw new LockError(`SEO run already active (lock age ${Math.round(age / 1000)}s): ${lockPath}`);
      }
      console.warn(`stale lock detected (age ${Math.round(age / 1000)}s), replacing: ${lockPath}`);
      await unlink(lockPath).catch(() => {});
    }
  }
  throw new LockError(`failed to acquire lock after replacing a stale one: ${lockPath}`);
}
