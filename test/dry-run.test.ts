import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { runSeoLoop } from '../src/core/run.js';
import { FixtureSiteAdapter } from '../src/adapters/site.js';
import { StubNaturalWriterAdapter } from '../src/adapters/natural-writer.js';
import { FixtureSearchAdapter } from '../src/adapters/search.js';
import {
  exampleKeywordPlan,
  exampleKeywordSerp,
  fixtureConfig,
  readFileUtf8,
  setupFixtureWorkdir,
} from './fixtures-helper.js';

test('dry-run: zero persistent file mutations', async () => {
  const { dir, siteDir, paths } = await setupFixtureWorkdir();
  try {
    const before = {
      watchwords: await readFileUtf8(paths.watchwords),
      rankHistory: await readFileUtf8(paths.rankHistory),
      improvementLog: await readFileUtf8(paths.improvementLog),
      site: await readFileUtf8(`${siteDir}/example.md`),
    };

    const config = fixtureConfig();
    const adapters = {
      gsc: null,
      search: new FixtureSearchAdapter({ 'example keyword': exampleKeywordSerp }),
      writer: new StubNaturalWriterAdapter(),
      site: new FixtureSiteAdapter(siteDir),
    };

    const result = await runSeoLoop(config, paths, adapters, {
      today: '2026-09-10',
      dryRun: true,
      fetchMeasurement: false,
      planOverride: exampleKeywordPlan,
    });

    assert.equal(result.exitCode, 0);
    assert.ok(result.reportData.dryRun);
    assert.match(result.report, /DRY RUN/);
    assert.ok(result.reportData.selection, 'a candidate should have been selected and planned');

    const after = {
      watchwords: await readFileUtf8(paths.watchwords),
      rankHistory: await readFileUtf8(paths.rankHistory),
      improvementLog: await readFileUtf8(paths.improvementLog),
      site: await readFileUtf8(`${siteDir}/example.md`),
    };
    assert.deepEqual(after, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
