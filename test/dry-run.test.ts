import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { runDiscover } from '../src/core/workflow/discover.js';
import { runPropose } from '../src/core/workflow/propose.js';
import { runUnderstand } from '../src/core/workflow/understand.js';
import {
  buildFixtureGscAdapter,
  buildFixtureSiteReader,
  loadFixtureDiscoverInput,
  loadFixtureProposeInput,
  setupFixtureWorkdir,
} from './fixtures-helper.js';

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

test('understand --dry-run: site-understanding.json and rank-history.json are not written', async () => {
  const { dir, paths } = await setupFixtureWorkdir();
  try {
    const before = await readIfExists(paths.rankHistory);
    const siteUnderstandingExistsBefore = await stat(paths.siteUnderstanding).then(
      () => true,
      () => false,
    );

    const siteReader = await buildFixtureSiteReader();
    const gsc = await buildFixtureGscAdapter();
    const result = await runUnderstand(paths, siteReader, gsc, {
      baseUrl: 'https://example.com',
      gscProperty: 'sc-domain:example.com',
      today: '2026-09-10',
      dryRun: true,
      gscWindowDays: 28,
      finalDataLagDays: 0,
      gscSource: 'fixture',
    });

    assert.match(result.report, /DRY RUN/);
    assert.ok(result.siteUnderstanding.pages.length > 0, 'read-only fetch should still happen in dry-run');

    const after = await readIfExists(paths.rankHistory);
    assert.equal(after, before);
    const siteUnderstandingExistsAfter = await stat(paths.siteUnderstanding).then(
      () => true,
      () => false,
    );
    assert.equal(siteUnderstandingExistsAfter, siteUnderstandingExistsBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('discover + propose --dry-run: opportunities.json and experiments.json are not written', async () => {
  const { dir, paths } = await setupFixtureWorkdir();
  try {
    // Seed opportunities via a non-dry-run discover first (so propose has something to act on).
    const discoverInput = await loadFixtureDiscoverInput();
    const seeded = await runDiscover(paths, discoverInput.opportunities, '2026-09-10T00:00:00.000Z', false);
    const opportunityId = seeded.opportunities[0]!.id;

    const opportunitiesBefore = await readFile(paths.opportunities, 'utf8');
    const experimentsBefore = await readIfExists(paths.experiments);

    // A second discover run in dry-run mode must not change opportunities.json either.
    const discoverDryRun = await runDiscover(paths, discoverInput.opportunities, '2026-09-11T00:00:00.000Z', true);
    assert.match(discoverDryRun.report, /DRY RUN/);
    assert.equal(await readFile(paths.opportunities, 'utf8'), opportunitiesBefore);

    const proposeInput = await loadFixtureProposeInput();
    const proposeResult = await runPropose(paths, {
      opportunityId,
      input: proposeInput,
      today: '2026-09-10',
      now: '2026-09-10T00:00:00.000Z',
      finalDataLagDays: 0,
      metricsSource: 'fixture',
      dryRun: true,
    });
    assert.equal(proposeResult.exitCode, 0);
    assert.match(proposeResult.report, /DRY RUN/);

    assert.equal(await readFile(paths.opportunities, 'utf8'), opportunitiesBefore);
    assert.equal(await readIfExists(paths.experiments), experimentsBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
