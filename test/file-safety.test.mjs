// Filesystem safety through the real server: credential files are refused, secrets inside viewable files are redacted,
// Claude's history.jsonl is refused like any other history.jsonl, and paths recorded by Claude/Codex never make a huge region a project.
// Every secret here is fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeFixtureHomes } from './fixtures/homes.mjs';
import { bootServer } from './fixtures/server.mjs';

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAFAKEFAKEFAKEBODY\n-----END OPENSSH PRIVATE KEY-----\n';
let server, fx, proj;
const write = async (p, c) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c); };
const get = (p) => fetch(server.base + '/api/file?path=' + encodeURIComponent(p));
const post = (p, body) => fetch(server.base + p, { method: 'POST', headers: { origin: server.base, 'content-type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  fx = await makeFixtureHomes();
  proj = path.join(fx.base, 'projects', 'app');
  for (const [rel, c] of Object.entries({
    'README.md': '# app\n',
    'keys/id_rsa': KEY, 'keys/id_ed25519': KEY, 'keys/id_ecdsa': KEY, 'keys/id_dsa': KEY, 'keys/id_ecdsa.pub': 'ecdsa-sha2-nistp256 AAAAfake me\n', 'keys/server.pem': KEY,
    '.netrc': 'machine api.example.com login me password hunter2fake\n', '.npmrc': '//registry.npmjs.org/:_authToken=npm_FakeToken0123456789abcdefghijklmnopq\n',
    'aws/credentials': '[default]\naws_access_key_id = AKIAFAKE00000000\n', '.credentials': 'x', '.credentials.json': '{}', '.git-credentials': 'https://me:fake@example.com\n',
    'auth.json': '{}', 'state.sqlite': '', '.env': 'A=1\n', '.env.local': 'A=1\n', 'history.jsonl': '{}\n',
    'docs/setup.md': 'Install:\n' + KEY + 'Then run it.\n',
    'ci/publish.txt': 'registry=https://registry.example\n//registry.example/:_authToken=fakeOpaqueToken123\nmachine ci.example login bot password alsoFake\n',
    '.mcp.json': JSON.stringify({ mcpServers: { remote: { type: 'http', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer opaqueMcpHeaderFAKE' } } } }, null, 2) + '\n',
  })) await write(path.join(proj, rel), c);
  await write(path.join(fx.claude, 'history.jsonl'), '{"display":"a prompt"}\n');
  for (const f of ['history-backup.sqlite', 'history.sqlite']) await write(path.join(fx.claude, f), 'fake');
  await write(path.join(fx.claude, 'history', 'id_rsa'), KEY);
  await write(path.join(fx.codex, 'history.jsonl'), '{}\n');
  await write(path.join(fx.home, '.claude', 'history.jsonl'), '{}\n'); // the default location, unused because CLAUDE_CONFIG_DIR is set
  await write(path.join(fx.home, '.ssh', 'config'), 'Host fake\n');
  // Paths Claude/Codex might have recorded: the filesystem root, an ancestor of HOME (directly and via a symlink), HOME, and two legitimate projects.
  await write(path.join(fx.home, 'code', 'site', 'package.json'), '{}');
  await write(path.join(fx.base, 'elsewhere', 'tool', 'package.json'), '{}');
  await fs.symlink(fx.base, path.join(fx.base, 'elsewhere', 'up'));
  await write(path.join(fx.claude, '.claude.json'), JSON.stringify({ projects: { '/': {}, [fx.base]: {}, [fx.home]: {}, [path.join(fx.base, 'elsewhere', 'up')]: {}, [path.join(fx.home, 'code', 'site')]: {} } }));
  await write(path.join(fx.codex, 'config.toml'), `[projects."/"]\ntrust_level = "trusted"\n[projects."${fx.base}"]\ntrust_level = "trusted"\n[projects."${path.join(fx.base, 'elsewhere', 'tool')}"]\ntrust_level = "trusted"\n`);
  // Instruction-type files, each with visible text and fake secrets of several kinds.
  const secrets = (tag) => `VISIBLE-${tag} stays readable.\nuse sk-ant-api03-FAKEFAKE${tag}0000 for the api\nnpm token npm_FAKEnpmTOKEN0123456789abcdefghijklmnop\n-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEKEYBODY${tag}\n-----END OPENSSH PRIVATE KEY-----\napi_key = plainFake${tag}\n`;
  for (const [file, tag, prefix = ''] of [
    [path.join(fx.claude, 'CLAUDE.md'), 'globalclaudemd'], [path.join(proj, 'CLAUDE.md'), 'projclaudemd'], [path.join(proj, 'CLAUDE.local.md'), 'projlocalmd'],
    [path.join(proj, 'AGENTS.md'), 'projagentsmd'], [path.join(fx.codex, 'AGENTS.md'), 'codexagentsmd'],
    [path.join(fx.claude, 'projects', proj.replace(/[\/.]/g, '-'), 'memory', 'MEMORY.md'), 'memorymd'],
    [path.join(fx.claude, 'rules', 'house.md'), 'clauderule'], [path.join(fx.codex, 'rules', 'default.rules'), 'codexrule'],
    [path.join(fx.claude, 'skills', 'deploy', 'SKILL.md'), 'skillbody', '---\nname: deploy\ndescription: deploy with ghp_FAKEdescriptionTOKEN12345\n---\n'],
    [path.join(proj, '.claude', 'skills', 'local', 'SKILL.md'), 'projskill', '---\nname: local\n---\n'],
    [path.join(fx.claude, 'agents', 'helper.md'), 'agentbody', '---\nname: helper\n---\n'], [path.join(proj, '.claude', 'agents', 'reviewer.md'), 'projagent', '---\nname: reviewer\n---\n'],
    [path.join(fx.claude, 'commands', 'ship.md'), 'commandbody', '---\nname: ship\n---\n'], [path.join(proj, '.claude', 'commands', 'check.md'), 'projcommand', '---\nname: check\n---\n'],
    [path.join(fx.claude, 'plans', 'plan.md'), 'plan', '# Plan with sk-ant-api03-FAKEPLANTITLE0000\n'],
  ]) await write(file, prefix + secrets(tag));
  server = await bootServer({ ...fx.env, COCKPIT_PROJECT_ROOTS: path.join(fx.base, 'projects') });
});
after(() => { server?.child.kill('SIGTERM'); });

test('credential and key files are refused wherever they sit inside an allowed root', async () => {
  for (const rel of ['keys/id_rsa', 'keys/id_ed25519', 'keys/id_ecdsa', 'keys/id_dsa', 'keys/id_ecdsa.pub', 'keys/server.pem', '.netrc', '.npmrc', 'aws/credentials', '.credentials', '.credentials.json', '.git-credentials', 'auth.json', 'state.sqlite', '.env', '.env.local']) {
    assert.equal((await get(path.join(proj, rel))).status, 403, rel);
  }
  assert.equal((await get(path.join(proj, 'README.md'))).status, 200, 'ordinary project files stay viewable');
});

test('secrets inside viewable files are redacted: private-key bodies, npm auth tokens, netrc passwords', async () => {
  const setup = (await (await get(path.join(proj, 'docs', 'setup.md'))).json()).content;
  assert.equal(setup, 'Install:\n<redacted>\nThen run it.\n');
  const ci = (await (await get(path.join(proj, 'ci', 'publish.txt'))).json()).content;
  assert.ok(!ci.includes('fakeOpaqueToken123') && !ci.includes('alsoFake'), ci);
  assert.match(ci, /^registry=https:\/\/registry\.example$/m, 'the safe part of the file is still shown');
});

test('secrets in viewable JSON config are redacted key by key, and the JSON stays readable', async () => {
  const mcp = (await (await get(path.join(proj, '.mcp.json'))).json()).content;
  assert.ok(!mcp.includes('opaqueMcpHeaderFAKE'), mcp);
  assert.match(mcp, /^ {8}"Authorization": "<redacted>"$/m);
  assert.match(mcp, /"url": "https:\/\/mcp\.example\.com\/sse",$/m, 'non-secret values are untouched');
});

test('no history.jsonl is viewable, not even Claude\'s own; the recent-prompts list still comes from the scan', async () => {
  const env = await (await fetch(server.base + '/api/env')).json();
  assert.deepEqual(env.claude.history.map((x) => x.display), ['a prompt'], 'the scanner, not the file viewer, feeds recent prompts');
  for (const p of [
    path.join(fx.claude, 'history.jsonl'),
    path.join(fx.claude, 'history-backup.sqlite'), path.join(fx.claude, 'history.sqlite'), path.join(fx.claude, 'history', 'id_rsa'),
    path.join(proj, 'history.jsonl'), path.join(fx.codex, 'history.jsonl'), path.join(fx.home, '.claude', 'history.jsonl'),
  ]) assert.equal((await get(p)).status, 403, p);
});

test('paths recorded by Claude/Codex never make the filesystem root, HOME or an ancestor of HOME a project', async () => {
  const env = await (await fetch(server.base + '/api/env')).json();
  const paths = env.projects.map((p) => p.path);
  for (const p of ['/', fx.base, fx.home, path.join(fx.base, 'elsewhere', 'up')]) assert.ok(!paths.includes(p), p);
  for (const p of [path.join(fx.home, 'code', 'site'), path.join(fx.base, 'elsewhere', 'tool'), proj]) assert.ok(paths.includes(p), p);
  assert.equal((await get(path.join(fx.home, '.ssh', 'config'))).status, 403, 'HOME is not reachable through an ancestor project');
  const r = await (await post('/api/actions', { action: 'git.status', projectPath: '/' })).json();
  assert.match(r.error, /discovered project/);
});

test('/api/env carries instruction files (CLAUDE.md, AGENTS.md, memory, rules, skills, agents, commands) redacted like the file viewer', async () => {
  const text = await (await fetch(server.base + '/api/env')).text(); // the whole serialized response, so a secret cannot hide in any field
  for (const raw of ['sk-ant-api03-FAKE', 'npm_FAKEnpmTOKEN', 'FAKEKEYBODY', 'plainFake', 'ghp_FAKEdescription']) assert.ok(!text.includes(raw), raw);
  for (const tag of ['globalclaudemd', 'projclaudemd', 'projlocalmd', 'projagentsmd', 'codexagentsmd', 'memorymd', 'clauderule', 'codexrule', 'skillbody', 'projskill', 'agentbody', 'projagent', 'commandbody', 'projcommand']) {
    assert.ok(text.includes(`VISIBLE-${tag} stays readable.`), 'ordinary text survives: ' + tag);
  }
  const env = JSON.parse(text);
  assert.ok(env.skills.some((k) => k.name === 'deploy' && /^deploy with <redacted>/.test(k.description)), 'frontmatter fields are redacted too');
  assert.ok(env.instructions.some((i) => i.path === path.join(proj, 'CLAUDE.md') && i.content.includes('api_key = <redacted>')));
});
