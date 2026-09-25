// The ad-hoc codex.review action sends the project's uncommitted diff to Codex, an external provider, so the diff goes through the same
// redactDiff as workflow reviews. The local "show full diff" view (GET /api/git/diff) is for the user's own eyes and stays raw.
// Every secret here is fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixtureHomes } from './fixtures/homes.mjs';
import { bootServer } from './fixtures/server.mjs';

const SECRET = 'opaqueAdhocKeyFAKE';
let server, fx, proj, promptFile;
const write = async (p, c) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c); };
const post = (p, body) => fetch(server.base + p, { method: 'POST', headers: { origin: server.base, 'content-type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  fx = await makeFixtureHomes();
  proj = path.join(fx.base, 'projects', 'app');
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: proj, stdio: 'pipe' });
  await write(path.join(proj, 'package.json'), '{}\n');
  await write(path.join(proj, 'src', 'app.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  await write(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ model: 'old-model' }, null, 2) + '\n');
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  // Uncommitted changes: ordinary code, and a credential added to project settings.
  await write(path.join(proj, 'src', 'app.js'), 'export function add(a, b) {\n  if (typeof a !== \'number\') throw new TypeError(\'a\');\n  return a + b;\n}\n');
  await write(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ model: 'new-model', env: { ANTHROPIC_API_KEY: `sk-ant-${SECRET}0123` } }, null, 2) + '\n');
  // Stand-in codex, first on PATH: answers --version for the scan, and otherwise keeps the prompt it receives on stdin.
  promptFile = path.join(fx.base, 'codex-prompt.txt');
  const bin = path.join(fx.base, 'review-bin');
  await write(path.join(bin, 'codex'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 8.8.8"; exit 0; fi\ncat > '${promptFile}'\n`);
  await fs.chmod(path.join(bin, 'codex'), 0o755);
  server = await bootServer({ ...fx.env, PATH: bin + path.delimiter + fx.env.PATH, COCKPIT_PROJECT_ROOTS: path.join(fx.base, 'projects') });
});
after(() => { server?.child.kill('SIGTERM'); });

test('codex.review sends Codex a redacted diff that keeps filenames, hunks and ordinary code', async () => {
  const res = await post('/api/actions', { action: 'codex.review', projectPath: proj });
  assert.equal(res.status, 200);
  const { run } = await res.json();
  assert.match(run.label, /codex exec --sandbox read-only · ad-hoc review/);
  let status = run.status;
  for (let i = 0; i < 100 && status === 'running'; i++) { await new Promise((r) => setTimeout(r, 50)); status = (await (await fetch(`${server.base}/api/runs/${run.id}`)).json()).status; }
  assert.equal(status, 'complete');
  const prompt = await fs.readFile(promptFile, 'utf8');
  assert.ok(!prompt.includes(SECRET), 'the credential never reaches Codex');
  assert.match(prompt, /^You are a read-only code reviewer\./, 'prompt shape unchanged');
  assert.match(prompt, /^DIFF:$/m);
  assert.match(prompt, /^diff --git a\/\.claude\/settings\.json b\/\.claude\/settings\.json$/m);
  assert.match(prompt, /^diff --git a\/src\/app\.js b\/src\/app\.js$/m);
  assert.match(prompt, /^@@ /m);
  assert.match(prompt, /^-  "model": "old-model"$/m); assert.match(prompt, /^\+  "model": "new-model",$/m);
  assert.match(prompt, /^\+    "ANTHROPIC_API_KEY": "<redacted>"$/m);
  assert.match(prompt, /^\+  if \(typeof a !== 'number'\) throw new TypeError\('a'\);$/m);
});

test('codex.review still refuses a project that was not discovered, without starting Codex', async () => {
  await fs.rm(promptFile, { force: true });
  const res = await post('/api/actions', { action: 'codex.review', projectPath: fx.base });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /discovered project/);
  assert.equal(await fs.stat(promptFile).catch(() => null), null);
});

test('the local "show full diff" view still returns the real diff', async () => {
  const d = await (await fetch(`${server.base}/api/git/diff?path=${encodeURIComponent(proj)}`)).json();
  assert.ok(d.diff.includes(SECRET), 'local display is intentionally unredacted');
});
