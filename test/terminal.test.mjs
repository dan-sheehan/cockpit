// launch.terminal must treat a project path as data: awkward or hostile directory names reach the shell as exactly one
// quoted word after `cd`, never as shell source. Nothing here opens Terminal or runs an injected command.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixtureHomes, readOsascriptCalls } from './fixtures/homes.mjs';
import { bootServer } from './fixtures/server.mjs';

const HOSTILE = ['with space', "it's", 'say "hi"', 'a;b', 'a|b', 'a`b`', '$HOME', '$(echo x)', 'x && y', `all it's "q" ; | \`w\` $(z) $HOME && \\ end`];
let server, fx, root;

// A POSIX-shell word made only of '...' segments and \' escapes is one literal argument; decode it or return null.
function singleShellWord(s) {
  if (!/^(?:'[^']*'|\\')+$/.test(s)) return null;
  return s.replace(/'([^']*)'|\\'/g, (m, lit) => (lit !== undefined ? lit : "'"));
}

before(async () => {
  fx = await makeFixtureHomes();
  root = path.join(fx.base, 'projects');
  for (const name of HOSTILE) { await fs.mkdir(path.join(root, name), { recursive: true }); await fs.writeFile(path.join(root, name, 'README.md'), '#\n'); }
  server = await bootServer({ ...fx.env, COCKPIT_PROJECT_ROOTS: root });
});
after(() => { server?.child.kill('SIGTERM'); });

test('the server hands osascript the project path as its own argument, never inside the script', async () => {
  for (const name of HOSTILE) {
    const projectPath = path.join(root, name);
    const body = JSON.stringify({ action: 'launch.terminal', tool: 'claude', projectPath });
    const r = await new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port: server.port, path: '/api/actions', method: 'POST', headers: { origin: `http://127.0.0.1:${server.port}`, 'content-type': 'application/json' } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); }); req.on('error', reject); req.end(body); });
    assert.equal(r.status, 200, name + ': ' + r.body);
  }
  await new Promise((r) => setTimeout(r, 800));
  const calls = await readOsascriptCalls(fx);
  assert.equal(calls.length, HOSTILE.length);
  const script = calls[0].slice(0, -1);
  for (const argv of calls) {
    const p = argv.at(-1);
    assert.ok(HOSTILE.map((n) => path.join(root, n)).includes(p), 'last argument is exactly one project path: ' + p);
    assert.deepEqual(argv.slice(0, -1), script, 'the script is identical for every path');
    assert.ok(!argv.slice(0, -1).some((a) => a.includes(root)), 'the path never appears in the script');
  }
});

test('terminalLaunch: AppleScript turns every path into a single quoted shell word', { skip: process.platform !== 'darwin' && 'needs macOS osascript' }, async () => {
  const { terminalLaunch } = await import('../lib/terminal.mjs');
  for (const tool of ['claude', 'codex', 'anything else']) {
    for (const name of HOSTILE) {
      const projectPath = path.join('/Users/someone/code', name);
      const { cmd, args } = terminalLaunch(projectPath, tool);
      assert.equal(cmd, 'osascript');
      assert.equal(args.at(-1), projectPath);
      // Evaluate the production `do script` expression with the real osascript, minus Terminal: return the text instead of typing it.
      const lines = args.slice(0, -1).filter((a) => a !== '-e').filter((l) => !/^(tell application|activate|end tell)/.test(l.trim())).map((l) => l.replace(/^do script /, 'return '));
      const typed = execFileSync('/usr/bin/osascript', [...lines.flatMap((l) => ['-e', l]), projectPath], { encoding: 'utf8' }).replace(/\n$/, '');
      const cli = tool === 'codex' ? 'codex' : 'claude';
      const m = typed.match(new RegExp(`^cd (.+) && ${cli}$`));
      assert.ok(m, typed);
      assert.equal(singleShellWord(m[1]), projectPath, `one literal word: ${typed}`);
    }
  }
});
