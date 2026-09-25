// Read-only parsers for the agents' own session logs, so the user's non-Cockpit sessions become inspectable timelines.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { redactText } from './redact.mjs';
import { CLAUDE_HOME, CODEX_HOME } from './homes.mjs';

const MAX = 400 * 1024 * 1024;
const cut = (s, n = 600) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s; };

async function readLines(file) {
  const st = await fs.stat(file); if (st.size > MAX) throw new Error('transcript too large to parse (' + st.size + ' bytes)');
  const rows = []; const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const l of rl) { if (!l) continue; try { rows.push(JSON.parse(l)); } catch {} }
  return rows;
}
function classifyUserText(text) {
  const cmd = text.match(/<command-name>([^<]+)<\/command-name>/); if (cmd) { const args = text.match(/<command-args>([^<]*)<\/command-args>/); return { kind: 'command', text: (cmd[1] + ' ' + (args?.[1] || '')).trim() }; }
  if (/^<local-command-stdout>/.test(text.trim())) return { kind: 'command_output', text: text.replace(/<\/?local-command-stdout>/g, '').trim() };
  if (/^<(system-reminder|local-command-caveat)>/.test(text.trim())) return null;
  return { kind: 'user', text };
}

export async function listClaudeTranscripts() {
  const out = [];
  const projectsDir = path.join(CLAUDE_HOME, 'projects');
  for (const d of await fs.readdir(projectsDir).catch(() => [])) {
    const dir = path.join(projectsDir, d);
    for (const f of (await fs.readdir(dir).catch(() => [])).filter((x) => x.endsWith('.jsonl'))) {
      const fp = path.join(dir, f); const st = await fs.stat(fp);
      out.push({ provider: 'claude', id: f.replace('.jsonl', ''), path: fp, size: st.size, mtime: st.mtime.toISOString(), projectDir: d });
    }
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}
export async function listCodexTranscripts() {
  const out = [];
  const walk = async (dir) => { for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) { const p = path.join(dir, e.name); if (e.isDirectory()) await walk(p); else if (e.name.endsWith('.jsonl')) { const st = await fs.stat(p); const m = e.name.match(/rollout-(\S+?)-([0-9a-f-]{36})\.jsonl$/); out.push({ provider: 'codex', id: m ? m[2] : e.name, path: p, size: st.size, mtime: st.mtime.toISOString(), startedAt: m ? m[1] : null }); } } };
  await walk(path.join(CODEX_HOME, 'sessions'));
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

const textOf = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c.type === 'text' || c.type === 'input_text' || c.type === 'output_text').map((c) => c.text).join('\n') : '';

export async function parseClaudeTranscript(file) {
  const rows = await readLines(file);
  const meta = { provider: 'claude', path: file, sessionId: null, cwd: null, version: null, models: new Set(), permissionModes: [], gitBranch: null, firstTs: null, lastTs: null, titles: [], agentNames: [] };
  const events = []; const toolCounts = {}; const files = new Set(); let costUsd = null;
  for (const r of rows) {
    if (r.sessionId && !meta.sessionId) meta.sessionId = r.sessionId;
    if (r.cwd && !meta.cwd) meta.cwd = r.cwd; if (r.version) meta.version = r.version; if (r.gitBranch) meta.gitBranch = r.gitBranch;
    if (r.type === 'permission-mode') { meta.permissionModes.push(r.permissionMode); events.push({ t: r.timestamp || null, kind: 'mode', who: 'system', text: `permission mode → ${r.permissionMode}` }); }
    if (r.type === 'ai-title' && r.title) meta.titles.push(r.title);
    if (r.type === 'agent-name' && r.agentName) meta.agentNames.push(r.agentName);
    if (r.type === 'cost-state' && r.totalCostUsd != null) costUsd = r.totalCostUsd;
    if (r.timestamp) { meta.firstTs ||= r.timestamp; meta.lastTs = r.timestamp; }
    if (r.type === 'user' && r.message) {
      if (r.isMeta) continue;
      const c = r.message.content;
      if (Array.isArray(c)) for (const part of c) { if (part.type === 'tool_result') events.push({ t: r.timestamp, kind: 'tool_result', who: 'tool', text: cut(redactText(textOf(part.content) || (typeof part.content === 'string' ? part.content : JSON.stringify(part.content))), 400), isError: !!part.is_error, sidechain: !!r.isSidechain }); else if (part.type === 'text' && part.text?.trim()) { const cl = classifyUserText(part.text); if (cl) events.push({ t: r.timestamp, kind: cl.kind, who: 'user', text: cut(redactText(cl.text), 1200), sidechain: !!r.isSidechain }); } }
      else if (typeof c === 'string' && c.trim()) { const cl = classifyUserText(c); if (cl) events.push({ t: r.timestamp, kind: cl.kind, who: 'user', text: cut(redactText(cl.text), 1200), sidechain: !!r.isSidechain }); }
    }
    if (r.type === 'assistant' && r.message) {
      if (r.message.model) meta.models.add(r.message.model);
      for (const part of r.message.content || []) {
        if (part.type === 'text' && part.text?.trim()) events.push({ t: r.timestamp, kind: 'assistant', who: 'claude', text: cut(redactText(part.text), 1200), sidechain: !!r.isSidechain });
        if (part.type === 'thinking') events.push({ t: r.timestamp, kind: 'thinking', who: 'claude', text: part.thinking ? cut(redactText(part.thinking), 300) : '(thinking block present; content redacted by Claude Code)', sidechain: !!r.isSidechain });
        if (part.type === 'tool_use') { toolCounts[part.name] = (toolCounts[part.name] || 0) + 1; const i = part.input || {}; const fp = i.file_path || i.path || i.notebook_path; if (fp && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(part.name)) files.add(fp); events.push({ t: r.timestamp, kind: 'tool_use', who: 'claude', tool: part.name, text: cut(redactText(i.command || i.description || fp || i.pattern || i.prompt || i.query || i.url || JSON.stringify(i)), 300), file: fp || null, sidechain: !!r.isSidechain }); }
      }
    }
  }
  return { meta: { ...meta, models: [...meta.models], costUsd, eventCount: events.length, toolCounts, filesEdited: [...files], turns: events.filter((e) => e.kind === 'user').length }, events: events.slice(0, 3000), truncated: events.length > 3000 };
}

export async function parseCodexTranscript(file) {
  const rows = await readLines(file);
  const meta = { provider: 'codex', path: file, sessionId: null, cwd: null, version: null, models: new Set(), approvalPolicy: null, sandbox: null, baseInstructionsChars: null, firstTs: null, lastTs: null, source: null };
  const events = []; const toolCounts = {}; let usage = null;
  for (const r of rows) {
    if (r.timestamp) { meta.firstTs ||= r.timestamp; meta.lastTs = r.timestamp; }
    const p = r.payload || {};
    if (r.type === 'session_meta') { meta.sessionId = p.id || p.session_id; meta.cwd = p.cwd; meta.version = p.cli_version; meta.source = p.originator || p.source; meta.baseInstructionsChars = p.base_instructions?.text?.length ?? null; }
    if (r.type === 'turn_context') { if (p.model) meta.models.add(p.model); meta.approvalPolicy = p.approval_policy || meta.approvalPolicy; meta.sandbox = p.sandbox_policy?.type || meta.sandbox; if (p.cwd) meta.cwd = p.cwd; events.push({ t: r.timestamp, kind: 'mode', who: 'system', text: `turn · model ${p.model} · approval ${p.approval_policy} · sandbox ${p.sandbox_policy?.type}${p.sandbox_policy?.network_access ? ' +network' : ''}` }); }
    if (r.type === 'response_item') {
      if (p.type === 'message') { const text = textOf(p.content); if (!text.trim()) continue; if (p.role === 'developer') events.push({ t: r.timestamp, kind: 'system', who: 'system', text: cut(redactText(text), 300), label: 'developer instruction' }); else if (p.role === 'user') { if (/^<environment_context>/.test(text.trim())) events.push({ t: r.timestamp, kind: 'system', who: 'system', text: cut(redactText(text), 300), label: 'environment context' }); else events.push({ t: r.timestamp, kind: 'user', who: 'user', text: cut(redactText(text), 1200) }); } else if (p.role === 'assistant') events.push({ t: r.timestamp, kind: 'assistant', who: 'codex', text: cut(redactText(text), 1200) }); }
      if (p.type === 'reasoning') events.push({ t: r.timestamp, kind: 'thinking', who: 'codex', text: p.summary?.length ? cut(redactText(p.summary.map((s) => s.text || '').join('\n')), 300) : '(reasoning item present; summary not stored)' });
      if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') { const name = p.name || p.type; toolCounts[name] = (toolCounts[name] || 0) + 1; events.push({ t: r.timestamp, kind: 'tool_use', who: 'codex', tool: name, text: cut(redactText(p.arguments || p.input || JSON.stringify(p.action || {})), 300) }); }
      if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') events.push({ t: r.timestamp, kind: 'tool_result', who: 'tool', text: cut(redactText(typeof p.output === 'string' ? p.output : textOf(p.output) || JSON.stringify(p.output)), 400) });
    }
    if (r.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'CommandExecution') { toolCounts.CommandExecution = (toolCounts.CommandExecution || 0) + 1; events.push({ t: r.timestamp, kind: 'tool_use', who: 'codex', tool: 'shell', text: cut(redactText(Array.isArray(p.item.command) ? p.item.command.join(' ') : String(p.item.command || '')), 300), exitCode: p.item.exit_code ?? null }); }
    if (r.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) usage = p.info.total_token_usage;
  }
  return { meta: { ...meta, models: [...meta.models], usage, eventCount: events.length, toolCounts, turns: events.filter((e) => e.kind === 'user').length }, events: events.slice(0, 3000), truncated: events.length > 3000 };
}

export function transcriptAllowed(p) { const real = path.resolve(p); return (real.startsWith(path.join(CLAUDE_HOME, 'projects') + path.sep) || real.startsWith(path.join(CODEX_HOME, 'sessions') + path.sep)) && real.endsWith('.jsonl'); }
