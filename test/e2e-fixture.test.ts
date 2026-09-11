import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runSeoLoop } from '../src/core/run.js';
import { FixtureSiteAdapter } from '../src/adapters/site.js';
import { StubNaturalWriterAdapter } from '../src/adapters/natural-writer.js';
import { loadSerpFromFile } from '../src/adapters/search.js';
import { seoPlanSchema } from '../src/core/schemas.js';
import { loadImprovementLog, readJsonFile } from '../src/infra/json-store.js';
import { fixtureConfig, readFileUtf8, setupFixtureWorkdir } from './fixtures-helper.js';

const REPO_ROOT = process.cwd();

test('fixture E2E: measure -> select A only -> plan -> write -> validate -> observe; B and C untouched', async () => {
  const { dir, siteDir, paths } = await setupFixtureWorkdir();
  try {
    // "fixture SERPを読む" / "fixture planを読む": load from checked-in fixture files, not inline literals.
    const serp = await loadSerpFromFile(join(REPO_ROOT, 'fixtures/search/example-keyword.json'));
    const plan = await readJsonFile(join(REPO_ROOT, 'fixtures/plan/example-keyword.json'), seoPlanSchema);

    const improvementLogBefore = await loadImprovementLog(paths.improvementLog);
    const secondKeywordBefore = improvementLogBefore.keywords.find((k) => k.keyword === 'second keyword');
    const achievedKeywordBefore = improvementLogBefore.keywords.find((k) => k.keyword === 'achieved keyword');

    const config = fixtureConfig();
    const adapters = {
      gsc: null,
      search: { inspectSerp: async () => serp }, // fixture SERP loaded from file, injected directly
      writer: new StubNaturalWriterAdapter(),
      site: new FixtureSiteAdapter(siteDir),
    };

    const result = await runSeoLoop(config, paths, adapters, {
      today: '2026-09-10',
      dryRun: false,
      fetchMeasurement: false,
      planOverride: plan,
    });

    // report生成
    assert.ok(result.report.length > 0);
    assert.match(result.report, /Selected keyword/);

    // Aのみ選択
    assert.equal(result.reportData.selection?.keyword.keyword, 'example keyword');

    // validate pass
    assert.equal(result.reportData.validation?.ok, true);
    assert.equal(result.exitCode, 0);

    // fixture siteに反映 (stub writerが変更)
    const siteAfter = await readFileUtf8(`${siteDir}/example.md`);
    assert.match(siteAfter, /example keywordの定義/);

    const logAfter = await loadImprovementLog(paths.improvementLog);

    // Aがobserving、nextReviewDateが設定、action 1件
    const stateA = logAfter.keywords.find((k) => k.keyword === 'example keyword');
    assert.ok(stateA);
    assert.equal(stateA!.status, 'observing');
    assert.equal(stateA!.nextReviewDate, '2026-09-17');
    assert.equal(stateA!.actions.length, 1);

    // B untouched
    const stateB = logAfter.keywords.find((k) => k.keyword === 'second keyword');
    assert.deepEqual(stateB, secondKeywordBefore);

    // C untouched
    const stateC = logAfter.keywords.find((k) => k.keyword === 'achieved keyword');
    assert.deepEqual(stateC, achievedKeywordBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
