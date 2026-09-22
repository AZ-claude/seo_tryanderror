import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdApply, cmdDiscover, cmdPropose, cmdReview, cmdStatus } from '../src/cli.js';
import { saveExperiments, saveOpportunities } from '../src/infra/json-store.js';
import type { Experiment, Opportunity } from '../src/core/types.js';

async function writeConfig(dir: string, key: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const configPath = join(dir, `seo.${key}.config.json`);
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 2,
      site: { key, baseUrl: `https://${key}.test`, mode: 'existing', reader: 'http', repoRoot: null, contentRoot: null },
      gsc: {
        property: `sc-domain:${key}.test`,
        credentialsEnv: 'SEO_TEST_GSC_ENV_UNSET',
        defaultWindowDays: 28,
        reviewWindowDays: 7,
        finalDataLagDays: 3,
      },
      experiment: { cooldownDays: 7, maxActiveExperiments: 2 },
      commands: { build: null, test: null },
      adapters: { writer: 'stub', site: 'http-readonly', search: 'fixture' },
      ...overrides,
    }),
    'utf8',
  );
  return configPath;
}

function experiment(id: string, overrides: Partial<Experiment> = {}): Experiment {
  return {
    id,
    opportunityId: `OPP-${id}`,
    hypothesisId: `HYP-${id}`,
    action: { type: 'REVISE', targetPaths: ['/shared-page/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
    measurementPlan: {
      targetPages: ['/shared-page/'],
      targetQueries: ['shared query'],
      primaryMetric: 'impressions',
      secondaryMetrics: ['clicks'],
      baselineWindowDays: 28,
      reviewWindowDays: 28,
    },
    status: 'observing',
    before: null,
    observation: { start: '2026-09-01', end: '2026-09-29', nextReviewDate: '2026-09-29' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    history: [{ at: '2026-09-01T00:00:00.000Z', type: 'observing' }],
    ...overrides,
  };
}

function opportunity(id: string, overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    scope: { type: 'page', path: '/a/' },
    identity: { scopeKey: `page:/a/-${id}`, intentKey: 'content_gap:x' },
    kind: 'content_gap',
    title: id,
    description: 'd',
    evidence: [],
    signals: { hasGscTraction: true, contentGapConfirmed: true, leveragesProprietaryData: false },
    status: 'open',
    history: [],
    ...overrides,
  };
}

async function withWorkdir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), 'seo-multisite-'));
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
}

async function captureLog<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const originalLog = console.log;
  let output = '';
  console.log = (msg?: unknown) => {
    output += `${String(msg)}\n`;
  };
  try {
    const result = await fn();
    return { result, output };
  } finally {
    console.log = originalLog;
  }
}

test('multi-site: state path isolation — site.key routes to data/seo/<key>/, distinct from other sites; real mode refuses to fall back to the legacy no-key path', async () => {
  await withWorkdir(async (dir) => {
    await saveOpportunities(join(dir, 'data/seo/site-a/opportunities.json'), [opportunity('A1')]);
    await saveOpportunities(join(dir, 'data/seo/site-b/opportunities.json'), [opportunity('B1'), opportunity('B2')]);
    await mkdir(join(dir, 'data/seo'), { recursive: true }); // legacy root stays empty

    const configA = await writeConfig(dir, 'site-a');
    const configB = await writeConfig(dir, 'site-b');

    const { output: outA } = await captureLog(() => cmdStatus({ config: configA }));
    assert.match(outA, /openOpportunities: 1/);

    const { output: outB } = await captureLog(() => cmdStatus({ config: configB }));
    assert.match(outB, /openOpportunities: 2/);

    const originalError = console.error;
    let stderr = '';
    console.error = (msg?: unknown) => {
      stderr += `${String(msg)}\n`;
    };
    let exitCode: number;
    try {
      exitCode = await cmdStatus({});
    } finally {
      console.error = originalError;
    }
    assert.equal(exitCode, 1, 'real mode without --config must error, never silently read the legacy unkeyed data/seo/ dir');
    assert.match(stderr, /status requires --config/);
  });
});

test('multi-site: propose in site A ignores site B\'s active-experiment count, and does not trip page/query conflict guards across sites', async () => {
  await withWorkdir(async (dir) => {
    // Site B is already "full" (maxActiveExperiments=2) with an active experiment on the exact
    // same page + targetQueries that site A is about to propose.
    await saveExperiments(join(dir, 'data/seo/site-b/experiments.json'), [
      experiment('B-EXP1'),
      experiment('B-EXP2', { id: 'B-EXP2', action: { type: 'REVISE', targetPaths: ['/other/'], summary: 's', requiredFacts: [], forbiddenChanges: [] }, measurementPlan: { targetPages: ['/other/'], primaryMetric: 'impressions', secondaryMetrics: [], baselineWindowDays: 28, reviewWindowDays: 28 } }),
    ]);
    await saveOpportunities(join(dir, 'data/seo/site-a/opportunities.json'), [opportunity('A1')]);

    const configA = await writeConfig(dir, 'site-a');
    const hypothesisPath = join(dir, 'hypothesis.json');
    await writeFile(
      hypothesisPath,
      JSON.stringify({
        hypothesis: { statement: 's', expectedSignals: ['impressions'], rationale: 'r' },
        action: { type: 'REVISE', targetPaths: ['/shared-page/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
        measurementPlan: {
          targetPages: ['/shared-page/'],
          targetQueries: ['shared query'],
          primaryMetric: 'impressions',
          secondaryMetrics: [],
          baselineWindowDays: 28,
          reviewWindowDays: 28,
        },
      }),
      'utf8',
    );

    const code = await cmdPropose({ config: configA, 'opportunity-id': 'A1', 'hypothesis-file': hypothesisPath });
    assert.equal(code, 0, 'must succeed: site B being at its cap and holding the same page/query must not affect site A');

    const siteAExperiments = JSON.parse(await readFile(join(dir, 'data/seo/site-a/experiments.json'), 'utf8'));
    assert.equal(siteAExperiments.experiments.length, 1);
    const siteBExperiments = JSON.parse(await readFile(join(dir, 'data/seo/site-b/experiments.json'), 'utf8'));
    assert.equal(siteBExperiments.experiments.length, 2, 'site B state must be untouched');
  });
});

test('multi-site: discover in site A does not read or merge with site B\'s opportunities, even with an identical scope/intent identity', async () => {
  await withWorkdir(async (dir) => {
    const sameIdentity = { scopeKey: 'page:/dup/', intentKey: 'ctr_title:x' };
    await saveOpportunities(join(dir, 'data/seo/site-b/opportunities.json'), [
      opportunity('B1', { identity: sameIdentity, status: 'promoted' }),
    ]);

    const configA = await writeConfig(dir, 'site-a');
    const opportunitiesFile = join(dir, 'candidates.json');
    await writeFile(
      opportunitiesFile,
      JSON.stringify({
        opportunities: [
          {
            scope: { type: 'page', path: '/dup/' },
            kind: 'ctr_title',
            intentSlug: 'x',
            title: 'A candidate',
            description: 'd',
            evidence: [],
          },
        ],
      }),
      'utf8',
    );

    const code = await cmdDiscover({ config: configA, 'opportunities-file': opportunitiesFile });
    assert.equal(code, 0);

    const siteA = JSON.parse(await readFile(join(dir, 'data/seo/site-a/opportunities.json'), 'utf8'));
    assert.equal(siteA.opportunities.length, 1, 'site A must create its own Opportunity, unaffected by site B holding the same identity as "promoted"');
    assert.equal(siteA.opportunities[0].status, 'open');

    const siteB = JSON.parse(await readFile(join(dir, 'data/seo/site-b/opportunities.json'), 'utf8'));
    assert.equal(siteB.opportunities[0].status, 'promoted', 'site B state must be untouched');
  });
});

test('multi-site: apply in site A does not touch site B\'s experiments.json', async () => {
  await withWorkdir(async (dir) => {
    await saveExperiments(join(dir, 'data/seo/site-a/experiments.json'), [experiment('A-EXP1', { status: 'proposed', observation: undefined, history: [{ at: '2026-09-01T00:00:00.000Z', type: 'proposed' }] })]);
    await saveExperiments(join(dir, 'data/seo/site-b/experiments.json'), [experiment('B-EXP1')]);
    const siteBBefore = await readFile(join(dir, 'data/seo/site-b/experiments.json'), 'utf8');

    const configA = await writeConfig(dir, 'site-a');
    const evidenceFile = join(dir, 'evidence.json');
    await writeFile(
      evidenceFile,
      JSON.stringify({
        targetPage: '/shared-page/',
        siteRepo: 'org/repo',
        changedFiles: ['a.astro'],
        actionSummary: 's',
        commitSha: 'abc123',
        commitBranch: 'main',
        bReview: { tool: 't', claimPreservation: { preserved: 1, modified: 0, invented: 0 } },
        siteValidation: { lintContent: 'PASS', build: 'PASS' },
        deployMethod: 'manual',
        liveVerification: { httpStatus: 200, sectionPresent: true, existingSectionsIntact: [], canonicalUnchanged: true, noindexUnchanged: true },
      }),
      'utf8',
    );

    const code = await cmdApply({ config: configA, 'experiment-id': 'A-EXP1', 'evidence-file': evidenceFile });
    assert.equal(code, 0);

    const siteA = JSON.parse(await readFile(join(dir, 'data/seo/site-a/experiments.json'), 'utf8'));
    assert.equal(siteA.experiments[0].status, 'observing');
    const siteBAfter = await readFile(join(dir, 'data/seo/site-b/experiments.json'), 'utf8');
    assert.equal(siteBAfter, siteBBefore, 'site B experiments.json must be byte-identical after site A apply');
  });
});

test('multi-site: review in site A cannot see an experiment id that only exists in site B', async () => {
  await withWorkdir(async (dir) => {
    await saveExperiments(join(dir, 'data/seo/site-a/experiments.json'), [experiment('A-EXP1', { observation: { start: '2026-09-09', end: '2026-10-07', nextReviewDate: '2026-10-07' } })]);
    await saveExperiments(join(dir, 'data/seo/site-b/experiments.json'), [experiment('B-EXP1', { observation: { start: '2026-09-09', end: '2026-10-07', nextReviewDate: '2026-10-07' } })]);

    const configA = await writeConfig(dir, 'site-a', { experiment: { cooldownDays: 7 } });

    const { result: foundOwn } = await captureLog(() =>
      cmdReview({ config: configA, 'experiment-id': 'A-EXP1', 'dump-inputs': true, date: '2026-09-09' }),
    );
    assert.equal(foundOwn, 0, 'site A must see its own experiment (elapsedDays=0, no checkpoint due, no GSC call needed)');

    const { result: crossSite } = await captureLog(() =>
      cmdReview({ config: configA, 'experiment-id': 'B-EXP1', 'dump-inputs': true, date: '2026-09-09' }),
    );
    assert.equal(crossSite, 1, 'site B\'s experiment id must be invisible when using site A\'s config');
  });
});

test('multi-site: a fresh lock in site B does not block a run in site A (locks are per-state-dir)', async () => {
  await withWorkdir(async (dir) => {
    await mkdir(join(dir, 'data/seo/site-b'), { recursive: true });
    await writeFile(join(dir, 'data/seo/site-b/.run.lock'), JSON.stringify({ pid: 1, startedAt: new Date().toISOString() }), 'utf8');

    const configA = await writeConfig(dir, 'site-a');
    const opportunitiesFile = join(dir, 'candidates.json');
    await writeFile(opportunitiesFile, JSON.stringify({ opportunities: [] }), 'utf8');

    const code = await cmdDiscover({ config: configA, 'opportunities-file': opportunitiesFile });
    assert.equal(code, 0, 'site A run must not be blocked by a lock held under site B\'s state dir');
  });
});

test('multi-site: reports are namespaced under reports/<site.key>/, not shared across sites', async () => {
  await withWorkdir(async (dir) => {
    const configA = await writeConfig(dir, 'site-a');
    const configB = await writeConfig(dir, 'site-b');
    const opportunitiesFile = join(dir, 'candidates.json');
    await writeFile(opportunitiesFile, JSON.stringify({ opportunities: [] }), 'utf8');

    await cmdDiscover({ config: configA, 'opportunities-file': opportunitiesFile });
    const reportsA = await stat(join(dir, 'reports/site-a')).then(() => true, () => false);
    const reportsBBeforeB = await stat(join(dir, 'reports/site-b')).then(() => true, () => false);
    assert.equal(reportsA, true);
    assert.equal(reportsBBeforeB, false, 'site B report dir must not exist yet — site A discover must not create it');

    await cmdDiscover({ config: configB, 'opportunities-file': opportunitiesFile });
    const reportsB = await stat(join(dir, 'reports/site-b')).then(() => true, () => false);
    assert.equal(reportsB, true);
  });
});
