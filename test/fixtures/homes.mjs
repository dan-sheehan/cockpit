// Builds a throwaway machine for tests: HOME, CLAUDE_CONFIG_DIR and CODEX_HOME in a temp dir, plus stub `claude`/`codex`
// executables first on PATH. Tests then never read the real ~/.claude or ~/.codex and never need either CLI installed.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const FAKE_SECRET = 'sk-ant-fixture0123456789abcdef';

export async function makeFixtureHomes() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-homes-')));
  const home = path.join(base, 'home'), claude = path.join(base, 'claude-config'), codex = path.join(base, 'codex-home'), bin = path.join(base, 'bin');
  const write = async (p, content) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, content); };

  // Decoy at the default location: with CLAUDE_CONFIG_DIR set, Cockpit must neither read nor serve it.
  await write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'decoy-default-location' }));

  await write(path.join(claude, 'settings.json'), JSON.stringify({ model: 'fixture-model', env: { ANTHROPIC_API_KEY: FAKE_SECRET } }));
  await write(path.join(claude, '.claude.json'), JSON.stringify({ projects: {}, mcpServers: { fixture: { command: 'fixture-mcp', args: [] } } }));
  await write(path.join(claude, 'skills', 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: from the fixture\n---\nbody\n');
  await write(path.join(claude, 'projects', '-fixture-project', 'session-1.jsonl'), JSON.stringify({ type: 'user', cwd: '/fixture/project', message: { role: 'user', content: 'hello from the fixture' } }) + '\n');

  await write(path.join(codex, 'config.toml'), `model = "fixture-codex-model"\napi_key = "${FAKE_SECRET}"\n`);
  await write(path.join(codex, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: FAKE_SECRET }));
  await write(path.join(codex, 'state_5.sqlite'), '');
  await write(path.join(codex, 'sessions', '2026', 'rollout-fixture.jsonl'), JSON.stringify({ timestamp: 't0', type: 'session_meta', payload: { id: 'FIXTURE-CODEX', cwd: '/fixture/project', cli_version: '8.8.8' } }) + '\n');

  await write(path.join(bin, 'claude'), '#!/bin/sh\necho "9.9.9 (Claude Code)"\n');
  await write(path.join(bin, 'codex'), '#!/bin/sh\necho "codex-cli 8.8.8"\n');
  // Stand-in osascript: records its argv (NUL-separated, one file per call) and never drives Terminal.app.
  const osascriptCalls = path.join(base, 'osascript-calls');
  await write(path.join(bin, 'osascript'), `#!/bin/sh\nmkdir -p '${osascriptCalls}' && printf '%s\\0' "$@" > '${osascriptCalls}'/$$.args\n`);
  for (const b of ['claude', 'codex', 'osascript']) await fs.chmod(path.join(bin, b), 0o755);

  return {
    base, home, claude, codex, osascriptCalls,
    env: { HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, PATH: bin + path.delimiter + process.env.PATH },
  };
}

// The argv of every stand-in osascript call so far.
export async function readOsascriptCalls(fx) {
  const files = await fs.readdir(fx.osascriptCalls).catch(() => []);
  return Promise.all(files.map(async (f) => (await fs.readFile(path.join(fx.osascriptCalls, f), 'utf8')).split('\0').slice(0, -1)));
}
