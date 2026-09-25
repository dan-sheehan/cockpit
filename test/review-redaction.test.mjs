// Project settings quoted in the Codex review prompt pass through the same redaction the scanner applies before /api/env:
// credentials are removed, the settings structure stays readable, and prose instructions are quoted unchanged. Every secret here is fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { treeSnapshot, diffSince } from '../lib/git.mjs';
import { makeFixtureHomes } from './fixtures/homes.mjs';
import { bootServer } from './fixtures/server.mjs';

const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-review-')));
process.env.COCKPIT_DATA_DIR = path.join(base, 'data');
const { reviewInstructionTexts, reviewDiffText, redactDiff, captureDiff, getSession } = await import('../lib/workflow.mjs');
const write = async (p, c) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c); };

const proj = path.join(base, 'app');
const SETTINGS = {
  model: 'fixture-model',
  permissions: { allow: ['Bash(npm test*)', 'Read'], deny: ['Bash(rm *)'] },
  env: { ANTHROPIC_API_KEY: 'sk-ant-opaqueEnvKeyFAKE0123', GITHUB_TOKEN: 'ghp_opaqueGithubFAKE0123', LOG_LEVEL: 'debug' },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'curl -s -H "Authorization: Bearer opaqueHookHeaderFAKE" https://hooks.example.com/notify' }] }],
    Stop: [{ hooks: [{ type: 'http', url: 'https://hooks.example.com/stop?token=opaqueHookQueryFAKE&team=core' }] }],
  },
};
const SECRETS = ['opaqueEnvKeyFAKE', 'opaqueGithubFAKE', 'opaqueHookHeaderFAKE', 'opaqueHookQueryFAKE', 'opaqueLocalFAKE', 'opaqueBrokenFAKE'];
const PROSE = '# App\n\nRun `npm test` before finishing. Keep functions small.\n';
await write(path.join(proj, 'CLAUDE.md'), PROSE);
await write(path.join(proj, 'AGENTS.md'), PROSE);
await write(path.join(proj, '.claude', 'settings.json'), JSON.stringify(SETTINGS, null, 2));
await write(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify({ apiKeyHelper: '/usr/local/bin/opaqueLocalFAKE', permissions: { allow: ['WebFetch'] } }));
const at = (rel, kind) => ({ path: path.join(proj, rel), kind });

test('credentials in project settings never reach the review input, while the settings structure stays visible', async () => {
  const texts = await reviewInstructionTexts(proj, [at('.claude/settings.json', 'settings'), at('.claude/settings.local.json', 'settings')]);
  const joined = texts.join('\n');
  for (const s of SECRETS) assert.ok(!joined.includes(s), s);
  const [settings, local] = texts.map((t) => JSON.parse(t.slice(t.indexOf('\n') + 1)));
  assert.equal(settings.model, 'fixture-model');
  assert.deepEqual(settings.permissions, SETTINGS.permissions);
  assert.deepEqual(settings.env, { ANTHROPIC_API_KEY: '<redacted>', GITHUB_TOKEN: '<redacted>', LOG_LEVEL: 'debug' });
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'curl -s -H "Authorization: Bearer <redacted>" https://hooks.example.com/notify');
  assert.equal(settings.hooks.Stop[0].hooks[0].url, 'https://hooks.example.com/stop?token=<redacted>&team=core');
  assert.deepEqual(local, { apiKeyHelper: '<redacted>', permissions: { allow: ['WebFetch'] } });
});

test('settings that are not valid JSON are still redacted as text', async () => {
  await write(path.join(proj, '.claude', 'settings.local.json'), '{\n  "model": "fixture-model",\n  "env": { "API_TOKEN": "opaqueBrokenFAKE" },\n}\n');
  const [text] = await reviewInstructionTexts(proj, [at('.claude/settings.local.json', 'settings')]);
  assert.ok(!text.includes('opaqueBrokenFAKE'));
  assert.match(text, /"model": "fixture-model"/);
  assert.match(text, /"API_TOKEN": "<redacted>"/);
});

test('prose instructions are quoted unchanged, and an escaping settings symlink is still not read', async () => {
  await write(path.join(base, 'outside', 'settings.json'), JSON.stringify({ model: 'OUTSIDE_MARKER' }));
  await fs.rm(path.join(proj, '.claude', 'settings.local.json'));
  await fs.symlink(path.join(base, 'outside', 'settings.json'), path.join(proj, '.claude', 'settings.local.json'));
  const texts = await reviewInstructionTexts(proj, [at('CLAUDE.md', 'instructions'), at('AGENTS.md', 'instructions'), at('.claude/settings.local.json', 'settings')]);
  assert.deepEqual(texts, [`--- ${path.join(proj, 'CLAUDE.md')}\n${PROSE}`, `--- ${path.join(proj, 'AGENTS.md')}\n${PROSE}`, `--- ${path.join(proj, '.claude', 'settings.local.json')}\n`]);
});

// A real repository diffed the way the review stage does it (treeSnapshot before, diffSince after), so the diff has git's own shape.
async function repoDiff(name, before, after) {
  const repo = path.join(base, name);
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' });
  for (const [rel, c] of Object.entries(before)) await write(path.join(repo, rel), c);
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  const snapshot = await treeSnapshot(repo);
  for (const [rel, c] of Object.entries(after)) await write(path.join(repo, rel), c);
  return (await diffSince(repo, snapshot)).diff;
}
const CODE_BEFORE = { 'src/app.js': 'export function add(a, b) {\n  return a + b;\n}\n', 'README.md': '# Demo\n' };
const CODE_AFTER = { 'src/app.js': 'export function add(a, b) {\n  if (typeof a !== \'number\') throw new TypeError(\'a\');\n  return a + b;\n}\n\nexport const url = \'https://example.com/docs?page=2\';\n', 'README.md': '# Demo\n\nAdds numbers.\n' };

test('redactDiff: credentials changed in a diff are removed; diff structure and harmless changes stay', async () => {
  const diff = await repoDiff('diff-secrets', {
    ...CODE_BEFORE,
    '.claude/settings.json': JSON.stringify({ model: 'old-model' }, null, 2) + '\n',
    'deploy.env': 'REGION=eu\nOLD_TOKEN=opaqueRemovedFAKE\n',
  }, {
    ...CODE_AFTER,
    '.claude/settings.json': JSON.stringify({ model: 'new-model', env: { ANTHROPIC_API_KEY: 'sk-ant-opaqueDiffKeyFAKE0123', LOG_LEVEL: 'debug' } }, null, 2) + '\n',
    'deploy.env': 'REGION=eu\nAPI_KEY=opaqueEnvLineFAKE\n',
  });
  const secrets = ['opaqueDiffKeyFAKE', 'opaqueRemovedFAKE', 'opaqueEnvLineFAKE'];
  for (const s of secrets) assert.ok(diff.includes(s), `fixture: ${s} is in the raw diff`);
  const out = redactDiff(diff);
  for (const s of secrets) assert.ok(!out.includes(s), s);
  assert.match(out, /^diff --git a\/\.claude\/settings\.json b\/\.claude\/settings\.json$/m);
  assert.match(out, /^\+\+\+ b\/deploy\.env$/m); assert.match(out, /^@@ /m);
  assert.match(out, /^-  "model": "old-model"$/m); assert.match(out, /^\+  "model": "new-model",$/m);
  assert.match(out, /^\+    "ANTHROPIC_API_KEY": "<redacted>",$/m); assert.match(out, /^\+    "LOG_LEVEL": "debug"$/m);
  assert.match(out, /^-OLD_TOKEN=<redacted>$/m); assert.match(out, /^\+API_KEY=<redacted>$/m); assert.match(out, /^ REGION=eu$/m);
  assert.ok(out.includes(diff.slice(diff.indexOf('diff --git a/README.md'), diff.indexOf('diff --git a/deploy.env'))), 'the README and code hunks are untouched');
});

// Hand-written in git's format: new files (which diffSince lists but does not diff when untracked) and credential lines whose redaction
// rule needs the start of the line or spans lines.
test('redactDiff: credentials in new files and in lines a diff marker would hide are redacted too', async () => {
  const diff = [
    'diff --git a/.mcp.json b/.mcp.json', 'new file mode 100644', '--- /dev/null', '+++ b/.mcp.json', '@@ -0,0 +1,9 @@',
    '+{', '+  "mcpServers": {', '+    "gh": {', '+      "args": [', '+        "--api-key",', '+        "opaqueArgFAKE"', '+      ],',
    '+      "url": "https://mcp.example.com/sse?token=opaqueUrlFAKE&team=core"', '+    }', '+  }', '+}',
    'diff --git a/config.toml b/config.toml', '--- a/config.toml', '+++ b/config.toml', '@@ -1 +1,2 @@', ' model = "m"', '+api_key = "opaqueTomlFAKE"',
    'diff --git a/request.http b/request.http', '--- a/request.http', '+++ b/request.http', '@@ -1,2 +1,2 @@', ' GET https://api.example.com/', '-Authorization: Bearer opaqueHeaderFAKE',
    '+Authorization: Bearer opaqueHeader2FAKE', 'diff --git a/.netrc b/.netrc', '--- a/.netrc', '+++ b/.netrc', '@@ -0,0 +1 @@', '+machine api.example.com login me password opaqueNetrcFAKE',
    'diff --git a/deploy.pem b/deploy.pem', '--- /dev/null', '+++ b/deploy.pem', '@@ -0,0 +1,3 @@', '+-----BEGIN OPENSSH PRIVATE KEY-----', '+b3BlbnNzaC1rZXktdjEAAAAAopaqueKeyBodyFAKE', '+-----END OPENSSH PRIVATE KEY-----', '',
  ].join('\n');
  const out = redactDiff(diff);
  for (const s of ['opaqueArgFAKE', 'opaqueUrlFAKE', 'opaqueTomlFAKE', 'opaqueHeaderFAKE', 'opaqueHeader2FAKE', 'opaqueNetrcFAKE', 'opaqueKeyBodyFAKE']) assert.ok(!out.includes(s), s);
  assert.match(out, /^\+        "--api-key",$/m);
  assert.match(out, /^\+      "url": "https:\/\/mcp\.example\.com\/sse\?token=<redacted>&team=core"$/m);
  assert.match(out, /^-Authorization: Bearer <redacted>$/m); assert.match(out, /^\+Authorization: Bearer <redacted>$/m);
  assert.match(out, /^\+machine api\.example\.com login me password <redacted>$/m);
  assert.match(out, /^ model = "m"$/m); assert.match(out, /^\+\+\+ b\/deploy\.pem$/m);
});

test('an ordinary code diff is left unchanged, and the review prompt keeps its placeholder and cap', async () => {
  const diff = await repoDiff('diff-code', CODE_BEFORE, CODE_AFTER);
  assert.match(diff, /^\+  if \(typeof a/m);
  assert.equal(redactDiff(diff), diff);
  assert.equal(reviewDiffText(null), '(no git diff available; inspect the working tree directly)');
  assert.equal(reviewDiffText({ diff: 'x'.repeat(130000) }).length, 120000, 'still capped at 120000 characters');
});

// Through the real path: captureDiff on a real repo, the session file its debounced save writes, getSession (what GET /api/sessions/:id
// returns), the real server's sessions API serving that file, and the review prompt text built from the stored entry.
test('captureDiff stores only the redacted diff, and the session file, sessions API and review prompt all carry that version', async (t) => {
  const repo = path.join(base, 'diff-capture');
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' });
  await write(path.join(repo, 'src', 'app.js'), CODE_BEFORE['src/app.js']);
  await write(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ model: 'old-model' }, null, 2) + '\n');
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  const s = { id: 'ses_diffcapture' + Date.now(), kind: 'collaboration', createdAt: new Date().toISOString(), status: 'running', stages: [], events: [], findings: [], artifacts: { diffs: [] }, _project: { path: repo }, _snapshot: await treeSnapshot(repo) };
  await write(path.join(repo, 'src', 'app.js'), CODE_AFTER['src/app.js']);
  await write(path.join(repo, '.claude', 'settings.json'), JSON.stringify({ model: 'new-model', env: { ANTHROPIC_API_KEY: 'sk-ant-opaqueCaptureFAKE0123' } }, null, 2) + '\n');
  const SECRET = 'opaqueCaptureFAKE';
  const entry = await captureDiff(s, 'after implement');

  assert.equal(s.artifacts.diffs[0], entry);
  assert.ok(!entry.diff.includes(SECRET));
  assert.match(entry.diff, /^diff --git a\/\.claude\/settings\.json b\/\.claude\/settings\.json$/m); assert.match(entry.diff, /^@@ /m);
  assert.match(entry.diff, /^-  "model": "old-model"$/m); assert.match(entry.diff, /^\+  "model": "new-model",$/m);
  assert.match(entry.diff, /^\+    "ANTHROPIC_API_KEY": "<redacted>"$/m);
  assert.match(entry.diff, /^\+  if \(typeof a !== 'number'\) throw new TypeError\('a'\);$/m, 'ordinary code is kept');
  assert.deepEqual(entry.changed.map((c) => c.path).sort(), ['.claude/settings.json', 'src/app.js']);
  assert.equal(entry.truncated, false);
  assert.equal(reviewDiffText(entry), entry.diff, 'the review prompt quotes the stored, already-redacted diff as is');

  const file = path.join(process.env.COCKPIT_DATA_DIR, 'sessions', s.id + '.json');
  let saved = null;
  for (let i = 0; i < 40 && !saved?.includes('after implement'); i++) { await new Promise((r) => setTimeout(r, 50)); saved = await fs.readFile(file, 'utf8').catch(() => null); }
  assert.ok(saved, 'the debounced session save was written');
  assert.ok(!saved.includes(SECRET), 'the session file holds only the redacted diff');
  assert.equal(JSON.parse(saved).artifacts.diffs[0].diff, entry.diff);
  assert.equal((await getSession(s.id)).artifacts.diffs[0].diff, entry.diff);

  const fx = await makeFixtureHomes();
  const server = await bootServer(fx.env);
  t.after(() => server.child.kill());
  await write(path.join(os.tmpdir(), 'cockpit-test-data-' + server.port, 'sessions', s.id + '.json'), saved);
  const res = await fetch(`${server.base}/api/sessions/${s.id}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(!body.includes(SECRET), 'the sessions API serves only the redacted diff');
  assert.equal(JSON.parse(body).artifacts.diffs[0].diff, entry.diff);
});
