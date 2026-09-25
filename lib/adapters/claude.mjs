// Claude Code adapter: headless `claude -p` with stream-json events, normalized for Cockpit.
import { startRun, waitForRun, runText } from '../runs.mjs';

export const CLAUDE_MODELS = ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1'];

export function buildClaudeArgs({ prompt, mode, model, resume, maxBudgetUsd, allowedTools, jsonSchema, appendSystemPrompt }) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', mode];
  if (model) args.push('--model', model);
  if (resume) args.push('--resume', resume);
  if (maxBudgetUsd) args.push('--max-budget-usd', String(maxBudgetUsd));
  if (allowedTools?.length) args.push('--allowedTools', allowedTools.join(','));
  if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));
  if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
  return args;
}

export function startClaude(opts) {
  const args = buildClaudeArgs(opts);
  return startRun({ kind: 'claude', participant: 'claude', label: opts.label || `claude -p (${opts.mode})`, cmd: 'claude', args, cwd: opts.cwd, sessionId: opts.sessionId, stageId: opts.stageId, meta: { mode: opts.mode, model: opts.model || '(settings default)', resume: opts.resume || null, promptChars: opts.prompt.length } });
}

// Parse the stream-json output into a compact, honest summary of what Claude did.
export function parseClaudeOutput(run) {
  const lines = runText(run).split('\n').filter((l) => l.startsWith('{'));
  const out = { sessionId: null, model: null, tools: [], textBlocks: [], result: null, structured: null, costUsd: null, durationMs: null, numTurns: null, isError: false, toolCalls: 0, filesTouched: new Set() };
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type === 'system' && j.subtype === 'init') { out.sessionId = j.session_id; out.model = j.model; out.tools = j.tools || []; out.cwd = j.cwd; out.permissionMode = j.permissionMode; out.slashCommands = j.slash_commands || []; out.skills = j.skills || []; out.agents = j.agents || []; out.mcpServers = j.mcp_servers || []; }
    if (j.type === 'assistant') for (const c of j.message?.content || []) {
      if (c.type === 'text' && c.text?.trim()) out.textBlocks.push(c.text);
      if (c.type === 'tool_use') { out.toolCalls++; const fp = c.input?.file_path || c.input?.path; if (fp && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(c.name)) out.filesTouched.add(fp); }
    }
    if (j.type === 'result') { out.result = j.result ?? null; out.structured = j.structured_output ?? null; out.costUsd = j.total_cost_usd ?? null; out.durationMs = j.duration_ms ?? null; out.numTurns = j.num_turns ?? null; out.isError = !!j.is_error; if (j.session_id) out.sessionId = j.session_id; }
  }
  out.filesTouched = [...out.filesTouched];
  return out;
}

export async function runClaude(opts) { const run = startClaude(opts); await waitForRun(run); return { run, parsed: parseClaudeOutput(run) }; }
