import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { runSeoLoop } from '../src/core/run.js';
import { FixtureSiteAdapter } from '../src/adapters/site.js';
import { StubNaturalWriterAdapter } from '../src/adapters/natural-writer.js';
import { FixtureSearchAdapter } from '../src/adapters/search.js';
import { loadImprovementLog } from '../src/infra/json-store.js';
import {
  exampleKeywordPlan,
  exampleKeywordSerp,
  fixtureConfig,
  readFileUtf8,
  setupFixtureWorkdir,
} from './fixtures-helper.js';

test('site validation failure -> improvement log unchanged, site content rolled back', async () => {
  const { dir, siteDir, paths } = await setupFixtureWorkdir();
  try {
    const improvementLogBefore = await readFileUtf8(paths.improvementLog);
    const siteBefore = await readFileUtf8(`${siteDir}/example.md`);

    const config = fixtureConfig();
    const adapters = {
      gsc: null,
      search: new FixtureSearchAdapter({ 'example keyword': exampleKeywordSerp }),
      writer: new StubNaturalWriterAdapter(),
      site: new FixtureSiteAdapter(siteDir, { forceValidationFailure: true }),
    };

    const result = await runSeoLoop(config, paths, adapters, {
      today: '2026-09-10',
      dryRun: false,
      fetchMeasurement: false,
      planOverride: exampleKeywordPlan,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.reportData.validation?.ok, false);

    const improvementLogAfter = await readFileUtf8(paths.improvementLog);
    assert.equal(improvementLogAfter, improvementLogBefore);

    const siteAfter = await readFileUtf8(`${siteDir}/example.md`);
    assert.equal(siteAfter, siteBefore, 'site content must be rolled back to its original text');

    const log = await loadImprovementLog(paths.improvementLog);
    const state = log.keywords.find((k) => k.keyword === 'example keyword');
    assert.equal(state, undefined, 'no action should have been recorded for the failed run');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('successful validation -> action appended and keyword moves to observing', async () => {
  const { dir, siteDir, paths } = await setupFixtureWorkdir();
  try {
    const config = fixtureConfig();
    const adapters = {
      gsc: null,
      search: new FixtureSearchAdapter({ 'example keyword': exampleKeywordSerp }),
      writer: new StubNaturalWriterAdapter(),
      site: new FixtureSiteAdapter(siteDir),
    };

    const result = await runSeoLoop(config, paths, adapters, {
      today: '2026-09-10',
      dryRun: false,
      fetchMeasurement: false,
      planOverride: exampleKeywordPlan,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.reportData.validation?.ok, true);
    assert.equal(result.reportData.selection?.keyword.keyword, 'example keyword');

    const log = await loadImprovementLog(paths.improvementLog);
    const state = log.keywords.find((k) => k.keyword === 'example keyword');
    assert.ok(state, 'a new keyword state should have been created');
    assert.equal(state!.status, 'observing');
    assert.equal(state!.nextReviewDate, '2026-09-17');
    assert.equal(state!.actions.length, 1);
    assert.equal(state!.actions[0]!.changeType, 'intro');

    const siteAfter = await readFileUtf8(`${siteDir}/example.md`);
    assert.match(siteAfter, /example keywordの定義/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
