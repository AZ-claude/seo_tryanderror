import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMeasurements, normalizeQuery } from '../src/adapters/gsc.js';
import type { KeywordRecord } from '../src/core/types.js';

test('normalizeQuery: NFKC-normalizes full-width characters', () => {
  assert.equal(normalizeQuery('ＳＥＯ改善'), normalizeQuery('SEO改善'));
});

test('normalizeQuery: lowercases', () => {
  assert.equal(normalizeQuery('Example Keyword'), normalizeQuery('example keyword'));
});

test('normalizeQuery: strips whitespace', () => {
  assert.equal(normalizeQuery('example   keyword'), normalizeQuery('examplekeyword'));
});

const watchwords: KeywordRecord[] = [{ keyword: 'example keyword', targetPath: '/example/', priority: 'high' }];

test('buildMeasurements: matches a watchword via normalized query', () => {
  const { measurements, unregisteredQueries } = buildMeasurements({
    rows: [{ keys: ['  Example   Keyword  '], clicks: 5, impressions: 100, position: 4.2 }],
    watchwords,
  });
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0]!.keyword, 'example keyword');
  assert.equal(measurements[0]!.rank, 4.2);
  assert.equal(unregisteredQueries.length, 0);
});

test('buildMeasurements: unmatched high-impression query becomes a suggestion', () => {
  const { measurements, unregisteredQueries } = buildMeasurements({
    rows: [{ keys: ['unrelated query'], clicks: 1, impressions: 25, position: 8 }],
    watchwords,
  });
  assert.equal(measurements.length, 0);
  assert.equal(unregisteredQueries.length, 1);
  assert.equal(unregisteredQueries[0]!.query, 'unrelated query');
});

test('buildMeasurements: unmatched low-impression query is dropped, not persisted', () => {
  const { unregisteredQueries } = buildMeasurements({
    rows: [{ keys: ['rare query'], clicks: 0, impressions: 3, position: 40 }],
    watchwords,
  });
  assert.equal(unregisteredQueries.length, 0);
});

test('buildMeasurements: unregistered queries sorted by impressions desc, capped at 20', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    keys: [`query-${i}`],
    clicks: 0,
    impressions: i + 10,
    position: 50,
  }));
  const { unregisteredQueries } = buildMeasurements({ rows, watchwords });
  assert.equal(unregisteredQueries.length, 20);
  assert.equal(unregisteredQueries[0]!.query, 'query-24');
  assert.ok(unregisteredQueries[0]!.impressions >= unregisteredQueries[1]!.impressions);
});
