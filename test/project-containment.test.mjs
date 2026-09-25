// Project-scoped files are read only when they really lie inside the project: a symlink that escapes the project root is treated as
// missing by the scanner (/api/env) and by the Codex review prompt, while ordinary files and symlinks that stay inside still work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeFixtureHomes } from './fixtures/homes.mjs';

const fx = await makeFixtureHomes();
const MARK = 'OUTSIDE_MARKER'; // every file outside the projects carries it; it must never reach a result
const write = async (p, c) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c); };
const link = async (target, p) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.symlink(target, p); };

const outside = path.join(fx.base, 'outside');
await write(path.join(outside, 'private.txt'), `${MARK} private notes\n`);
await write(path.join(outside, 'settings.json'), JSON.stringify({ model: `${MARK}-settings` }));
await write(path.join(outside, 'mcp.json'), JSON.stringify({ mcpServers: { [`${MARK}-mcp`]: { command: 'x' } } }));
await write(path.join(outside, 'package.json'), JSON.stringify({ name: `${MARK}-pkg`, scripts: { test: MARK } }));
await write(path.join(outside, 'command.md'), `---\ndescription: ${MARK} command\n---\n`);
await write(path.join(outside, 'agent.md'), `---\nname: ${MARK}-agent\ndescription: ${MARK}\n---\n${MARK} body\n`);
await write(path.join(outside, 'skills', 'evil', 'SKILL.md'), `---\nname: ${MARK}-dir-skill\n---\n${MARK}\n`);
await write(path.join(outside, 'dotclaude', 'settings.json'), JSON.stringify({ model: `${MARK}-dotclaude` }));
await write(path.join(outside, 'dotclaude', 'commands', 'x.md'), `${MARK} x\n`);
await write(path.join(outside, 'dotclaude', `${MARK}-entry`), '');

const projects = path.join(fx.base, 'projects');
// `normal`: plain files, plus symlinks that resolve inside the same project.
const normal = path.join(projects, 'normal');
await write(path.join(normal, 'package.json'), JSON.stringify({ name: 'normal', scripts: { test: 'node --test' } }));
await write(path.join(normal, 'CLAUDE.md'), 'normal project instructions\n');
await write(path.join(normal, 'docs', 'agents.md'), 'agents text via an inside symlink\n');
await link(path.join('docs', 'agents.md'), path.join(normal, 'AGENTS.md'));
await write(path.join(normal, 'config', 'settings.json'), JSON.stringify({ model: 'inside-model' }));
await link(path.join('..', 'config', 'settings.json'), path.join(normal, '.claude', 'settings.json'));
await write(path.join(normal, 'docs', 'cmd.md'), '---\ndescription: inside command\n---\n');
await link(path.join('..', '..', 'docs', 'cmd.md'), path.join(normal, '.claude', 'commands', 'inside.md'));
await write(path.join(normal, '.claude', 'agents', 'helper.md'), '---\nname: helper\ndescription: inside agent\n---\nbody\n');
await write(path.join(normal, '.claude', 'skills', 'good', 'SKILL.md'), '---\nname: good-skill\n---\ninside skill\n');
// `leaky`: every project-scoped file the scanner reads points outside the project. `leakyx` is a sibling whose path shares the prefix.
const leaky = path.join(projects, 'leaky');
await write(path.join(projects, 'leakyx', 'secret.md'), `${MARK} sibling with a shared prefix\n`);
await link(path.join('..', '..', 'outside', 'private.txt'), path.join(leaky, 'CLAUDE.md'));
await link(path.join(outside, 'private.txt'), path.join(leaky, 'AGENTS.md'));
await link(path.join('..', 'leakyx', 'secret.md'), path.join(leaky, 'CLAUDE.local.md'));
await link(path.join(outside, 'package.json'), path.join(leaky, 'package.json'));
await link(path.join(outside, 'mcp.json'), path.join(leaky, '.mcp.json'));
await link(path.join(outside, 'settings.json'), path.join(leaky, '.claude', 'settings.json'));
await link(path.join(outside, 'settings.json'), path.join(leaky, '.claude', 'settings.local.json'));
await link(path.join(outside, 'private.txt'), path.join(leaky, '.claude', 'swag.md'));
await link(path.join(outside, 'command.md'), path.join(leaky, '.claude', 'commands', 'leak.md'));
await link(path.join(outside, 'agent.md'), path.join(leaky, '.claude', 'agents', 'leak.md'));
await link(path.join(outside, 'private.txt'), path.join(leaky, '.claude', 'skills', 'leak', 'SKILL.md'));
await link(path.join(outside, 'skills'), path.join(leaky, '.agents', 'skills'));
// `dotlink`: the whole .claude directory is a symlink out of the project.
const dotlink = path.join(projects, 'dotlink');
await write(path.join(dotlink, 'package.json'), '{}');
await link(path.join(outside, 'dotclaude'), path.join(dotlink, '.claude'));

// Projects are discovered through an alias of the projects folder, so containment must compare real paths, not the paths as found.
const alias = path.join(fx.base, 'projects-alias');
await fs.symlink(projects, alias);
Object.assign(process.env, fx.env, { COCKPIT_PROJECT_ROOTS: alias, COCKPIT_DATA_DIR: path.join(fx.base, 'data') });
const { scanEnvironment } = await import('../lib/scan.mjs');
const { reviewInstructionTexts } = await import('../lib/workflow.mjs');
const env = await scanEnvironment();
const project = (name) => env.projects.find((p) => p.path === path.join(alias, name));

test('a normal project and symlinks that resolve inside it are read', () => {
  const p = project('normal');
  assert.ok(p, 'normal project discovered');
  assert.equal(p.packageName, 'normal');
  const instr = (file) => env.instructions.find((i) => i.path === path.join(p.path, file));
  assert.equal(instr('CLAUDE.md')?.content, 'normal project instructions\n');
  assert.equal(instr('AGENTS.md')?.content, 'agents text via an inside symlink\n');
  assert.equal(p.ai.settings?.model, 'inside-model');
  assert.equal(p.commands.find((c) => c.name === 'inside')?.description, 'inside command');
  assert.equal(p.agents.find((a) => a.name === 'helper')?.description, 'inside agent');
  assert.ok(p.skills.some((s) => s.name === 'good-skill'));
});

test('project files symlinked outside the project are not read by the scanner', () => {
  assert.ok(!JSON.stringify(env).includes(MARK), 'no outside content anywhere in the scan result');
  const p = project('leaky');
  assert.ok(p, 'leaky project is still discovered');
  assert.equal(p.ai.hasClaudeMd, false); assert.equal(p.ai.hasAgentsMd, false); assert.equal(p.ai.hasClaudeLocalMd, false, 'a sibling sharing the path prefix is outside');
  assert.equal(p.ai.hasMcpJson, false); assert.equal(p.ai.settings, null); assert.equal(p.ai.settingsLocal, null); assert.equal(p.ai.swag, false);
  assert.equal(p.packageName, null); assert.deepEqual(p.scripts, {});
  assert.equal(p.instructions.length, 0);
  assert.equal(p.commands.find((c) => c.name === 'leak')?.description, '', 'an escaping command is listed by name only, never read');
  assert.equal(p.agents.find((a) => a.path.endsWith('leak.md'))?.body, '', 'an escaping agent is listed by name only, never read');
  assert.deepEqual(p.skills, [], 'neither an escaping SKILL.md nor an escaping skills directory is read');
});

test('a .claude directory symlinked outside the project is neither listed nor read', () => {
  const p = project('dotlink');
  assert.ok(p, 'dotlink project discovered');
  assert.deepEqual(p.ai.dotClaude, []);
  assert.equal(p.ai.settings, null);
  assert.deepEqual(p.commands, []);
});

test('the Codex review prompt reads project instructions only from inside the project', async () => {
  const realNormal = path.join(projects, 'normal'), realLeaky = path.join(projects, 'leaky');
  const memory = path.join(fx.claude, 'projects', 'x', 'memory', 'MEMORY.md');
  await write(memory, 'memory index\n');
  const texts = await reviewInstructionTexts(realNormal, [{ path: path.join(realNormal, 'CLAUDE.md') }, { path: path.join(realNormal, 'AGENTS.md') }, { path: memory }]);
  assert.deepEqual(texts, [`--- ${path.join(realNormal, 'CLAUDE.md')}\nnormal project instructions\n`, `--- ${path.join(realNormal, 'AGENTS.md')}\nagents text via an inside symlink\n`, `--- ${memory}\nmemory index\n`]);
  const viaAlias = await reviewInstructionTexts(path.join(alias, 'normal'), [{ path: path.join(alias, 'normal', 'CLAUDE.md') }]);
  assert.deepEqual(viaAlias, [`--- ${path.join(alias, 'normal', 'CLAUDE.md')}\nnormal project instructions\n`], 'a project reached through an alias still reads its own files');
  const leaked = await reviewInstructionTexts(realLeaky, ['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md', '.claude/settings.json'].map((f) => ({ path: path.join(realLeaky, f) })));
  assert.equal(leaked.length, 4);
  for (const t of leaked) { assert.ok(!t.includes(MARK), t); assert.match(t, /^--- .+\n$/); }
});
