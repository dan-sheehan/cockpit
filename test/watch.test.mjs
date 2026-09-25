import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Claude/Codex homes live under path segments the watcher ignores *inside* roots (data/, tmp/), to prove that the
// root's own location is never matched. The homes are resolved at import time, so set them before loading the watcher.
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-watch-homes-')));
const claudeHome = path.join(base, 'data', 'claude-config'), codexHome = path.join(base, 'tmp', 'codex-home');
for (const d of [path.join(claudeHome, 'projects', '-p'), path.join(claudeHome, 'logs'), path.join(codexHome, 'sessions', '2026')]) await fs.mkdir(d, { recursive: true });
Object.assign(process.env, { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome });
const { startWatching } = await import('../lib/watch.mjs');

async function collect(projectPaths, writes) {
  const changes = [];
  const w = startWatching({ projectPaths, onChange: (c) => changes.push(...c), debounceMs: 150 });
  await new Promise((r) => setTimeout(r, 250)); // let the FSEvents streams start, or the first writes can be missed
  for (const f of writes) await fs.writeFile(f, 'x');
  await new Promise((r) => setTimeout(r, 700));
  w.close();
  return changes;
}

test('watcher fires for a project CLAUDE.md change and ignores noise', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-watch-'));
  const changes = await collect([dir], [path.join(dir, 'noise.log'), path.join(dir, 'CLAUDE.md')]);
  assert.ok(changes.some((c) => c.endsWith('CLAUDE.md')), 'CLAUDE.md change detected: ' + JSON.stringify(changes));
  assert.ok(!changes.some((c) => c.endsWith('noise.log')), 'log noise ignored');
});

test('a project whose own path contains an ignored name (tmp, data, logs) is still watched', async () => {
  const dirs = ['tmp', 'data', 'logs'].map((seg) => path.join(base, 'projects-under', seg, 'proj'));
  for (const d of dirs) await fs.mkdir(d, { recursive: true });
  const changes = await collect(dirs, dirs.map((d) => path.join(d, 'CLAUDE.md')));
  for (const d of dirs) assert.ok(changes.includes(path.join(d, 'CLAUDE.md')), d + ': ' + JSON.stringify(changes));
});

test('Claude/Codex homes under ignored names are watched, and ignored names inside them still apply', async () => {
  const changes = await collect([], [
    path.join(claudeHome, 'settings.json'), path.join(codexHome, 'config.toml'),
    path.join(claudeHome, 'projects', '-p', 'settings.json'), path.join(claudeHome, 'logs', 'settings.json'), path.join(codexHome, 'sessions', '2026', 'config.toml'),
  ]);
  assert.ok(changes.includes(path.join(claudeHome, 'settings.json')), JSON.stringify(changes));
  assert.ok(changes.includes(path.join(codexHome, 'config.toml')), JSON.stringify(changes));
  assert.ok(!changes.some((c) => /\/(projects|logs|sessions)\//.test(path.relative(base, c))), 'ignored descendants stay ignored: ' + JSON.stringify(changes));
});

test('ignored folders inside a project .claude root stay ignored', async () => {
  const dir = path.join(base, 'data', 'proj2');
  await fs.mkdir(path.join(dir, '.claude', 'cache'), { recursive: true });
  const changes = await collect([dir], [path.join(dir, '.claude', 'cache', 'settings.json'), path.join(dir, '.claude', 'settings.json')]);
  assert.ok(changes.includes(path.join(dir, '.claude', 'settings.json')), JSON.stringify(changes));
  assert.ok(!changes.includes(path.join(dir, '.claude', 'cache', 'settings.json')), JSON.stringify(changes));
});
