import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, parseClaudeOutput } from '../lib/adapters/claude.mjs';
import { buildCodexArgs, REVIEW_SCHEMA } from '../lib/adapters/codex.mjs';

test('claude args: prompt first, allowedTools comma-joined so it cannot swallow the prompt', () => {
  const a = buildClaudeArgs({ prompt: 'do it', mode: 'acceptEdits', resume: 'sid', allowedTools: ['Read', 'Bash(git *)'], maxBudgetUsd: 2 });
  assert.equal(a[0], '-p'); assert.equal(a[1], 'do it');
  assert.ok(a.includes('--resume') && a[a.indexOf('--resume') + 1] === 'sid');
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'Read,Bash(git *)');
});

test('codex args always carry the read-only sandbox and stdin prompt', () => {
  const a = buildCodexArgs({ cwd: '/x', schemaFile: '/s.json', lastMessageFile: '/l.json' });
  assert.equal(a[a.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(a.includes('--ephemeral'));
  assert.equal(a[a.length - 1], '-');
  assert.ok(REVIEW_SCHEMA.properties.noMaterialFindings);
});

test('parseClaudeOutput extracts session, edits and result from stream-json', () => {
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'S1', model: 'm', tools: ['Edit'], cwd: '/x', permissionMode: 'acceptEdits' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x/a.js' } }, { type: 'text', text: 'done' }] } },
    { type: 'result', result: 'summary', total_cost_usd: 0.5, num_turns: 2, is_error: false, session_id: 'S1' },
  ].map((j) => JSON.stringify(j)).join('\n');
  const p = parseClaudeOutput({ chunks: [{ d: lines }] });
  assert.equal(p.sessionId, 'S1'); assert.deepEqual(p.filesTouched, ['/x/a.js']); assert.equal(p.result, 'summary'); assert.equal(p.toolCalls, 1);
});
