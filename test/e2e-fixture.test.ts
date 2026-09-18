import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { loadOpportunities, loadExperiments } from '../src/infra/json-store.js';
import { prioritizeOpportunities } from '../src/core/prioritize.js';
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

test('fixture E2E: understand -> discover -> prioritize -> propose produces a proposed Experiment and reports', async () => {
  const { dir, paths } = await setupFixtureWorkdir();
  try {
    const siteReader = await buildFixtureSiteReader();
    const gsc = await buildFixtureGscAdapter();

    // 1. understand
    const understandResult = await runUnderstand(paths, siteReader, gsc, {
      baseUrl: 'https://example.com',
      gscProperty: 'sc-domain:example.com',
      today: '2026-09-10',
      dryRun: false,
      gscWindowDays: 28,
      finalDataLagDays: 0,
      gscSource: 'fixture',
    });
    assert.equal(understandResult.siteUnderstanding.pages.length, 2);
    assert.ok(understandResult.siteUnderstanding.gscSummary);
    assert.match(understandResult.report, /pages read: 2/);

    // 2. discover
    const discoverInput = await loadFixtureDiscoverInput();
    const discoverResult = await runDiscover(paths, discoverInput.opportunities, '2026-09-10T00:00:00.000Z', false);
    assert.equal(discoverResult.opportunities.length, 1);
    const opportunity = discoverResult.opportunities[0]!;
    assert.equal(opportunity.status, 'open');
    assert.equal(opportunity.signals.hasGscTraction, true);
    assert.equal(opportunity.signals.contentGapConfirmed, true);
    assert.match(discoverResult.report, /New Opportunities \(1\)/);

    // 3. prioritize
    const experimentsBeforePropose = await loadExperiments(paths.experiments);
    const prioritized = prioritizeOpportunities({ opportunities: discoverResult.opportunities, experiments: experimentsBeforePropose });
    assert.equal(prioritized.ranked.length, 1);
    assert.equal(prioritized.ranked[0]!.id, opportunity.id);

    // 4. propose
    const proposeInput = await loadFixtureProposeInput();
    const proposeResult = await runPropose(paths, {
      opportunityId: opportunity.id,
      input: proposeInput,
      today: '2026-09-10',
      now: '2026-09-10T00:00:00.000Z',
      finalDataLagDays: 0,
      metricsSource: 'fixture',
      dryRun: false,
    });
    assert.equal(proposeResult.exitCode, 0);
    assert.match(proposeResult.report, /propose report/);

    const experimentsAfter = await loadExperiments(paths.experiments);
    assert.equal(experimentsAfter.length, 1);
    assert.equal(experimentsAfter[0]!.status, 'proposed');
    assert.ok(experimentsAfter[0]!.before, 'before snapshot should be sufficient given fixture GSC data');
    assert.equal(experimentsAfter[0]!.before!.metrics.impressions, 500);

    const opportunitiesAfter = await loadOpportunities(paths.opportunities);
    assert.equal(opportunitiesAfter.find((o) => o.id === opportunity.id)!.status, 'promoted');

    // Active experiment guard: proposing again for the same opportunity must be rejected.
    const secondProposeResult = await runPropose(paths, {
      opportunityId: opportunity.id,
      input: proposeInput,
      today: '2026-09-11',
      now: '2026-09-11T00:00:00.000Z',
      finalDataLagDays: 0,
      metricsSource: 'fixture',
      dryRun: false,
    });
    assert.equal(secondProposeResult.exitCode, 1);
    const experimentsAfterSecondAttempt = await loadExperiments(paths.experiments);
    assert.equal(experimentsAfterSecondAttempt.length, 1, 'guard must prevent a second Experiment from being created');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
