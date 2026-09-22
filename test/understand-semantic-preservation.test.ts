import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { runUnderstand } from '../src/core/workflow/understand.js';
import { loadSiteUnderstanding, saveSiteUnderstanding } from '../src/infra/json-store.js';
import type { SiteUnderstanding } from '../src/core/types.js';
import { buildFixtureGscAdapter, buildFixtureSiteReader, setupFixtureWorkdir } from './fixtures-helper.js';

const BASE_OPTIONS = {
  baseUrl: 'https://example.com',
  gscProperty: 'sc-domain:example.com',
  today: '2026-09-10',
  dryRun: false,
  gscWindowDays: 28,
  finalDataLagDays: 0,
  gscSource: 'fixture' as const,
};

function existingDoc(overrides: Partial<SiteUnderstanding> = {}): SiteUnderstanding {
  return {
    schemaVersion: 2,
    site: { baseUrl: 'https://example.com' },
    generatedAt: '2026-09-01T00:00:00.000Z',
    pages: [],
    themes: ['既存テーマ1', '既存テーマ2'],
    proprietaryDataNotes: ['既存の独自データ注記'],
    maturity: 'exploring',
    ...overrides,
  };
}

test('understand: no --understanding-file, existing themes/proprietaryDataNotes are retained (not wiped)', async () => {
  const { dir, paths } = await setupFixtureWorkdir();
  try {
    await saveSiteUnderstanding(paths.siteUnderstanding, existingDoc());

    const siteReader = await buildFixtureSiteReader();
    const gsc = await buildFixtureGscAdapter();
    const result = await runUnderstand(paths, siteReader, gsc, { ...BASE_OPTIONS });

    assert.deepEqual(result.siteUnderstanding.themes, ['既存テーマ1', '既存テーマ2']);
    assert.deepEqual(result.siteUnderstanding.proprietaryDataNotes, ['既存の独自データ注記']);

    const persisted = await loadSiteUnderstanding(paths.siteUnderstanding);
    assert.deepEqual(persisted.themes, ['既存テーマ1', '既存テーマ2']);
    assert.deepEqual(persisted.proprietaryDataNotes, ['既存の独自データ注記']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('understand: an explicit --understanding-file override replaces the existing themes/proprietaryDataNotes', async () => {
  const { dir, paths } = await setupFixtureWorkdir();
  try {
    await saveSiteUnderstanding(paths.siteUnderstanding, existingDoc());

    const siteReader = await buildFixtureSiteReader();
    const gsc = await buildFixtureGscAdapter();
    const result = await runUnderstand(paths, siteReader, gsc, {
      ...BASE_OPTIONS,
      understandingOverride: { themes: ['新テーマ'], proprietaryDataNotes: ['新しい独自データ注記'] },
    });

    assert.deepEqual(result.siteUnderstanding.themes, ['新テーマ']);
    assert.deepEqual(result.siteUnderstanding.proprietaryDataNotes, ['新しい独自データ注記']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('understand: first run (no existing site-understanding.json), no override -> themes/proprietaryDataNotes are []', async () => {
  const { dir, paths } = await setupFixtureWorkdir();
  try {
    const siteReader = await buildFixtureSiteReader();
    const gsc = await buildFixtureGscAdapter();
    const result = await runUnderstand(paths, siteReader, gsc, { ...BASE_OPTIONS });

    assert.deepEqual(result.siteUnderstanding.themes, []);
    assert.deepEqual(result.siteUnderstanding.proprietaryDataNotes, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('understand --dry-run: reading existing themes for preservation does not mutate the persisted file', async () => {
  const { dir, paths } = await setupFixtureWorkdir();
  try {
    await saveSiteUnderstanding(paths.siteUnderstanding, existingDoc());
    const before = await readFile(paths.siteUnderstanding, 'utf8');

    const siteReader = await buildFixtureSiteReader();
    const gsc = await buildFixtureGscAdapter();
    const result = await runUnderstand(paths, siteReader, gsc, { ...BASE_OPTIONS, dryRun: true });

    // The in-memory report still reflects preserved themes (dry-run still computes them)...
    assert.deepEqual(result.siteUnderstanding.themes, ['既存テーマ1', '既存テーマ2']);
    // ...but nothing was written back to disk.
    const after = await readFile(paths.siteUnderstanding, 'utf8');
    assert.equal(after, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('understand: rakusetsu-main and pokeca themes are fully isolated (different paths never cross-read each other)', async () => {
  const siteA = await setupFixtureWorkdir();
  const siteB = await setupFixtureWorkdir();
  try {
    await saveSiteUnderstanding(siteA.paths.siteUnderstanding, existingDoc({ themes: ['rakusetsu-mainのテーマ'] }));
    await saveSiteUnderstanding(siteB.paths.siteUnderstanding, existingDoc({ themes: ['pokecaのテーマ'] }));

    const siteReader = await buildFixtureSiteReader();
    const gsc = await buildFixtureGscAdapter();

    const resultA = await runUnderstand(siteA.paths, siteReader, gsc, { ...BASE_OPTIONS });
    assert.deepEqual(resultA.siteUnderstanding.themes, ['rakusetsu-mainのテーマ']);

    // Running site A must not have touched site B's file at all.
    const siteBUnchanged = await loadSiteUnderstanding(siteB.paths.siteUnderstanding);
    assert.deepEqual(siteBUnchanged.themes, ['pokecaのテーマ']);

    const resultB = await runUnderstand(siteB.paths, siteReader, gsc, { ...BASE_OPTIONS });
    assert.deepEqual(resultB.siteUnderstanding.themes, ['pokecaのテーマ']);

    const siteAStillUnchanged = await loadSiteUnderstanding(siteA.paths.siteUnderstanding);
    assert.deepEqual(siteAStillUnchanged.themes, ['rakusetsu-mainのテーマ']);
  } finally {
    await rm(siteA.dir, { recursive: true, force: true });
    await rm(siteB.dir, { recursive: true, force: true });
  }
});
