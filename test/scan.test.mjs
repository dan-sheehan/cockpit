import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFixtureHomes, FAKE_SECRET } from './fixtures/homes.mjs';

// The scanner resolves the Claude/Codex homes at import time, so point them at the fixture before loading it.
const fx = await makeFixtureHomes();
Object.assign(process.env, fx.env);
const { scanEnvironment, discoverProjectPaths, parseProjectRoots, COCKPIT_ROOT } = await import('../lib/scan.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = path.join(ROOT, 'lib', 'scan.mjs');

test('scan reads the configured Claude/Codex homes, reports stub CLIs, and leaks no credentials', async () => {
  const env = await scanEnvironment();
  const claude = env.tools.find((t) => t.name === 'claude'), codex = env.tools.find((t) => t.name === 'codex');
  assert.equal(claude.version, '9.9.9 (Claude Code)'); assert.equal(claude.status, 'available'); assert.equal(claude.configHome, fx.claude);
  assert.equal(codex.version, 'codex-cli 8.8.8'); assert.equal(codex.status, 'available'); assert.equal(codex.configHome, fx.codex);
  assert.equal(env.claude.home, fx.claude); assert.equal(env.codex.home, fx.codex);
  assert.equal(env.claude.settings.model, 'fixture-model');
  assert.equal(env.codex.config.model, 'fixture-codex-model');
  assert.ok(env.codex.authConfigured);
  assert.ok(env.skills.some((s) => s.name === 'fixture-skill' && s.path === path.join(fx.claude, 'skills', 'fixture-skill', 'SKILL.md')));
  assert.ok(env.mcp.some((m) => m.name === 'fixture' && m.source === path.join(fx.claude, '.claude.json')), '.claude.json is read from CLAUDE_CONFIG_DIR');
  for (const s of env.skills) { assert.ok(s.name); assert.ok(s.path.endsWith('SKILL.md')); }
  assert.ok(env.projects.some((p) => p.path === COCKPIT_ROOT), 'cockpit itself is always a discovered project');
  const text = JSON.stringify(env);
  assert.ok(!text.includes(FAKE_SECRET));
  assert.doesNotMatch(text, /sk-[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(text, /auth\.json"?:\s*\{/);
  assert.ok(!text.includes('decoy-default-location'), 'the default ~/.claude is ignored when CLAUDE_CONFIG_DIR is set');
});

test('COCKPIT_ROOT is the checkout containing this code, whatever the working directory', () => {
  assert.equal(COCKPIT_ROOT, ROOT);
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(SCAN).href)}).then((m) => process.stdout.write(m.COCKPIT_ROOT))`], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(out, ROOT);
});

test('cockpit discovers itself with no Claude/Codex config and no extra roots', async () => {
  assert.deepEqual(await discoverProjectPaths({ claudeJson: null, codexConfig: null }, { roots: [] }), [COCKPIT_ROOT]);
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-self-'));
  assert.deepEqual(await discoverProjectPaths({}, { roots: [], self: elsewhere }), [elsewhere]);
});

test('no personal project root is assumed', () => {
  assert.deepEqual(parseProjectRoots(undefined), []);
  assert.deepEqual(parseProjectRoots(''), []);
  assert.doesNotMatch(readFileSync(SCAN, 'utf8'), /atlas/);
  assert.doesNotMatch(readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'), /atlas/);
});

test('parseProjectRoots splits on the platform delimiter and keeps only absolute paths', () => {
  const a = path.join(os.tmpdir(), 'roots-a'), b = path.join(os.tmpdir(), 'roots-b');
  assert.deepEqual(parseProjectRoots([a, ` ${b} `, '', 'relative/dir', a + path.sep, a].join(path.delimiter)), [a, b]);
});

test('explicit project roots are scanned at most two levels deep', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-roots-'));
  const mk = async (rel, marker) => { await fs.mkdir(path.join(root, rel), { recursive: true }); if (marker) await fs.writeFile(path.join(root, rel, marker), ''); };
  await mk('app', 'package.json');
  await mk('group/lib', 'pyproject.toml');
  await mk('group/deep/too-far', 'package.json');
  await mk('plain');
  await mk('.hidden', 'package.json');
  const found = await discoverProjectPaths({}, { roots: [root], self: COCKPIT_ROOT });
  assert.deepEqual(found, [COCKPIT_ROOT, path.join(root, 'app'), path.join(root, 'group', 'lib')].sort());
});

test('Claude/Codex-known projects are still discovered, existing only, never HOME, deduplicated', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-known-'));
  const a = path.join(base, 'a'), b = path.join(base, 'b'), missing = path.join(base, 'missing');
  await fs.mkdir(a); await fs.writeFile(path.join(a, 'package.json'), '{}'); await fs.mkdir(b);
  const ctx = {
    claudeJson: { projects: { [a]: {}, [missing]: {}, [os.homedir()]: {}, [COCKPIT_ROOT]: {} } },
    codexConfig: { projects: { [a]: { trust_level: 'trusted' }, [b]: { trust_level: 'trusted' }, [COCKPIT_ROOT]: {} } },
  };
  // `a` arrives from the explicit root, Claude and Codex; `b` only from Codex (no marker file); cockpit from itself, Claude and Codex.
  assert.deepEqual(await discoverProjectPaths(ctx, { roots: [base] }), [COCKPIT_ROOT, a, b].sort());
});

test('Claude/Codex-recorded paths never make the filesystem root, HOME or an ancestor of HOME a project', async () => {
  const home = fx.home, above = path.dirname(fx.home);
  const legitUnderHome = path.join(home, 'code', 'site'), legitElsewhere = path.join(fx.base, 'elsewhere', 'tool'), upLink = path.join(fx.base, 'elsewhere', 'up');
  for (const d of [legitUnderHome, legitElsewhere]) { await fs.mkdir(d, { recursive: true }); await fs.writeFile(path.join(d, 'package.json'), '{}'); }
  await fs.symlink(above, upLink);
  const broad = ['/', home, above, upLink, home + path.sep];
  const upper = home.toUpperCase(); if (upper !== home && (await fs.stat(upper).catch(() => null))) broad.push(upper); // case-insensitive volumes only
  const ctx = { claudeJson: { projects: Object.fromEntries([...broad, legitUnderHome].map((p) => [p, {}])) }, codexConfig: { projects: Object.fromEntries([...broad, legitElsewhere].map((p) => [p, {}])) } };
  assert.deepEqual(await discoverProjectPaths(ctx, { roots: [] }), [COCKPIT_ROOT, legitElsewhere, legitUnderHome].sort());
});

test('an explicit project root is still scanned even when broad, but HOME is never accepted as one of its projects', async () => {
  // fx.base holds HOME (which has a .claude folder, a project marker) and ordinary folders; scanning it must not yield HOME.
  await fs.mkdir(path.join(fx.home, '.claude'), { recursive: true });
  const sibling = path.join(fx.base, 'sibling-project'); await fs.mkdir(sibling, { recursive: true }); await fs.writeFile(path.join(sibling, 'README.md'), '# s');
  const found = await discoverProjectPaths({}, { roots: [fx.base] });
  assert.ok(found.includes(sibling), 'ordinary projects under the explicit root are found');
  assert.ok(!found.includes(fx.home), 'HOME is not');
});
