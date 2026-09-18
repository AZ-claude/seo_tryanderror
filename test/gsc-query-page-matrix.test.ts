import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapQueryPageRows, normalizeQuery } from '../src/adapters/gsc.js';

test('normalizeQuery: NFKC-normalizes full-width characters', () => {
  assert.equal(normalizeQuery('ＳＥＯ改善'), normalizeQuery('SEO改善'));
});

test('normalizeQuery: lowercases', () => {
  assert.equal(normalizeQuery('Example Keyword'), normalizeQuery('example keyword'));
});

test('normalizeQuery: strips whitespace', () => {
  assert.equal(normalizeQuery('example   keyword'), normalizeQuery('examplekeyword'));
});

test('mapQueryPageRows: maps query+page dimension rows without any watchword filtering', () => {
  const rows = mapQueryPageRows([
    { keys: ['example keyword', '/example/'], clicks: 5, impressions: 100, ctr: 0.05, position: 4.2 },
    { keys: ['unrelated query', '/other/'], clicks: 1, impressions: 3, ctr: 0.33, position: 40 },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { query: 'example keyword', page: '/example/', clicks: 5, impressions: 100, ctr: 0.05, position: 4.2 });
  assert.deepEqual(rows[1], { query: 'unrelated query', page: '/other/', clicks: 1, impressions: 3, ctr: 0.33, position: 40 });
});

test('mapQueryPageRows: missing page dimension maps to null', () => {
  const rows = mapQueryPageRows([{ keys: ['query only'], clicks: 0, impressions: 1, ctr: 0, position: 50 }]);
  assert.equal(rows[0]!.page, null);
});
