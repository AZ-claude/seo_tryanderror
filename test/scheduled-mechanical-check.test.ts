import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();

function runPython(input: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('python3', [join(REPO_ROOT, 'scripts/lib/parse_checkpoint.py')], {
    input,
    encoding: 'utf8',
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
}

test('parse_checkpoint.py: checkpoint=null -> NOT_DUE, exit 0', () => {
  const { stdout, status } = runPython(JSON.stringify({ checkpoint: null, other: 1 }));
  assert.equal(status, 0);
  assert.equal(stdout, 'NOT_DUE');
});

test('parse_checkpoint.py: checkpoint=3 -> DUE, exit 0', () => {
  const { stdout, status } = runPython(JSON.stringify({ checkpoint: 3 }));
  assert.equal(status, 0);
  assert.equal(stdout, 'DUE');
});

test('parse_checkpoint.py: malformed (non-JSON) input -> exit 2, not silently NOT_DUE', () => {
  const { status, stderr } = runPython('this is not json at all');
  assert.equal(status, 2);
  assert.match(stderr, /malformed JSON/);
});

test('parse_checkpoint.py: a structured {"error": ...} response (e.g. non-observing Experiment) -> exit 2, not silently NOT_DUE', () => {
  const { status, stderr } = runPython(JSON.stringify({ error: 'no Experiment found with id X' }));
  assert.equal(status, 2);
  assert.match(stderr, /returned an error/);
});

test('parse_checkpoint.py: valid JSON missing the checkpoint key entirely -> exit 2', () => {
  const { status, stderr } = runPython(JSON.stringify({ unrelated: true }));
  assert.equal(status, 2);
  assert.match(stderr, /no top-level "checkpoint" key/);
});

// --- scheduled-mechanical-check.sh, run against a fully isolated temp copy ---
// (the real script's `cd "$(dirname "$0")/.."` means it always treats its
// own script directory's parent as repo root, so copying it into a temp
// tree makes it operate entirely inside that tree — never the real repo's
// config/data.)

const FAKE_CLI = `#!/usr/bin/env bash
# Minimal double for \`tsx src/cli.ts <command> --config <path> [--experiment-id <id> --dump-inputs]\`.
cmd="$2"
config_path=""
exp_id=""
prev=""
for arg in "$@"; do
  case "$prev" in
    --config) config_path="$arg" ;;
    --experiment-id) exp_id="$arg" ;;
  esac
  prev="$arg"
done
base="$(basename "$config_path")"

case "$cmd" in
  understand)
    for failbase in $FAKE_UNDERSTAND_FAIL_SITES; do
      if [ "$base" = "$failbase" ]; then
        echo "fake understand: simulated failure for $base" >&2
        exit 1
      fi
    done
    echo "fake understand ok for $base"
    exit 0
    ;;
  review)
    output_file="$FAKE_REVIEW_OUTPUT_DIR/\${base}__\${exp_id}.json"
    if [ -f "$output_file" ]; then
      cat "$output_file"
    else
      echo '{"checkpoint": null}'
    fi
    exit 0
    ;;
  *)
    echo "fake-cli: unknown command $cmd" >&2
    exit 1
    ;;
esac
`;

async function setupScriptSandbox(): Promise<{ dir: string; scriptPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'seo-scheduled-check-'));
  await mkdir(join(dir, 'scripts/lib'), { recursive: true });
  await mkdir(join(dir, 'config'), { recursive: true });
  await mkdir(join(dir, 'data/seo'), { recursive: true });
  await cp(join(REPO_ROOT, 'scripts/scheduled-mechanical-check.sh'), join(dir, 'scripts/scheduled-mechanical-check.sh'));
  await cp(join(REPO_ROOT, 'scripts/lib/parse_checkpoint.py'), join(dir, 'scripts/lib/parse_checkpoint.py'));
  await chmod(join(dir, 'scripts/scheduled-mechanical-check.sh'), 0o755);

  const fakeCliPath = join(dir, 'fake-cli.sh');
  await writeFile(fakeCliPath, FAKE_CLI, 'utf8');
  await chmod(fakeCliPath, 0o755);

  return { dir, scriptPath: join(dir, 'scripts/scheduled-mechanical-check.sh') };
}

async function writeSiteConfig(dir: string, key: string): Promise<void> {
  await writeFile(
    join(dir, `config/seo.${key}.config.json`),
    JSON.stringify({
      schemaVersion: 2,
      site: { key, baseUrl: `https://${key}.test`, mode: 'existing', reader: 'http', repoRoot: null, contentRoot: null },
      gsc: { property: `sc-domain:${key}.test`, credentialsEnv: 'SEO_TEST_GSC_ENV_UNSET', defaultWindowDays: 28, reviewWindowDays: 7, finalDataLagDays: 3 },
      experiment: { cooldownDays: 7 },
      commands: { build: null, test: null },
      adapters: { writer: 'stub', site: 'http-readonly', search: 'fixture' },
    }),
    'utf8',
  );
}

async function writeObservingExperiment(dir: string, key: string, experimentId: string): Promise<void> {
  await mkdir(join(dir, `data/seo/${key}`), { recursive: true });
  await writeFile(
    join(dir, `data/seo/${key}/experiments.json`),
    JSON.stringify({
      schemaVersion: 2,
      experiments: [
        {
          id: experimentId,
          opportunityId: 'OPP1',
          hypothesisId: 'HYP1',
          action: { type: 'REVISE', targetPaths: ['/a/'], summary: 's', requiredFacts: [], forbiddenChanges: [] },
          measurementPlan: { targetPages: ['/a/'], primaryMetric: 'impressions', secondaryMetrics: [], baselineWindowDays: 28, reviewWindowDays: 28 },
          status: 'observing',
          before: null,
          observation: { start: '2026-09-01', end: '2026-09-29', nextReviewDate: '2026-09-29' },
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
          history: [{ at: '2026-09-01T00:00:00.000Z', type: 'observing' }],
        },
      ],
    }),
    'utf8',
  );
}

function runScript(scriptPath: string, dir: string, env: Record<string, string>): { stdout: string; status: number | null } {
  const result = spawnSync('bash', [scriptPath], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GSC_SERVICE_ACCOUNT_JSON: '/dev/null', // never actually read: SEO_TSX_CMD bypasses the real CLI
      SEO_TSX_CMD: `bash ${join(dir, 'fake-cli.sh')}`,
      ...env,
    } as Record<string, string>,
  });
  return { stdout: `${result.stdout}\n${result.stderr}`, status: result.status };
}

test('scheduled-mechanical-check.sh: smoke test — two sites, both healthy, no checkpoint due', async () => {
  const { dir, scriptPath } = await setupScriptSandbox();
  try {
    await writeSiteConfig(dir, 'site-a');
    await writeSiteConfig(dir, 'site-b');
    await writeObservingExperiment(dir, 'site-a', 'EXP-A1');
    await writeObservingExperiment(dir, 'site-b', 'EXP-B1');

    const { stdout, status } = runScript(scriptPath, dir, {});
    assert.equal(status, 0);
    assert.match(stdout, /site: site-a/);
    assert.match(stdout, /site: site-b/);
    assert.match(stdout, /checkpoint not due yet: site=site-a experiment=EXP-A1/);
    assert.match(stdout, /checkpoint not due yet: site=site-b experiment=EXP-B1/);
    assert.match(stdout, /done: 0 checkpoint\(s\) due, 0 error\(s\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scheduled-mechanical-check.sh: a due checkpoint is detected and logged', async () => {
  const { dir, scriptPath } = await setupScriptSandbox();
  try {
    await writeSiteConfig(dir, 'site-a');
    await writeObservingExperiment(dir, 'site-a', 'EXP-A1');
    const outputDir = join(dir, 'review-outputs');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'seo.site-a.config.json__EXP-A1.json'), JSON.stringify({ checkpoint: 3, sufficientData: true }), 'utf8');

    const { stdout, status } = runScript(scriptPath, dir, { FAKE_REVIEW_OUTPUT_DIR: outputDir });
    assert.equal(status, 0);
    assert.match(stdout, /CHECKPOINT DUE: site=site-a experiment=EXP-A1/);
    assert.match(stdout, /done: 1 checkpoint\(s\) due, 0 error\(s\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scheduled-mechanical-check.sh: malformed review output is logged as an ERROR, not treated as "not due"', async () => {
  const { dir, scriptPath } = await setupScriptSandbox();
  try {
    await writeSiteConfig(dir, 'site-a');
    await writeObservingExperiment(dir, 'site-a', 'EXP-A1');
    const outputDir = join(dir, 'review-outputs');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'seo.site-a.config.json__EXP-A1.json'), 'not valid json at all', 'utf8');

    const { stdout, status } = runScript(scriptPath, dir, { FAKE_REVIEW_OUTPUT_DIR: outputDir });
    assert.equal(status, 0, 'one bad experiment must not crash the whole run');
    assert.match(stdout, /ERROR: could not determine checkpoint status for site=site-a experiment=EXP-A1/);
    assert.doesNotMatch(stdout, /checkpoint not due yet: site=site-a experiment=EXP-A1/);
    assert.match(stdout, /done: 0 checkpoint\(s\) due, 1 error\(s\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scheduled-mechanical-check.sh: an UNDERSTAND failure on one site does not block the other site', async () => {
  const { dir, scriptPath } = await setupScriptSandbox();
  try {
    await writeSiteConfig(dir, 'site-a');
    await writeSiteConfig(dir, 'site-b');
    await writeObservingExperiment(dir, 'site-b', 'EXP-B1');

    const { stdout, status } = runScript(scriptPath, dir, { FAKE_UNDERSTAND_FAIL_SITES: 'seo.site-a.config.json' });
    assert.equal(status, 0);
    assert.match(stdout, /UNDERSTAND FAILED for site=site-a.*continuing to the next site/);
    assert.match(stdout, /site: site-b/);
    assert.match(stdout, /checkpoint not due yet: site=site-b experiment=EXP-B1/);
    assert.match(stdout, /done: 0 checkpoint\(s\) due, 1 error\(s\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scheduled-mechanical-check.sh: a config with no site.key is skipped, not treated as legacy state', async () => {
  const { dir, scriptPath } = await setupScriptSandbox();
  try {
    await writeFile(
      join(dir, 'config/seo.no-key.config.json'),
      JSON.stringify({
        schemaVersion: 2,
        site: { baseUrl: 'https://no-key.test', mode: 'existing', reader: 'http', repoRoot: null, contentRoot: null },
        gsc: { property: 'sc-domain:no-key.test', credentialsEnv: 'SEO_TEST_GSC_ENV_UNSET', defaultWindowDays: 28, reviewWindowDays: 7, finalDataLagDays: 3 },
        experiment: { cooldownDays: 7 },
        commands: { build: null, test: null },
        adapters: { writer: 'stub', site: 'http-readonly', search: 'fixture' },
      }),
      'utf8',
    );

    const { stdout, status } = runScript(scriptPath, dir, {});
    assert.equal(status, 0);
    assert.match(stdout, /SKIP .*seo\.no-key\.config\.json: no site\.key/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- install prerequisite ---

test('scripts/launchd/install.sh: creates logs/scheduled, and never actually invokes launchctl (only prints instructions)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seo-install-helper-'));
  try {
    await mkdir(join(dir, 'scripts/launchd'), { recursive: true });
    await mkdir(join(dir, 'fakebin'), { recursive: true });
    await cp(join(REPO_ROOT, 'scripts/launchd/install.sh'), join(dir, 'scripts/launchd/install.sh'));
    await chmod(join(dir, 'scripts/launchd/install.sh'), 0o755);

    // A `launchctl` that would leave a trace if actually invoked as a command
    // (as opposed to merely appearing inside printed instruction text).
    const marker = join(dir, 'launchctl-was-called');
    await writeFile(join(dir, 'fakebin/launchctl'), `#!/usr/bin/env bash\ntouch "${marker}"\nexit 0\n`, 'utf8');
    await chmod(join(dir, 'fakebin/launchctl'), 0o755);

    const result = spawnSync('bash', [join(dir, 'scripts/launchd/install.sh')], {
      cwd: dir,
      encoding: 'utf8',
      // Real HOME (so this machine's actual node/npm resolve for the
      // prerequisite check) but with the fake launchctl shimmed in front.
      env: { ...process.env, PATH: `${join(dir, 'fakebin')}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);

    const marketExists = await import('node:fs/promises').then((fs) =>
      fs.stat(marker).then(
        () => true,
        () => false,
      ),
    );
    assert.equal(marketExists, false, 'install.sh must not itself invoke launchctl');

    const logDirStat = await import('node:fs/promises').then((fs) => fs.stat(join(dir, 'logs/scheduled')));
    assert.ok(logDirStat.isDirectory());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
