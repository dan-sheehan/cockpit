// Smoke test: boots the real server on a spare port (from an unrelated cwd) and checks the primary API surface and safety guards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { makeFixtureHomes } from './fixtures/homes.mjs';
import { bootServer, ROOT } from './fixtures/server.mjs';

let child, fx, repo, strayRepo, PORT, BASE;
// Cockpit's own page sends JSON with its Origin; state-changing requests without that are refused (see request-admission.test.mjs).
const post = (p, body) => fetch(BASE + p, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify(body) });

// A real Git repository with one commit, so the Git action test never depends on Cockpit's own checkout having .git.
async function makeRepo(dir, env) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'README.md'), '# fixture\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Cockpit Test', '-c', 'user.email=cockpit-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env, stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'fixture commit');
  return dir;
}

before(async () => {
  fx = await makeFixtureHomes(); // fake HOME / CLAUDE_CONFIG_DIR / CODEX_HOME and stub CLIs: no real agent state or installs needed
  const gitEnv = { ...process.env, ...fx.env, GIT_CONFIG_NOSYSTEM: '1' };
  repo = await makeRepo(path.join(fx.base, 'projects', 'sample-repo'), gitEnv); // discovered through COCKPIT_PROJECT_ROOTS
  strayRepo = await makeRepo(path.join(fx.base, 'elsewhere', 'stray-repo'), gitEnv); // a real repo Cockpit was never told about
  ({ child, port: PORT, base: BASE } = await bootServer({ ...fx.env, COCKPIT_PROJECT_ROOTS: path.join(fx.base, 'projects') }));
});
after(() => { child?.kill('SIGTERM'); });

test('serves the UI and meta', async () => {
  const html = await (await fetch(BASE + '/')).text();
  assert.match(html, /<title>Cockpit<\/title>/);
  const meta = await (await fetch(BASE + '/api/meta')).json();
  assert.equal(meta.port, PORT);
  assert.equal(meta.version, '0.1.0');
  assert.ok(Array.isArray(meta.claudeModels));
});

test('env scan returns machine data from the configured Claude/Codex homes', async () => {
  const env = await (await fetch(BASE + '/api/env')).json();
  assert.equal(env.machine.hostname, os.hostname());
  assert.ok(env.projects.some((p) => p.path === ROOT), 'cockpit itself is a discovered project');
  assert.equal(env.tools.find((t) => t.name === 'claude').version, '9.9.9 (Claude Code)');
  assert.equal(env.claude.home, fx.claude); assert.equal(env.codex.home, fx.codex);
});

test('rejects non-local Host headers', async () => {
  const status = await new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/env', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(status, 403);
});

test('refuses credential files and paths outside allowed roots', async () => {
  // The Claude home default (~/.claude) is not an allowed root when CLAUDE_CONFIG_DIR moves it elsewhere.
  for (const p of [path.join(fx.codex, 'auth.json'), '/etc/passwd', path.join(fx.codex, 'state_5.sqlite'), path.join(fx.home, '.claude', 'settings.json')]) {
    const r = await fetch(BASE + '/api/file?path=' + encodeURIComponent(p));
    assert.equal(r.status, 403, p);
  }
});

test('file viewer serves the configured Claude/Codex homes, redacted', async () => {
  for (const p of [path.join(fx.claude, 'settings.json'), path.join(fx.claude, '.claude.json'), path.join(fx.codex, 'config.toml')]) {
    const r = await fetch(BASE + '/api/file?path=' + encodeURIComponent(p));
    assert.equal(r.status, 200, p);
    assert.doesNotMatch((await r.json()).content, /sk-ant-/, p);
  }
});

test('claude-sessions and transcripts read from the configured homes', async () => {
  const s = await (await fetch(BASE + '/api/claude-sessions?project=' + encodeURIComponent('/fixture/project'))).json();
  assert.equal(s.dir, path.join(fx.claude, 'projects', '-fixture-project'));
  assert.deepEqual(s.sessions.map((x) => [x.id, x.firstPrompt]), [['session-1', 'hello from the fixture']]);
  const codex = await (await fetch(BASE + '/api/transcript?path=' + encodeURIComponent(path.join(fx.codex, 'sessions', '2026', 'rollout-fixture.jsonl')))).json();
  assert.equal(codex.meta.sessionId, 'FIXTURE-CODEX', 'a rollout under CODEX_HOME is parsed as Codex');
  const outside = await fetch(BASE + '/api/transcript?path=' + encodeURIComponent(path.join(fx.home, '.codex', 'sessions', 'x.jsonl')));
  assert.equal(outside.status, 403);
});

test('actions are allow-listed to discovered projects and known scripts', async () => {
  const bad = await (await post('/api/actions', { action: 'npm.run', script: 'test', projectPath: '/tmp' })).json();
  assert.match(bad.error, /discovered project/);
  const badScript = await (await post('/api/actions', { action: 'npm.run', script: 'rm -rf', projectPath: ROOT })).json();
  assert.match(badScript.error, /script not in package\.json/);
  const stray = await (await post('/api/actions', { action: 'git.log', projectPath: strayRepo })).json();
  assert.match(stray.error, /discovered project/, 'being a Git repo is not enough; it must be discovered');
  const env = await (await fetch(BASE + '/api/env')).json();
  assert.ok(env.projects.some((p) => p.path === repo), 'the fixture repo is discovered through COCKPIT_PROJECT_ROOTS');
  const ok = await (await post('/api/actions', { action: 'git.log', projectPath: repo })).json();
  assert.equal(ok.run.status, 'running');
  await new Promise((r) => setTimeout(r, 1500));
  const run = await (await fetch(BASE + '/api/runs/' + ok.run.id)).json();
  assert.equal(run.status, 'complete');
  assert.match(run.chunks.map((c) => c.d).join(''), /^[0-9a-f]{7,} fixture commit$/m);
});

test('session creation validates input', async () => {
  const r = await (await post('/api/sessions', { task: '', projectPath: ROOT })).json();
  assert.ok(r.error && r.error !== 'origin not allowed', r.error);
  const r2 = await (await post('/api/sessions', { task: 'x', projectPath: '/nope' })).json();
  assert.match(r2.error, /unknown project/);
});
