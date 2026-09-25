// Credentials inside hook commands and MCP URLs never reach the scan result (/api/env), whichever file or provider they come from.
// Every secret here is fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeFixtureHomes } from './fixtures/homes.mjs';

const fx = await makeFixtureHomes();
const write = async (p, c) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c); };
const proj = path.join(fx.base, 'projects', 'app');
const CURL = (secret) => `curl -s -H "Authorization: Bearer ${secret}" https://hooks.example.com/notify`;
await write(path.join(fx.claude, 'settings.json'), JSON.stringify({ model: 'fixture-model', hooks: {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${CURL('opaqueGlobalHookFAKE')} && GITHUB_TOKEN=opaqueEnvFAKE ./check.sh --api-key opaqueFlagFAKE` }] }],
  Stop: [{ hooks: [{ type: 'http', url: 'https://me:opaqueUserinfoFAKE@hooks.example.com/stop?token=opaqueQueryFAKE' }] }],
} }));
await write(path.join(proj, 'package.json'), '{}');
await write(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: CURL('opaqueProjectHookFAKE') }] }] } }));
const ARGS = (tag) => ['-y', 'gh-server', '--api-key', `opaque${tag}FlagFAKE`, '--header', `Authorization: Bearer opaque${tag}HeaderFAKE`, `--token=opaque${tag}InlineFAKE`, '--port', '8080'];
const REDACTED_ARGS = ['-y', 'gh-server', '--api-key', '<redacted>', '--header', 'Authorization: Bearer <redacted>', '--token=<redacted>', '--port', '8080'];
await write(path.join(fx.codex, 'config.toml'), [
  'model = "fixture-codex-model"', '[mcp_servers.remote]', 'url = "https://mcp.example.com/sse?api_key=opaqueCodexMcpFAKE&team=core"',
  '[mcp_servers.gh]', 'command = "npx"', `args = ${JSON.stringify(ARGS('CodexArgs')).replace(/,/g, ', ')}`,
  'env = { GITHUB_TOKEN = "opaqueCodexEnvFAKE", LOG = "debug" }', 'http_headers = { Authorization = "Bearer opaqueCodexInlineHeaderFAKE" }',
  '[mcp_servers.gh.env_http_headers]', 'X-Trace = "TRACE_ID"', '[mcp_servers.remote.http_headers]', 'Authorization = "Bearer opaqueCodexTableHeaderFAKE"', '',
].join('\n'));
await write(path.join(fx.claude, '.claude.json'), JSON.stringify({ projects: {}, mcpServers: {
  remote: { type: 'http', url: 'https://mcp.example.com/sse?api_key=opaqueClaudeMcpFAKE&team=core' },
  gh: { command: 'npx', args: ARGS('ClaudeArgs') },
} }));
await write(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { gh: { command: 'npx', args: ARGS('ProjectArgs') } } }));
Object.assign(process.env, fx.env, { COCKPIT_PROJECT_ROOTS: path.join(fx.base, 'projects') });
const { scanEnvironment } = await import('../lib/scan.mjs');
const env = await scanEnvironment();
const text = JSON.stringify(env); // the whole scan result, so a secret cannot hide in settings, instructions or any other field

test('hook commands and hook URLs are redacted in the scan result but stay readable', () => {
  for (const raw of ['opaqueGlobalHookFAKE', 'opaqueEnvFAKE', 'opaqueFlagFAKE', 'opaqueUserinfoFAKE', 'opaqueQueryFAKE', 'opaqueProjectHookFAKE']) assert.ok(!text.includes(raw), raw);
  const cmd = (event) => env.hooks.find((h) => h.event === event).command;
  assert.equal(cmd('PreToolUse'), `${CURL('<redacted>')} && GITHUB_TOKEN=<redacted> ./check.sh --api-key <redacted>`);
  assert.equal(cmd('Stop'), 'https://me:<redacted>@hooks.example.com/stop?token=<redacted>');
  const projHook = env.hooks.find((h) => h.event === 'PostToolUse');
  assert.equal(projHook.project, proj); assert.equal(projHook.command, CURL('<redacted>'));
  assert.equal(env.claude.settings.hooks.PreToolUse[0].hooks[0].command, cmd('PreToolUse'), 'the settings object carries the same redacted command');
});

test('Codex MCP URLs are redacted the same way as Claude MCP URLs', () => {
  for (const raw of ['opaqueCodexMcpFAKE', 'opaqueClaudeMcpFAKE']) assert.ok(!text.includes(raw), raw);
  const url = (provider) => env.mcp.find((m) => m.name === 'remote' && m.provider === provider).url;
  assert.equal(url('codex'), 'https://mcp.example.com/sse?api_key=<redacted>&team=core');
  assert.equal(url('claude'), 'https://mcp.example.com/sse?api_key=<redacted>&team=core');
  assert.equal(env.codex.config.mcp_servers.remote.url, url('codex'), 'the parsed Codex config carries the same redacted URL');
});

test('credentials in MCP argument arrays are redacted element by element, from Claude, project and Codex configs', () => {
  for (const tag of ['CodexArgs', 'ClaudeArgs', 'ProjectArgs']) for (const kind of ['Flag', 'Header', 'Inline']) assert.ok(!text.includes(`opaque${tag}${kind}FAKE`), tag + kind);
  const gh = env.mcp.filter((m) => m.name === 'gh');
  assert.deepEqual(gh.map((m) => m.provider + ':' + m.scope).sort(), ['claude:GLOBAL', 'claude:PROJECT', 'codex:GLOBAL']);
  for (const m of gh) assert.deepEqual(m.args, REDACTED_ARGS, m.provider + ':' + m.scope);
  assert.deepEqual(env.codex.config.mcp_servers.gh.args, REDACTED_ARGS, 'the parsed Codex config carries the same redacted args');
});

test('unquoted TOML sensitive keys are redacted in the Codex config text and the parsed config', () => {
  for (const raw of ['opaqueCodexEnvFAKE', 'opaqueCodexInlineHeaderFAKE', 'opaqueCodexTableHeaderFAKE']) assert.ok(!text.includes(raw), raw);
  const cfg = env.codex.config.mcp_servers;
  assert.deepEqual(cfg.gh.env, { GITHUB_TOKEN: '<redacted>', LOG: 'debug' });
  assert.deepEqual(cfg.gh.http_headers, { Authorization: '<redacted>' });
  assert.deepEqual(cfg.remote.http_headers, { Authorization: '<redacted>' });
  assert.deepEqual(env.mcp.find((m) => m.name === 'gh' && m.provider === 'codex').envNames, ['GITHUB_TOKEN', 'LOG'], 'env names come from the parsed inline table');
  assert.match(env.codex.configText, /^env = \{ GITHUB_TOKEN = "<redacted>", LOG = "debug" \}$/m);
  assert.match(env.codex.configText, /^Authorization = "<redacted>"$/m);
});
