// File-viewer boundary when CLAUDE_CONFIG_DIR / CODEX_HOME are set very broadly: a Claude/Codex home that is HOME or one of
// its ancestors is never a viewer root, just as project discovery never treats HOME as a project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeFixtureHomes } from './fixtures/homes.mjs';
import { bootServer, ROOT } from './fixtures/server.mjs';
import { coversPath } from '../lib/homes.mjs';

let server, fx;
const get = (p) => fetch(server.base + '/api/file?path=' + encodeURIComponent(p));

before(async () => {
  fx = await makeFixtureHomes();
  for (const [rel, c] of [['.ssh/config', 'Host prod\n'], ['.netrc', 'machine x login me password hunter2\n'], ['Documents/notes.txt', 'private\n'], ['.claude.json', '{}']]) {
    await fs.mkdir(path.dirname(path.join(fx.home, rel)), { recursive: true }); await fs.writeFile(path.join(fx.home, rel), c);
  }
  await fs.writeFile(path.join(fx.base, 'beside-home.txt'), 'x');
  // CLAUDE_CONFIG_DIR is HOME itself; CODEX_HOME is an ancestor of HOME.
  server = await bootServer({ ...fx.env, CLAUDE_CONFIG_DIR: fx.home, CODEX_HOME: fx.base });
});
after(() => { server?.child.kill('SIGTERM'); });

test('coversPath: a directory covers itself and its descendants only', () => {
  assert.equal(coversPath('/Users/me', '/Users/me'), true);
  assert.equal(coversPath('/Users', '/Users/me'), true);
  assert.equal(coversPath('/', '/Users/me'), true);
  assert.equal(coversPath('/Users/me/.claude', '/Users/me'), false);
  assert.equal(coversPath('/Users/me2', '/Users/me'), false);
  assert.equal(coversPath('/Users/me/..data', '/Users/me/..data/x'), true);
});

test('a Claude/Codex home at or above HOME does not open the home directory', async () => {
  for (const p of [fx.home, path.join(fx.home, '.ssh', 'config'), path.join(fx.home, '.netrc'), path.join(fx.home, 'Documents', 'notes.txt'), path.join(fx.base, 'beside-home.txt')]) {
    assert.equal((await get(p)).status, 403, p);
  }
});

test('the rest of the boundary is unchanged: .claude.json and Cockpit itself stay viewable', async () => {
  assert.equal((await get(path.join(fx.home, '.claude.json'))).status, 200);
  assert.equal((await get(path.join(ROOT, 'package.json'))).status, 200);
});
