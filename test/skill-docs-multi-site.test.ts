import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const growthLoop = readFileSync(join(ROOT, '.claude/skills/seo-growth-loop/SKILL.md'), 'utf8');
const rankWatch = readFileSync(join(ROOT, '.claude/skills/seo-rank-watch/SKILL.md'), 'utf8');
const multiSiteLoop = readFileSync(join(ROOT, '.claude/skills/seo-multi-site-loop/SKILL.md'), 'utf8');

/** A real `npm run seo -- ... --config config/seo.config.json` example, not prose mentioning the path. */
const HARDCODED_CONFIG_COMMAND = /npm run seo -- .*--config config\/seo\.config\.json/;

test('seo-growth-loop: no hardcoded `--config config/seo.config.json` command example remains', () => {
  assert.doesNotMatch(growthLoop, HARDCODED_CONFIG_COMMAND);
});

test('seo-rank-watch: no hardcoded `--config config/seo.config.json` command example remains', () => {
  assert.doesNotMatch(rankWatch, HARDCODED_CONFIG_COMMAND);
});

test('seo-growth-loop: documents both known real site configs (rakusetsu-main, pokeca)', () => {
  assert.match(growthLoop, /config\/seo\.rakusetsu\.config\.json/);
  assert.match(growthLoop, /config\/seo\.pokeca\.config\.json/);
});

test('seo-growth-loop: requires resolving a target site config before any command, and refuses to guess when ambiguous', () => {
  assert.match(growthLoop, /対象siteの解決/);
  assert.match(growthLoop, /片方を勝手に選ばない/);
});

test('seo-growth-loop: site-specific deploy tiering is read from the target repo\'s AGENTS.md, not hardcoded', () => {
  assert.match(growthLoop, /AGENTS\.md/);
  assert.match(growthLoop, /独立review PASS/);
  assert.match(growthLoop, /ハードコードしない/);
});

test('seo-growth-loop: frontmatter routes ambiguous/both-site requests to seo-multi-site-loop instead of guessing', () => {
  assert.match(growthLoop, /seo-multi-site-loop/);
});

test('seo-multi-site-loop skill exists and delegates to seo-growth-loop per site, sequentially, with a per-site report', () => {
  assert.match(multiSiteLoop, /seo-growth-loop/);
  assert.match(multiSiteLoop, /直列/);
  assert.doesNotMatch(multiSiteLoop, /並行して(実行|起動)/, 'must not run sites concurrently');
});

test('seo-multi-site-loop: one site failing does not block the other site\'s safe read-only steps', () => {
  assert.match(multiSiteLoop, /安全なread専用処理/);
});

test('seo-multi-site-loop: does not hardcode the number/list of sites — reads config/*.config.json', () => {
  assert.match(multiSiteLoop, /config\/\*\.config\.json/);
  assert.match(multiSiteLoop, /ハードコードしない/);
});

test('README: documents the three multi-site invocation patterns (single site x2, both sites)', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /rakusetsu-mainのPDCA回して/);
  assert.match(readme, /pokecaのPDCA回して/);
  assert.match(readme, /両サイトのPDCA回して/);
  assert.match(readme, /seo-multi-site-loop/);
});
