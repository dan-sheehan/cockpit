// Regression: the running server must survive a change in its discovered project set and keep watching the new set.
// Previously the rebuilt watcher got a null callback, so the next watched change threw "onChange is not a function" and
// the server exited; and the rebuild compared only against the first scan's project count.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeFixtureHomes } from './fixtures/homes.mjs';
import { bootServer } from './fixtures/server.mjs';

let server, fx, a, b, log = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits until the server output written after offset `from` satisfies `ok`; fails at once if the server exits.
async function waitForLog(from, ok, what, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    if (server.child.exitCode !== null) throw new Error(`server exited (code ${server.child.exitCode}) waiting for ${what}:\n${log}`);
    if (ok(log.slice(from))) return;
  }
  throw new Error(`timed out waiting for ${what}:\n${log.slice(from)}`);
}
const projects = async () => (await (await fetch(server.base + '/api/env')).json()).projects.map((p) => p.path);
// Joins any rescan already in flight, so a later edit to discovery input cannot be picked up by that earlier rescan.
const settle = () => fetch(server.base + '/api/env?refresh=1').then((r) => r.json());

// Production path: Claude-known projects come from .claude.json, which the watcher treats as irrelevant, so the new set is
// discovered by the rescan that the next relevant change (here the global CLAUDE.md) triggers.
async function rescanWithClaudeProjects(paths) {
  await settle();
  await fs.writeFile(path.join(fx.claude, '.claude.json'), JSON.stringify({ projects: Object.fromEntries(paths.map((p) => [p, {}])) }, null, 2));
  const from = log.length;
  await fs.writeFile(path.join(fx.claude, 'CLAUDE.md'), `edit ${Date.now()}\n`);
  await waitForLog(from, (out) => out.includes('(project set changed)'), 'the watcher rebuild');
  await sleep(500); // let the rebuilt watcher's FSEvents streams start, or the first writes can be missed
}
// Writes the given CLAUDE.md files together and returns the "change … → rescan" line they produce (one debounced batch).
async function touchAndReadChange(files, expect) {
  const from = log.length;
  for (const f of files) await fs.writeFile(f, `edit ${Date.now()}\n`);
  await waitForLog(from, (out) => /^change .*→ rescan$/m.test(out) && out.includes(expect), `a change event for ${expect}`);
  return log.slice(from).match(/^change .*→ rescan$/m)[0];
}

before(async () => {
  fx = await makeFixtureHomes();
  a = path.join(fx.base, 'known', 'a'); b = path.join(fx.base, 'known', 'b');
  for (const d of [a, b]) { await fs.mkdir(d, { recursive: true }); await fs.writeFile(path.join(d, 'package.json'), '{}'); }
  server = await bootServer(fx.env);
  server.child.stdout.on('data', (d) => { log += d; });
  server.child.stderr.on('data', (d) => { log += d; });
  await projects(); // the initial scan; the server starts its watcher as soon as it resolves
  await sleep(500);
});
after(() => { server?.child.kill('SIGTERM'); });

test('a new project set rebuilds the watcher, and the next watched change is handled without a crash', async () => {
  assert.ok(!(await projects()).includes(a), 'the fixture project is not known yet');
  await rescanWithClaudeProjects([a]);
  assert.ok((await projects()).includes(a), 'the rescan discovered the Claude-known project');
  // Only the rebuilt watcher covers this path, and this is the event that used to kill the server.
  const line = await touchAndReadChange([path.join(a, 'CLAUDE.md')], path.join(a, 'CLAUDE.md'));
  assert.ok(line.includes(path.join(a, 'CLAUDE.md')), line);
  await settle();
  assert.equal(server.child.exitCode, null, 'the server is still running');
  assert.equal((await fetch(server.base + '/api/meta')).status, 200);
});

test('replacing a project with another at the same count is a change, and the watcher follows the new path', async () => {
  const before = await projects();
  await rescanWithClaudeProjects([b]);
  const now = await projects();
  assert.equal(now.length, before.length, 'same number of projects');
  assert.ok(now.includes(b) && !now.includes(a), JSON.stringify(now));
  // Both files change in one debounce window: only the newly watched project reports; the dropped one is no longer watched.
  const line = await touchAndReadChange([path.join(a, 'CLAUDE.md'), path.join(b, 'CLAUDE.md')], path.join(b, 'CLAUDE.md'));
  assert.ok(!line.includes(path.join(a, 'CLAUDE.md')), 'the replaced project is no longer watched: ' + line);
  await settle();
  assert.equal(server.child.exitCode, null, 'the server is still running');
});
