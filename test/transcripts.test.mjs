import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeTranscript, parseCodexTranscript, transcriptAllowed } from '../lib/transcripts.mjs';
import { CLAUDE_HOME, CODEX_HOME } from '../lib/homes.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-tx-'));

test('claude transcript: prompts, slash commands, tool use, edits and model are extracted; secrets redacted', async () => {
  const f = path.join(tmp, 'c.jsonl');
  await fs.writeFile(f, [
    { type: 'permission-mode', permissionMode: 'plan', sessionId: 'S' },
    { type: 'user', timestamp: '2026-09-07T00:00:00Z', cwd: '/p', version: '2.1.263', sessionId: 'S', message: { role: 'user', content: '<command-name>/plan</command-name><command-args></command-args>' } },
    { type: 'user', timestamp: '2026-09-07T00:00:01Z', message: { role: 'user', content: 'fix the bug, token sk-abcdefghijklmnopqrstuvwxyz' } },
    { type: 'assistant', timestamp: '2026-09-07T00:00:02Z', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', name: 'Edit', input: { file_path: '/p/a.js' } }] } },
    { type: 'user', timestamp: '2026-09-07T00:00:03Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
  ].map((j) => JSON.stringify(j)).join('\n'));
  const r = await parseClaudeTranscript(f);
  assert.equal(r.meta.cwd, '/p'); assert.deepEqual(r.meta.models, ['claude-sonnet-5']); assert.deepEqual(r.meta.filesEdited, ['/p/a.js']);
  assert.equal(r.events.find((e) => e.kind === 'command').text, '/plan');
  assert.match(r.events.find((e) => e.kind === 'user').text, /<redacted>/);
  assert.equal(r.meta.toolCounts.Edit, 1); assert.equal(r.meta.turns, 1);
});

test('codex rollout: session meta, turn context and shell commands are extracted', async () => {
  const f = path.join(tmp, 'x.jsonl');
  await fs.writeFile(f, [
    { timestamp: 't0', type: 'session_meta', payload: { id: 'X', cwd: '/q', cli_version: '0.153.4', originator: 'codex-tui', base_instructions: { text: 'abc' } } },
    { timestamp: 't1', type: 'turn_context', payload: { model: 'gpt-6-astra', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' }, cwd: '/q' } },
    { timestamp: 't2', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
    { timestamp: 't3', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'ls'], exit_code: 0 } } },
  ].map((j) => JSON.stringify(j)).join('\n'));
  const r = await parseCodexTranscript(f);
  assert.equal(r.meta.sessionId, 'X'); assert.equal(r.meta.sandbox, 'workspace-write'); assert.deepEqual(r.meta.models, ['gpt-6-astra']);
  assert.equal(r.events.find((e) => e.kind === 'tool_use').text, '/bin/zsh -lc ls'); assert.equal(r.meta.turns, 1);
});

test('transcriptAllowed only accepts jsonl under the two log roots', () => {
  assert.equal(transcriptAllowed(path.join(CLAUDE_HOME, 'projects', 'x', 'y.jsonl')), true);
  assert.equal(transcriptAllowed(path.join(CODEX_HOME, 'sessions', '2026', 'r.jsonl')), true);
  assert.equal(transcriptAllowed(path.join(CODEX_HOME, 'auth.json')), false);
  assert.equal(transcriptAllowed('/etc/passwd'), false);
});
