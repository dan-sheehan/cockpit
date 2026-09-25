// Codex adapter: `codex exec` non-interactive, READ-ONLY sandbox, JSONL events. Codex never gets write access from Cockpit.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startRun, waitForRun, runText } from '../runs.mjs';

export const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    noMaterialFindings: { type: 'boolean' },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string' }, title: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      category: { type: 'string', enum: ['bug', 'bad-assumption', 'security', 'edge-case', 'architecture', 'complexity', 'scope', 'incorrect', 'mismatch', 'other'] },
      file: { type: 'string' }, line: { type: 'integer' }, description: { type: 'string' }, evidence: { type: 'string' }, suggestion: { type: 'string' },
    }, required: ['id', 'title', 'severity', 'category', 'file', 'line', 'description', 'evidence', 'suggestion'] } },
  }, required: ['noMaterialFindings', 'summary', 'findings'],
};

export function buildCodexArgs({ cwd, schemaFile, lastMessageFile, model }) {
  const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '--ephemeral', '--color', 'never', '-C', cwd];
  if (model) args.push('-m', model);
  if (schemaFile) args.push('--output-schema', schemaFile);
  if (lastMessageFile) args.push('-o', lastMessageFile);
  args.push('-'); // prompt from stdin
  return args;
}

export async function startCodexReview({ cwd, prompt, sessionId, stageId, model, label }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-codex-'));
  const schemaFile = path.join(tmp, 'schema.json');
  const lastMessageFile = path.join(tmp, 'last.json');
  await fs.writeFile(schemaFile, JSON.stringify(REVIEW_SCHEMA));
  const args = buildCodexArgs({ cwd, schemaFile, lastMessageFile, model });
  const run = startRun({ kind: 'codex', participant: 'codex', label: label || 'codex exec --sandbox read-only', cmd: 'codex', args, cwd, stdinText: prompt, sessionId, stageId, meta: { sandbox: 'read-only', model: model || '(config default)', promptChars: prompt.length, lastMessageFile } });
  return { run, lastMessageFile };
}

export async function parseCodexOutput(run, lastMessageFile) {
  const lines = runText(run).split('\n').filter((l) => l.startsWith('{'));
  const out = { threadId: null, commands: [], messages: [], usage: null, review: null, parseError: null, sandboxViolations: 0 };
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type === 'thread.started') out.threadId = j.thread_id;
    if (j.type === 'item.completed' && j.item?.type === 'command_execution') { out.commands.push({ command: j.item.command, exitCode: j.item.exit_code, output: (j.item.aggregated_output || '').slice(0, 2000) }); if (/Operation not permitted|Read-only file system|sandbox/i.test(j.item.aggregated_output || '')) out.sandboxViolations++; }
    if (j.type === 'item.completed' && j.item?.type === 'agent_message') out.messages.push(j.item.text);
    if (j.type === 'turn.completed') out.usage = j.usage || null;
    if (j.type === 'error') out.parseError = j.message || 'codex error';
  }
  let text = null; try { text = await fs.readFile(lastMessageFile, 'utf8'); } catch {}
  if (text == null && out.messages.length) text = out.messages[out.messages.length - 1];
  if (text) { try { out.review = JSON.parse(text); } catch { const m = text.match(/```json\s*([\s\S]*?)```/); if (m) { try { out.review = JSON.parse(m[1]); } catch (e) { out.parseError = 'could not parse review JSON'; } } else out.parseError = 'review was not JSON'; out.rawText = text.slice(0, 5000); } }
  return out;
}

export async function runCodexReview(opts) { const { run, lastMessageFile } = await startCodexReview(opts); await waitForRun(run); return { run, parsed: await parseCodexOutput(run, lastMessageFile) }; }
