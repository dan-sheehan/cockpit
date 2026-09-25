import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffEnv } from '../lib/envdiff.mjs';

const base = () => ({ scannedAt: 't', skills: [{ id: 'a', name: 'a', scope: 'GLOBAL', stat: { mtime: '1' } }], instructions: [{ path: '/x/CLAUDE.md', exists: true, kind: 'instructions', content: 'a', size: 1 }], hooks: [], mcp: [], agents: [], tools: [{ name: 'claude', label: 'Claude Code', version: '1' }], claude: { settings: { model: 'm' }, model: 'm', home: '/h', sessionTotal: 1, plans: [] }, codex: { configText: 'c', rules: [{ rules: [] }], home: '/c', sessionTotal: 0 }, projects: [{ path: '/p', name: 'p', git: { branch: 'main', dirty: false, recentCommits: [{ hash: 'h1', subject: 's' }] }, ai: { hasClaudeMd: true, hasAgentsMd: false, claudeTrusted: true, codexTrust: null } }] });

test('diffEnv reports skill, instruction, git and settings changes and nothing when equal', () => {
  const a = base(); assert.deepEqual(diffEnv(a, base()), []); assert.deepEqual(diffEnv(null, a), []);
  const b = base(); b.skills.push({ id: 'b', name: 'b', scope: 'PROJECT', stat: { mtime: '2' } }); b.instructions[0].content = 'ab'; b.instructions[0].size = 2; b.projects[0].git.dirty = true; b.projects[0].git.changedCount = 3; b.claude.settings.model = 'n'; b.claude.model = 'n'; b.tools[0].version = '2';
  const ch = diffEnv(a, b).map((c) => c.text);
  assert.ok(ch.some((t) => t.includes('skill added: /b')));
  assert.ok(ch.some((t) => t.includes('instructions changed: /x/CLAUDE.md (1 → 2 chars)')));
  assert.ok(ch.some((t) => t.includes('now dirty (3 paths)')));
  assert.ok(ch.some((t) => t.includes('settings.json changed (model m → n)')));
  assert.ok(ch.some((t) => t.includes('Claude Code: 1 → 2')));
});
