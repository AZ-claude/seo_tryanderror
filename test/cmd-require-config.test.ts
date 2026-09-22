import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdPropose, cmdReview, cmdUnderstand } from '../src/cli.js';

async function withWorkdir<T>(fn: () => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), 'seo-require-config-'));
  process.chdir(dir);
  try {
    return await fn();
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

test('understand/propose/review: a clear usage error (not a raw ENOENT stack trace) when --config is omitted outside --fixture mode', async () => {
  await withWorkdir(async () => {
    const { result: understandCode, stderr: understandErr } = await captureError(() => cmdUnderstand({}));
    assert.equal(understandCode, 1);
    assert.match(understandErr, /understand requires --config/);

    const { result: proposeCode, stderr: proposeErr } = await captureError(() =>
      cmdPropose({ 'opportunity-id': 'X', 'hypothesis-file': '/nonexistent.json' }),
    );
    assert.equal(proposeCode, 1);
    assert.match(proposeErr, /propose requires --config/);

    const { result: reviewCode, stderr: reviewErr } = await captureError(() => cmdReview({ 'experiment-id': 'X', 'dump-inputs': true }));
    assert.equal(reviewCode, 1);
    assert.match(reviewErr, /review requires --config/);
  });
});
