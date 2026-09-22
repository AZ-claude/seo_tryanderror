import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRejectOpportunity } from '../src/core/workflow/reject-opportunity.js';
import { saveOpportunities } from '../src/infra/json-store.js';
import type { Opportunity } from '../src/core/types.js';

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'OPP1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    scope: { type: 'page', path: '/' },
    identity: { scopeKey: 'page:/', intentKey: 'ctr_title:x' },
    kind: 'ctr_title',
    title: 't',
    description: 'd',
    evidence: [],
    signals: { hasGscTraction: true, contentGapConfirmed: true, leveragesProprietaryData: false },
    status: 'open',
    history: [{ at: '2026-08-01T00:00:00.000Z', type: 'discovered' }],
    ...overrides,
  };
}

async function withWorkdir<T>(fn: (paths: { opportunities: string; lock: string }) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'seo-reject-opp-'));
  try {
    return await fn({ opportunities: join(dir, 'opportunities.json'), lock: join(dir, '.run.lock') });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('runRejectOpportunity: open -> rejected, history preserved, kind untouched', async () => {
  await withWorkdir(async (paths) => {
    await saveOpportunities(paths.opportunities, [opportunity()]);

    const result = await runRejectOpportunity(paths, {
      opportunityId: 'OPP1',
      reason: 'Misclassified as ctr_title; superseded by intent_mismatch Opportunity OPP2.',
      now: '2026-09-23T00:00:00.000Z',
      dryRun: false,
    });
    assert.equal(result.exitCode, 0);

    const saved = JSON.parse(await readFile(paths.opportunities, 'utf8')).opportunities[0];
    assert.equal(saved.status, 'rejected');
    assert.equal(saved.kind, 'ctr_title', 'reject-opportunity must never rewrite kind (part of identity)');
    assert.equal(saved.history.length, 2);
    assert.equal(saved.history[0].type, 'discovered');
    assert.equal(saved.history[1].type, 'rejected');
    assert.match(saved.history[1].note, /Misclassified as ctr_title/);
  });
});

test('runRejectOpportunity: dry-run makes no persistent writes', async () => {
  await withWorkdir(async (paths) => {
    await saveOpportunities(paths.opportunities, [opportunity()]);
    const before = await readFile(paths.opportunities, 'utf8');

    const result = await runRejectOpportunity(paths, {
      opportunityId: 'OPP1',
      reason: 'r',
      now: '2026-09-23T00:00:00.000Z',
      dryRun: true,
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.report, /DRY RUN/);
    assert.equal(await readFile(paths.opportunities, 'utf8'), before);
  });
});

test('runRejectOpportunity: refuses a non-open Opportunity (e.g. promoted, which has an active Experiment)', async () => {
  await withWorkdir(async (paths) => {
    await saveOpportunities(paths.opportunities, [opportunity({ status: 'promoted' })]);
    const result = await runRejectOpportunity(paths, {
      opportunityId: 'OPP1',
      reason: 'r',
      now: '2026-09-23T00:00:00.000Z',
      dryRun: false,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.report, /not 'open'/);
  });
});

test('runRejectOpportunity: unknown id -> error, no crash', async () => {
  await withWorkdir(async (paths) => {
    await saveOpportunities(paths.opportunities, [opportunity()]);
    const result = await runRejectOpportunity(paths, {
      opportunityId: 'NOPE',
      reason: 'r',
      now: '2026-09-23T00:00:00.000Z',
      dryRun: false,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.report, /no Opportunity found/);
  });
});
