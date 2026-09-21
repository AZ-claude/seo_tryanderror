import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { loadExperiments, loadOpportunities } from '../src/infra/json-store.js';
import { prioritizeOpportunities } from '../src/core/prioritize.js';
import { runApply } from '../src/core/workflow/apply.js';
import { dumpDiscoverInputs, runDiscover } from '../src/core/workflow/discover.js';
import { runPropose } from '../src/core/workflow/propose.js';
import { dumpReviewInputs, runReviewDecision } from '../src/core/workflow/review.js';
import { runUnderstand } from '../src/core/workflow/understand.js';
import { buildFixtureSiteReader, setupFixtureWorkdir } from './fixtures-helper.js';
import type { ApplyEvidence, DiscoverOpportunityInput, GscAdapter, GscSummaryRow } from '../src/core/types.js';

/** One row per (page, query) per day in [2026-08-01, 2026-09-30], filtered to the requested window. */
function dailyGscAdapter(perDay: Array<{ page: string; query: string; impressions: number; clicks: number; position: number }>): GscAdapter {
  return {
    async fetchQueryPageMatrix(input) {
      const rows: GscSummaryRow[] = [];
      for (let d = new Date('2026-08-01T00:00:00Z'); d <= new Date('2026-09-30T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
        const date = d.toISOString().slice(0, 10);
        if (date < input.startDate || date > input.endDate) continue;
        for (const p of perDay) {
          rows.push({ query: p.query, page: p.page, clicks: p.clicks, impressions: p.impressions, ctr: p.clicks / p.impressions, position: p.position });
        }
      }
      return { rows };
    },
  };
}

const gsc = dailyGscAdapter([
  { page: '/example/', query: 'example keyword', impressions: 20, clicks: 2, position: 8 },
  { page: '/second/', query: 'second page topic', impressions: 15, clicks: 1, position: 10 },
]);

function opportunityInput(overrides: Partial<DiscoverOpportunityInput>): DiscoverOpportunityInput {
  return {
    scope: { type: 'page', path: '/example/' },
    kind: 'content_gap',
    intentSlug: 'default-slug',
    title: 'default title',
    description: 'default description',
    evidence: [
      { source: 'gsc_query', summary: 'traction', collectedAt: '2026-09-01T00:00:00.000Z' },
      { source: 'serp', summary: 'gap confirmed', collectedAt: '2026-09-01T00:00:00.000Z' },
    ],
    ...overrides,
  };
}

function applyEvidence(overrides: Partial<ApplyEvidence>): ApplyEvidence {
  return {
    targetPage: 'https://example.com/example/',
    siteRepo: 'org/site',
    changedFiles: ['src/pages/example.astro'],
    actionSummary: 'applied',
    commitSha: 'sha1',
    commitBranch: 'master',
    bReview: { tool: 'seo_japanese', claimPreservation: { preserved: 1, modified: 0, invented: 0 } },
    siteValidation: { lintContent: 'PASS', build: 'PASS' },
    deployMethod: 'wrangler pages deploy',
    liveVerification: {
      httpStatus: 200,
      sectionPresent: true,
      existingSectionsIntact: ['existing'],
      canonicalUnchanged: true,
      noindexUnchanged: true,
    },
    ...overrides,
  };
}

test('fixture E2E: rolling parallel PDCA — propose A, apply A, propose B (different page, allowed), block C (same page as B), checkpoint+conclude A, release A, learning A visible to discover', async () => {
  const { dir, paths } = await setupFixtureWorkdir();
  try {
    const siteReader = await buildFixtureSiteReader();

    // 1. understand
    await runUnderstand(paths, siteReader, gsc, {
      baseUrl: 'https://example.com',
      gscProperty: 'sc-domain:example.com',
      today: '2026-09-01',
      dryRun: false,
      gscWindowDays: 28,
      finalDataLagDays: 0,
      gscSource: 'gsc',
    });

    // 2. discover: Opportunity A on /example/, Opportunity B on /second/
    const discoverResult = await runDiscover(
      paths,
      [
        opportunityInput({ scope: { type: 'page', path: '/example/' }, intentSlug: 'opp-a-intent', title: 'Opportunity A' }),
        opportunityInput({ scope: { type: 'page', path: '/second/' }, intentSlug: 'opp-b-intent', title: 'Opportunity B' }),
      ],
      '2026-09-01T00:00:00.000Z',
      false,
    );
    assert.equal(discoverResult.opportunities.length, 2);
    const oppA = discoverResult.opportunities.find((o) => o.title === 'Opportunity A')!;
    const oppB = discoverResult.opportunities.find((o) => o.title === 'Opportunity B')!;

    // 3. prioritize: both open and ranked
    const prioritized = prioritizeOpportunities({ opportunities: discoverResult.opportunities, experiments: [] });
    assert.equal(prioritized.ranked.length, 2);

    // 4. propose A
    const proposeA = await runPropose(paths, {
      opportunityId: oppA.id,
      input: {
        hypothesis: { statement: 'adding a definition helps', expectedSignals: ['impressions'], rationale: 'r' },
        action: { type: 'REVISE', targetPaths: ['/example/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
        measurementPlan: {
          targetPages: ['/example/'],
          targetQueries: ['example keyword'],
          primaryMetric: 'impressions',
          secondaryMetrics: ['clicks', 'position'],
          baselineWindowDays: 28,
          reviewWindowDays: 28,
          minimumImpressions: 5,
        },
      },
      today: '2026-09-01',
      now: '2026-09-01T00:00:00.000Z',
      finalDataLagDays: 0,
      metricsSource: 'gsc',
      maxActiveExperiments: 3,
      dryRun: false,
    });
    assert.equal(proposeA.exitCode, 0);
    const experimentAId = (await loadExperiments(paths.experiments)).find((e) => e.opportunityId === oppA.id)!.id;

    // 5. apply A -> observing, observation.start = 2026-09-01
    const applyA = await runApply(paths, {
      experimentId: experimentAId,
      evidence: applyEvidence({ targetPage: '/example/' }),
      today: '2026-09-01',
      now: '2026-09-01T00:00:00.000Z',
      dryRun: false,
    });
    assert.equal(applyA.exitCode, 0);
    let experiments = await loadExperiments(paths.experiments);
    assert.equal(experiments.find((e) => e.id === experimentAId)!.status, 'observing');

    // 6. propose B (different page) — allowed to run in parallel with A still observing
    const proposeB = await runPropose(paths, {
      opportunityId: oppB.id,
      input: {
        hypothesis: { statement: 'h', expectedSignals: ['impressions'], rationale: 'r' },
        action: { type: 'REVISE', targetPaths: ['/second/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
        measurementPlan: {
          targetPages: ['/second/'],
          targetQueries: ['second page topic'],
          primaryMetric: 'impressions',
          secondaryMetrics: ['clicks'],
          baselineWindowDays: 28,
          reviewWindowDays: 28,
        },
      },
      today: '2026-09-01',
      now: '2026-09-01T00:00:01.000Z',
      finalDataLagDays: 0,
      metricsSource: 'gsc',
      maxActiveExperiments: 3,
      dryRun: false,
    });
    assert.equal(proposeB.exitCode, 0, 'Experiment B on a different page must be allowed while A is active');

    // 7. Opportunity C targets the SAME page as B (still active) -> page-conflict guard rejects it
    const discoverC = await runDiscover(
      paths,
      [opportunityInput({ scope: { type: 'page', path: '/second/' }, intentSlug: 'opp-c-intent', title: 'Opportunity C' })],
      '2026-09-01T00:00:02.000Z',
      false,
    );
    const oppC = discoverC.opportunities.find((o) => o.title === 'Opportunity C')!;
    const proposeC = await runPropose(paths, {
      opportunityId: oppC.id,
      input: {
        hypothesis: { statement: 'h', expectedSignals: ['clicks'], rationale: 'r' },
        action: { type: 'REVISE', targetPaths: ['/second/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
        measurementPlan: {
          targetPages: ['/second/'],
          primaryMetric: 'clicks',
          secondaryMetrics: [],
          baselineWindowDays: 28,
          reviewWindowDays: 28,
        },
      },
      today: '2026-09-01',
      now: '2026-09-01T00:00:03.000Z',
      finalDataLagDays: 0,
      metricsSource: 'gsc',
      maxActiveExperiments: 3,
      dryRun: false,
    });
    assert.equal(proposeC.exitCode, 1, 'Opportunity C targets the same page as active Experiment B and must be blocked');
    assert.match(proposeC.report, /ACTIVE_PAGE_EXPERIMENT_EXISTS|already have an active Experiment/i);

    // 8. checkpoint A: elapsed 4 days since observation.start (2026-09-01) -> tier 3 due
    const dump = await dumpReviewInputs(experiments, gsc, {
      experimentId: experimentAId,
      property: 'sc-domain:example.com',
      today: '2026-09-05',
      finalDataLagDays: 0,
      now: '2026-09-05T00:00:00.000Z',
    });
    assert.ok(!('error' in dump));
    assert.equal(dump.checkpoint, 3);
    assert.ok(dump.comparison);
    assert.equal(dump.sufficientData, true, 'minimumImpressions=5 vs 3 days * 20 impressions/day should be sufficient');
    assert.equal(dump.canConclude, true);

    // 9. review A -> conclude, with a learning
    const reviewA = await runReviewDecision(paths, gsc, {
      experimentId: experimentAId,
      property: 'sc-domain:example.com',
      today: '2026-09-05',
      finalDataLagDays: 0,
      now: '2026-09-05T00:00:00.000Z',
      decisionInput: {
        decision: 'conclude',
        proposedOutcome: 'hypothesis_supported',
        note: 'impressions held up post-change',
        learning: 'adding an upfront definition on /example/ sustained impressions',
      },
      dryRun: false,
    });
    assert.equal(reviewA.exitCode, 0);

    experiments = await loadExperiments(paths.experiments);
    const finalA = experiments.find((e) => e.id === experimentAId)!;
    assert.equal(finalA.status, 'concluded');
    assert.equal(finalA.result!.outcome, 'hypothesis_supported');
    assert.equal(finalA.learning, 'adding an upfront definition on /example/ sustained impressions');

    // 10. Opportunity A released back to open (no other active Experiment references it)
    const opportunitiesAfter = await loadOpportunities(paths.opportunities);
    assert.equal(opportunitiesAfter.find((o) => o.id === oppA.id)!.status, 'open');
    // B is still active and untouched
    assert.equal(opportunitiesAfter.find((o) => o.id === oppB.id)!.status, 'promoted');

    // 11. discover --dump-inputs surfaces A's learning as bounded experimentMemory
    const discoverDump = await dumpDiscoverInputs(paths);
    assert.equal(discoverDump.experimentMemory.length, 1);
    assert.equal(discoverDump.experimentMemory[0]!.experimentId, experimentAId);
    assert.equal(discoverDump.experimentMemory[0]!.outcome, 'hypothesis_supported');
    assert.equal(discoverDump.experimentMemory[0]!.learning, 'adding an upfront definition on /example/ sustained impressions');

    // 12. now that A is concluded (no longer active), a NEW Opportunity on /example/ is no longer blocked
    const discoverD = await runDiscover(
      paths,
      [opportunityInput({ scope: { type: 'page', path: '/example/' }, intentSlug: 'opp-d-intent', title: 'Opportunity D' })],
      '2026-09-05T00:00:04.000Z',
      false,
    );
    const oppD = discoverD.opportunities.find((o) => o.title === 'Opportunity D')!;
    const proposeD = await runPropose(paths, {
      opportunityId: oppD.id,
      input: {
        hypothesis: { statement: 'h', expectedSignals: ['impressions'], rationale: 'r' },
        action: { type: 'REVISE', targetPaths: ['/example/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
        measurementPlan: {
          targetPages: ['/example/'],
          primaryMetric: 'impressions',
          secondaryMetrics: [],
          baselineWindowDays: 28,
          reviewWindowDays: 28,
        },
      },
      today: '2026-09-05',
      now: '2026-09-05T00:00:05.000Z',
      finalDataLagDays: 0,
      metricsSource: 'gsc',
      maxActiveExperiments: 3,
      dryRun: false,
    });
    assert.equal(proposeD.exitCode, 0, 'page /example/ is free again once A concluded');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
