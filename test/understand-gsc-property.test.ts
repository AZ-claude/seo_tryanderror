import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { runUnderstand } from '../src/core/workflow/understand.js';
import type { GscAdapter } from '../src/core/types.js';
import { buildFixtureSiteReader, setupFixtureWorkdir } from './fixtures-helper.js';

test('understand: GSC adapter receives config.gsc.property, never site.baseUrl', async () => {
  const { dir, paths } = await setupFixtureWorkdir();
  try {
    const siteReader = await buildFixtureSiteReader();
    const receivedProperties: string[] = [];
    const recordingGsc: GscAdapter = {
      async fetchQueryPageMatrix(input) {
        receivedProperties.push(input.property);
        return { rows: [] };
      },
    };

    const baseUrl = 'https://example.com';
    const gscProperty = 'sc-domain:example.com';
    assert.notEqual(baseUrl, gscProperty, 'test fixture must exercise distinct baseUrl/gscProperty values');

    await runUnderstand(paths, siteReader, recordingGsc, {
      baseUrl,
      gscProperty,
      today: '2026-09-10',
      dryRun: true,
      gscWindowDays: 28,
      finalDataLagDays: 0,
      gscSource: 'fixture',
    });

    assert.deepEqual(receivedProperties, [gscProperty]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
