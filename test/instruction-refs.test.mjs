// What a project's entry points (CLAUDE.md, CLAUDE.local.md, AGENTS.md) point at: Claude @imports (includesResolved) and plain Markdown
// links (linksResolved), each resolved from the referring file to present, missing or outside. Targets are never read, a target outside
// the project is never sized, and a referenced file never becomes an instruction row of its own (those rows feed launched agents).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeFixtureHomes } from './fixtures/homes.mjs';

const fx = await makeFixtureHomes();
const MARK = 'OUTSIDE_REF_MARKER'; // in every file outside the project; it must never reach the scan
const write = async (p, c) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, c); };
const link = async (target, p) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.symlink(target, p); };

const outside = path.join(fx.base, 'outside');
await write(path.join(outside, 'private.md'), `${MARK} private notes, long enough to have a telling size\n`.repeat(7));
await write(path.join(fx.home, 'home-note.md'), `${MARK} in HOME\n`);

const projects = path.join(fx.base, 'projects');
const proj = path.join(projects, 'refs');
const SHARED = 'shared context\n', HARNESS = '# harness\nshared rules\n';
await write(path.join(proj, 'shared.md'), SHARED);
await write(path.join(proj, 'harness.md'), HARNESS);
await link(path.join(outside, 'private.md'), path.join(proj, 'escape.md'));
await link(outside, path.join(proj, 'linked'));
await write(path.join(proj, 'CLAUDE.md'), [
  '@shared.md', '@gone.md', '@../../outside/private.md', '@escape.md', '@linked/private.md', '@linked/nothing.md', '@~/home-note.md',
  'Code, not a link: `[code](code.md)`. A real one: [shared](shared.md).', '',
].join('\n'));
await write(path.join(proj, 'CLAUDE.local.md'), 'local notes, see [shared](./shared.md)\n');
await write(path.join(proj, 'AGENTS.md'), [
  '# AGENTS.md', '',
  'Read [harness.md](harness.md) before anything. Commands: [section](harness.md#commands).',
  'Ignored: [web](https://example.com/x.md), [plain](http://example.com), [mail](mailto:a@example.com), [top](#top), [cdn](//cdn.example.com/x.md), ![logo](logo.png).',
  'Checked: [gone](docs/missing.md), [escape](escape.md).',
  '```', '[in a fence](fenced.md)', '```', '',
].join('\n'));

Object.assign(process.env, fx.env, { COCKPIT_PROJECT_ROOTS: projects });
const { scanEnvironment, COCKPIT_ROOT } = await import('../lib/scan.mjs');
const env = await scanEnvironment();
const instr = (file) => env.instructions.find((i) => i.path === path.join(proj, file));
const at = (rel) => path.join(proj, rel);

test('CLAUDE.md imports: present, missing and outside, with the includes list unchanged', () => {
  const c = instr('CLAUDE.md');
  assert.ok(c, 'CLAUDE.md scanned');
  assert.deepEqual(c.includes, ['shared.md', 'gone.md', '../../outside/private.md', 'escape.md', 'linked/private.md', 'linked/nothing.md', '~/home-note.md'], 'includes stays a list of the raw refs');
  assert.deepEqual(c.includesResolved, [
    { ref: 'shared.md', path: at('shared.md'), status: 'present', size: Buffer.byteLength(SHARED) },
    { ref: 'gone.md', path: at('gone.md'), status: 'missing', size: null },
    { ref: '../../outside/private.md', path: path.join(outside, 'private.md'), status: 'outside', size: null },
    { ref: 'escape.md', path: at('escape.md'), status: 'outside', size: null },
    { ref: 'linked/private.md', path: at('linked/private.md'), status: 'outside', size: null },
    { ref: 'linked/nothing.md', path: at('linked/nothing.md'), status: 'outside', size: null },
    { ref: '~/home-note.md', path: path.join(fx.home, 'home-note.md'), status: 'outside', size: null },
  ]);
  assert.deepEqual(c.linksResolved, [{ ref: 'shared.md', path: at('shared.md'), status: 'present', size: Buffer.byteLength(SHARED) }], 'an @import is not a link, and a link in inline code is not a link');
});

test('AGENTS.md links are recorded as links, not imports; URLs, anchors, images and fenced code are ignored', () => {
  const a = instr('AGENTS.md');
  assert.deepEqual(a.includes, []);
  assert.deepEqual(a.includesResolved, [], 'Codex has no import: a link in AGENTS.md is never an include');
  assert.deepEqual(a.linksResolved, [
    { ref: 'harness.md', path: at('harness.md'), status: 'present', size: Buffer.byteLength(HARNESS) },
    { ref: 'docs/missing.md', path: at('docs/missing.md'), status: 'missing', size: null },
    { ref: 'escape.md', path: at('escape.md'), status: 'outside', size: null },
  ]);
});

test('CLAUDE.local.md links are resolved from the file; its includes stay empty as before', () => {
  const l = instr('CLAUDE.local.md');
  assert.deepEqual(l.includes, []); assert.deepEqual(l.includesResolved, []);
  assert.deepEqual(l.linksResolved, [{ ref: './shared.md', path: at('shared.md'), status: 'present', size: Buffer.byteLength(SHARED) }]);
});

test('referenced files never become instruction rows of their own', () => {
  assert.deepEqual(env.instructions.filter((i) => i.project === proj).map((i) => i.path).sort(), ['AGENTS.md', 'CLAUDE.local.md', 'CLAUDE.md'].map(at).sort(),
    'the rows the workflow turns into project instructions are exactly the entry points');
  for (const f of ['shared.md', 'harness.md', 'escape.md', 'gone.md']) assert.ok(!env.instructions.some((i) => i.path === at(f)), `${f} is not an instruction row`);
  const cockpit = env.instructions.filter((i) => i.project === COCKPIT_ROOT);
  assert.ok(!cockpit.some((i) => i.path === path.join(COCKPIT_ROOT, 'harness.md')), "cockpit's own harness.md is not a row either");
  assert.deepEqual(cockpit.find((i) => i.path === path.join(COCKPIT_ROOT, 'CLAUDE.md'))?.includesResolved.map((r) => [r.ref, r.status]), [['harness.md', 'present']],
    "cockpit's own CLAUDE.md import of harness.md resolves");
  const agents = cockpit.find((i) => i.path === path.join(COCKPIT_ROOT, 'AGENTS.md'));
  assert.deepEqual(agents?.includesResolved, [], "cockpit's own AGENTS.md has no import");
  assert.ok(agents?.linksResolved.some((r) => r.ref === 'harness.md' && r.status === 'present' && r.path === path.join(COCKPIT_ROOT, 'harness.md')),
    "cockpit's own AGENTS.md links (not imports) the same harness.md");
});

test('nothing outside the project reaches the scan through the new metadata', () => {
  const text = JSON.stringify(env);
  assert.ok(!text.includes(MARK), 'no outside content');
  assert.ok(!text.includes('shared rules') && !text.includes('shared context'), 'present targets are sized, never read');
  const outsideSize = String(Buffer.byteLength(`${MARK} private notes, long enough to have a telling size\n`.repeat(7)));
  const refs = env.instructions.filter((i) => i.project === proj).flatMap((i) => [...i.includesResolved, ...i.linksResolved]);
  for (const r of refs.filter((x) => x.status === 'outside')) assert.equal(r.size, null, `${r.ref} is not sized`);
  assert.ok(!refs.some((r) => String(r.size) === outsideSize), 'the outside file size is never reported');
});
