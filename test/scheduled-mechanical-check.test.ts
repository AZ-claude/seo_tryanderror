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
    echo "- pages read: \${FAKE_PAGES_READ:-10}"
    echo "- pages failed: \${FAKE_PAGES_FAILED:-0}"
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

// A no-op osascript double: every test must set $SEO_OSASCRIPT_CMD to
// something (this by default) so `notify` never invokes the real macOS
// osascript during a test run — a real one would pop an actual system
// notification. Tests that care about notification calls override this
// with a recording double instead.
const NOOP_OSASCRIPT = `#!/usr/bin/env bash\nexit 0\n`;

const RECORDING_OSASCRIPT = `#!/usr/bin/env bash
echo "CALLED: $*" >>"$FAKE_OSASCRIPT_LOG"
exit 0
`;

async function setupScriptSandbox(): Promise<{
  dir: string;
  scriptPath: string;
  noopOsascriptPath: string;
  recordingOsascriptPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'seo-scheduled-check-'));
  await mkdir(join(dir, 'scripts/lib'), { recursive: true });
  await mkdir(join(dir, 'config'), { recursive: true });
  await mkdir(join(dir, 'data/seo'), { recursive: true });
  await cp(join(REPO_ROOT, 'scripts/scheduled-mechanical-check.sh'), join(dir, 'scripts/scheduled-mechanical-check.sh'));
  await cp(join(REPO_ROOT, 'scripts/lib/parse_checkpoint.py'), join(dir, 'scripts/lib/parse_checkpoint.py'));
  await cp(join(REPO_ROOT, 'scripts/lib/scheduler_status.py'), join(dir, 'scripts/lib/scheduler_status.py'));
  await chmod(join(dir, 'scripts/scheduled-mechanical-check.sh'), 0o755);

  const fakeCliPath = join(dir, 'fake-cli.sh');
  await writeFile(fakeCliPath, FAKE_CLI, 'utf8');
  await chmod(fakeCliPath, 0o755);

  const noopOsascriptPath = join(dir, 'noop-osascript.sh');
  await writeFile(noopOsascriptPath, NOOP_OSASCRIPT, 'utf8');
  await chmod(noopOsascriptPath, 0o755);

  const recordingOsascriptPath = join(dir, 'recording-osascript.sh');
  await writeFile(recordingOsascriptPath, RECORDING_OSASCRIPT, 'utf8');
  await chmod(recordingOsascriptPath, 0o755);

  return {
    dir,
    scriptPath: join(dir, 'scripts/scheduled-mechanical-check.sh'),
    noopOsascriptPath,
    recordingOsascriptPath,
  };
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
      // Safety net: unless a test overrides this, notify() must never be
      // able to reach the real macOS osascript and pop an actual
      // notification during a test run.
      SEO_OSASCRIPT_CMD: `bash ${join(dir, 'noop-osascript.sh')}`,
      ...env,
    } as Record<string, string>,
  });
  return { stdout: `${result.stdout}\n${result.stderr}`, status: result.status };
}

async function readStatusFile(dir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(dir, 'logs/scheduled/latest-status.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
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

// --- latest-status.json + notification ---

test('scheduled-mechanical-check.sh: all healthy -> status=ok, dueCount=0, errorCount=0, 0 notifications', async () => {
  const { dir, scriptPath, recordingOsascriptPath } = await setupScriptSandbox();
  try {
    await writeSiteConfig(dir, 'site-a');
    await writeSiteConfig(dir, 'site-b');
    await writeObservingExperiment(dir, 'site-a', 'EXP-A1');
    await writeObservingExperiment(dir, 'site-b', 'EXP-B1');
    const callLog = join(dir, 'osascript-calls.log');

    const { status } = runScript(scriptPath, dir, {
      SEO_OSASCRIPT_CMD: `bash ${recordingOsascriptPath}`,
      FAKE_OSASCRIPT_LOG: callLog,
    });
    assert.equal(status, 0);

    const parsed = await readStatusFile(dir);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.dueCount, 0);
    assert.equal(parsed.errorCount, 0);
    assert.equal((parsed.sites as unknown[]).length, 2);

    const calls = await readFile(callLog, 'utf8').catch(() => '');
    assert.equal(calls.trim(), '', 'a healthy run must never call osascript');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scheduled-mechanical-check.sh: one checkpoint due -> status=attention, dueCount=1, exactly 1 notification', async () => {
  const { dir, scriptPath, recordingOsascriptPath } = await setupScriptSandbox();
  try {
    await writeSiteConfig(dir, 'site-a');
    await writeObservingExperiment(dir, 'site-a', 'EXP-A1');
    const outputDir = join(dir, 'review-outputs');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'seo.site-a.config.json__EXP-A1.json'), JSON.stringify({ checkpoint: 3 }), 'utf8');
    const callLog = join(dir, 'osascript-calls.log');

    const { status } = runScript(scriptPath, dir, {
      FAKE_REVIEW_OUTPUT_DIR: outputDir,
      SEO_OSASCRIPT_CMD: `bash ${recordingOsascriptPath}`,
      FAKE_OSASCRIPT_LOG: callLog,
    });
    assert.equal(status, 0);

    const parsed = await readStatusFile(dir);
    assert.equal(parsed.status, 'attention');
    assert.equal(parsed.dueCount, 1);
    assert.equal(parsed.errorCount, 0);

    const calls = (await readFile(callLog, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /SEO PDCA/);
    assert.doesNotMatch(calls[0]!, /EXP-A1/, 'notification text must not leak the experiment id / raw data');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scheduled-mechanical-check.sh: one site error (UNDERSTAND failure) -> status=error, errorCount=1, exactly 1 notification', async () => {
  const { dir, scriptPath, recordingOsascriptPath } = await setupScriptSandbox();
  try {
    await writeSiteConfig(dir, 'site-a');
    const callLog = join(dir, 'osascript-calls.log');

    const { status } = runScript(scriptPath, dir, {
      FAKE_UNDERSTAND_FAIL_SITES: 'seo.site-a.config.json',
      SEO_OSASCRIPT_CMD: `bash ${recordingOsascriptPath}`,
      FAKE_OSASCRIPT_LOG: callLog,
    });
    assert.equal(status, 0);

    const parsed = await readStatusFile(dir);
    assert.equal(parsed.status, 'error');
    assert.equal(parsed.errorCount, 1);

    const calls = (await readFile(callLog, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /SEO Scheduler Error/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scheduled-mechanical-check.sh: due + error together -> error wins, exactly 1 notification (no spam)', async () => {
  const { dir, scriptPath, recordingOsascriptPath } = await setupScriptSandbox();
  try {
    await writeSiteConfig(dir, 'site-a'); // will fail understand -> error
    await writeSiteConfig(dir, 'site-b');
    await writeObservingExperiment(dir, 'site-b', 'EXP-B1');
    const outputDir = join(dir, 'review-outputs');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'seo.site-b.config.json__EXP-B1.json'), JSON.stringify({ checkpoint: 7 }), 'utf8');
    const callLog = join(dir, 'osascript-calls.log');

    const { status } = runScript(scriptPath, dir, {
      FAKE_UNDERSTAND_FAIL_SITES: 'seo.site-a.config.json',
      FAKE_REVIEW_OUTPUT_DIR: outputDir,
      SEO_OSASCRIPT_CMD: `bash ${recordingOsascriptPath}`,
      FAKE_OSASCRIPT_LOG: callLog,
    });
    assert.equal(status, 0);

    const parsed = await readStatusFile(dir);
    assert.equal(parsed.status, 'error', 'error must take priority over attention');
    assert.equal(parsed.dueCount, 1);
    assert.equal(parsed.errorCount, 1);

    const calls = (await readFile(callLog, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(calls.length, 1, 'must not send both an attention and an error notification for the same run');
    assert.match(calls[0]!, /SEO Scheduler Error/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scheduled-mechanical-check.sh: a failing osascript does not fail the run or its reported result', async () => {
  const { dir, scriptPath } = await setupScriptSandbox();
  try {
    await writeSiteConfig(dir, 'site-a');
    const outputDir = join(dir, 'review-outputs');
    await mkdir(outputDir, { recursive: true });
    const failingOsascript = join(dir, 'failing-osascript.sh');
    await writeFile(failingOsascript, '#!/usr/bin/env bash\nexit 1\n', 'utf8');
    await chmod(failingOsascript, 0o755);
    await writeObservingExperiment(dir, 'site-a', 'EXP-A1');
    await writeFile(join(outputDir, 'seo.site-a.config.json__EXP-A1.json'), JSON.stringify({ checkpoint: 3 }), 'utf8');

    const { status, stdout } = runScript(scriptPath, dir, {
      FAKE_REVIEW_OUTPUT_DIR: outputDir,
      SEO_OSASCRIPT_CMD: `bash ${failingOsascript}`,
    });
    assert.equal(status, 0, 'a broken notification mechanism must not fail the scheduler run');
    assert.match(stdout, /done: 1 checkpoint\(s\) due, 0 error\(s\)/, 'notification failure must not be counted as a site error');

    const parsed = await readStatusFile(dir);
    assert.equal(parsed.status, 'attention', 'the recorded result is unaffected by the notification failure');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scheduled-mechanical-check.sh: latest-status.json is written atomically (no leftover .tmp file, always valid complete JSON)', async () => {
  const { dir, scriptPath } = await setupScriptSandbox();
  try {
    await writeSiteConfig(dir, 'site-a');
    runScript(scriptPath, dir, {});

    const statusDir = join(dir, 'logs/scheduled');
    const entries = await import('node:fs/promises').then((fs) => fs.readdir(statusDir));
    const leftoverTmp = entries.filter((e) => e.includes('.tmp'));
    assert.deepEqual(leftoverTmp, [], 'no temp file should remain after an atomic rename');

    const parsed = await readStatusFile(dir);
    assert.equal(parsed.schemaVersion, 1);
    assert.ok(typeof parsed.startedAt === 'string' && typeof parsed.finishedAt === 'string');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scheduler_status.py render: formats a healthy multi-site status readably', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seo-status-render-'));
  try {
    const statusFile = join(dir, 'latest-status.json');
    await writeFile(
      statusFile,
      JSON.stringify({
        schemaVersion: 1,
        startedAt: '2026-09-25T00:00:00Z',
        finishedAt: '2026-09-25T00:00:30Z',
        status: 'ok',
        dueCount: 0,
        errorCount: 0,
        sites: [
          { siteKey: 'rakusetsu-main', understand: 'ok', pagesRead: 231, pagesFailed: 0, checkpointDue: [], checkpointNotDue: ['E1'], errors: [] },
          { siteKey: 'pokeca', understand: 'ok', pagesRead: 1515, pagesFailed: 0, checkpointDue: [], checkpointNotDue: ['E2'], errors: [] },
        ],
      }),
      'utf8',
    );
    const result = spawnSync('python3', [join(REPO_ROOT, 'scripts/lib/scheduler_status.py'), 'render', '--status-file', statusFile], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Result: OK/);
    assert.match(result.stdout, /rakusetsu-main/);
    assert.match(result.stdout, /pokeca/);
    assert.match(result.stdout, /Checkpoints due: 0/);
    assert.match(result.stdout, /Next action:\s*\n\s*none/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scheduler_status.py render: a missing latest-status.json prints a clear, non-crashing message', () => {
  const result = spawnSync(
    'python3',
    [join(REPO_ROOT, 'scripts/lib/scheduler_status.py'), 'render', '--status-file', '/nonexistent/latest-status.json'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No run recorded yet/);
});

test('scheduler_status.py append-site: fixture never contains secret-shaped values, and error messages are capped in length', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seo-status-append-'));
  try {
    const sitesFile = join(dir, 'sites.jsonl');
    const longMessage = 'A'.repeat(500);
    const result = spawnSync(
      'python3',
      [
        join(REPO_ROOT, 'scripts/lib/scheduler_status.py'),
        'append-site',
        '--sites-file',
        sitesFile,
        '--site-key',
        'site-a',
        '--understand',
        'failed',
        '--error',
        longMessage,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0);

    const line = (await readFile(sitesFile, 'utf8')).trim();
    const site = JSON.parse(line) as { errors: string[]; [key: string]: unknown };
    assert.equal(Object.keys(site).sort().join(','), 'checkpointDue,checkpointNotDue,errors,pagesFailed,pagesRead,siteKey,understand');
    assert.ok(site.errors[0]!.length <= 201, 'error messages must be capped, not dump arbitrary-length content');
    assert.doesNotMatch(line, /credential|private_key|BEGIN.*PRIVATE KEY|GSC_SERVICE_ACCOUNT_JSON=/i);
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
