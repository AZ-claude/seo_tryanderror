import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { buildGscEvidence, dumpDiscoverInputs } from '../src/core/workflow/discover.js';
import { runUnderstand } from '../src/core/workflow/understand.js';
import { appendRankHistory } from '../src/infra/json-store.js';
import type { RankHistoryEntry } from '../src/core/types.js';
import { buildFixtureSiteReader, setupFixtureWorkdir } from './fixtures-helper.js';

function gscRow(query: string, impressions: number) {
  return { query, page: '/p/', clicks: 0, impressions, ctr: 0, position: 10 };
}

test('buildGscEvidence: low-impression rows (1-9) are preserved, no impressions floor', () => {
  const entries: RankHistoryEntry[] = [
    {
      date: '2026-09-18',
      source: 'gsc',
      window: { start: '2026-08-21', end: '2026-09-18', days: 28 },
      rows: [gscRow('a', 12), gscRow('b', 7), gscRow('c', 2), gscRow('d', 1)],
    },
  ];
  const evidence = buildGscEvidence(entries);
  assert.ok(evidence);
  assert.equal(evidence!.rows.length, 4);
  assert.deepEqual(
    evidence!.rows.map((r) => r.impressions),
    [12, 7, 2, 1],
  );
});

test('buildGscEvidence: only the latest gsc snapshot is used, not a merge of older ones', () => {
  const entries: RankHistoryEntry[] = [
    { date: '2026-08-01', source: 'gsc', rows: [gscRow('old', 99)] },
    { date: '2026-09-18', source: 'gsc', rows: [gscRow('new', 5)] },
  ];
  const evidence = buildGscEvidence(entries);
  assert.ok(evidence);
  assert.equal(evidence!.rows.length, 1);
  assert.equal(evidence!.rows[0]!.query, 'new');
});

test('buildGscEvidence: non-gsc sources (fixture/manual/websearch) are excluded', () => {
  const entries: RankHistoryEntry[] = [
    { date: '2026-09-19', source: 'fixture', rows: [gscRow('should-not-appear', 50)] },
    { date: '2026-09-10', source: 'manual', rows: [gscRow('also-not', 40)] },
    { date: '2026-09-05', source: 'gsc', rows: [gscRow('real', 3)] },
  ];
  const evidence = buildGscEvidence(entries);
  assert.ok(evidence);
  assert.equal(evidence!.rows.length, 1);
  assert.equal(evidence!.rows[0]!.query, 'real');
});

test('buildGscEvidence: no gsc entries at all -> undefined', () => {
  const entries: RankHistoryEntry[] = [{ date: '2026-09-19', source: 'fixture', rows: [gscRow('x', 1)] }];
  assert.equal(buildGscEvidence(entries), undefined);
});

test('buildGscEvidence: bounded to 500 rows, sorted by impressions descending', () => {
  const rows = Array.from({ length: 600 }, (_, i) => gscRow(`q${i}`, i + 1));
  const entries: RankHistoryEntry[] = [{ date: '2026-09-19', source: 'gsc', rows }];
  const evidence = buildGscEvidence(entries);
  assert.ok(evidence);
  assert.equal(evidence!.rows.length, 500);
  assert.equal(evidence!.rows[0]!.impressions, 600);
  assert.equal(evidence!.rows[499]!.impressions, 101);
});

test('dumpDiscoverInputs: gscEvidence is wired end-to-end from rank-history.json, and dump-inputs makes no persistent writes', async () => {
  const { dir, paths } = await setupFixtureWorkdir();
  try {
    const siteReader = await buildFixtureSiteReader();
    await runUnderstand(paths, siteReader, null, {
      baseUrl: 'https://example.com',
      gscProperty: 'sc-domain:example.com',
      today: '2026-09-10',
      dryRun: false,
      gscWindowDays: 28,
      finalDataLagDays: 0,
      gscSource: 'fixture',
    });

    await appendRankHistory(paths.rankHistory, {
      date: '2026-09-18',
      source: 'gsc',
      window: { start: '2026-08-21', end: '2026-09-18', days: 28 },
      rows: [gscRow('low-traffic query', 2)],
    });

    const opportunitiesExistedBefore = await stat(paths.opportunities).then(
      () => true,
      () => false,
    );
    const opportunitiesBefore = opportunitiesExistedBefore ? await readFile(paths.opportunities, 'utf8') : null;

    const dump = await dumpDiscoverInputs(paths);

    assert.ok(dump.gscEvidence);
    assert.equal(dump.gscEvidence!.rows.length, 1);
    assert.equal(dump.gscEvidence!.rows[0]!.query, 'low-traffic query');
    assert.equal(dump.gscEvidence!.rows[0]!.impressions, 2);
    assert.deepEqual(dump.gscEvidence!.window, { start: '2026-08-21', end: '2026-09-18', days: 28 });

    const opportunitiesAfter = opportunitiesExistedBefore ? await readFile(paths.opportunities, 'utf8') : null;
    assert.equal(opportunitiesAfter, opportunitiesBefore, 'discover --dump-inputs must not mutate opportunities.json');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
