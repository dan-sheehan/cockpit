// Process manager: every subprocess Cockpit launches is a Run. Runs are observable live (SSE) and persisted at exit.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { RUNS_DIR, saveSoon, saveNow, newId, listAll } from './store.mjs';

export const bus = new EventEmitter();
bus.setMaxListeners(100);
const runs = new Map();
const MAX_CHUNKS = 4000;

export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // When Cockpit itself is launched from inside a Claude Code session, these would make nested `claude -p` refuse to start.
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT)$/.test(k)) delete env[k];
  return env;
}

export function startRun({ kind = 'command', label, cmd, args = [], cwd, env, stdinText, sessionId = null, stageId = null, participant = 'cockpit', meta = {} }) {
  const id = newId('run');
  const run = { id, kind, label: label || [cmd, ...args].join(' '), cmd, args, cwd, sessionId, stageId, participant, meta, pid: null, status: 'running', startedAt: new Date().toISOString(), endedAt: null, exitCode: null, signal: null, error: null, chunks: [], truncated: false };
  runs.set(id, run);
  let child;
  try {
    child = spawn(cmd, args, { cwd, env: childEnv(env), stdio: [stdinText != null ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true }); // own process group so descendants can be signalled together
  } catch (e) {
    run.status = 'failed'; run.error = e.message; run.endedAt = new Date().toISOString();
    bus.emit('event', { type: 'run.exit', run: publicRun(run) });
    return run;
  }
  run.pid = child.pid;
  run._child = child;
  bus.emit('event', { type: 'run.start', run: publicRun(run) });
  const bufs = { out: '', err: '' };
  const push = (stream, data) => {
    // Line-buffer JSONL producers so every emitted chunk holds whole lines (the UI summarizes per line).
    let text = data.toString();
    if (kind === 'claude' || kind === 'codex') { bufs[stream] += text; const i = bufs[stream].lastIndexOf('\n'); if (i === -1) return; text = bufs[stream].slice(0, i + 1); bufs[stream] = bufs[stream].slice(i + 1); }
    if (run.chunks.length < MAX_CHUNKS) run.chunks.push({ t: Date.now(), s: stream, d: text }); else run.truncated = true;
    bus.emit('event', { type: 'run.output', id, sessionId, stageId, stream, data: text });
    saveSoon(RUNS_DIR, id, () => publicRun(run), 1000);
  };
  child.stdout.on('data', (d) => push('out', d));
  child.stderr.on('data', (d) => push('err', d));
  child.on('error', (e) => { run.error = e.message; });
  child.on('close', (code, signal) => {
    for (const st of ['out', 'err']) if (bufs[st]) { run.chunks.push({ t: Date.now(), s: st, d: bufs[st] }); bufs[st] = ''; }
    run.exitCode = code; run.signal = signal; run.endedAt = new Date().toISOString();
    run.status = run.status === 'stopping' ? 'stopped' : code === 0 ? 'complete' : 'failed';
    delete run._child;
    saveNow(RUNS_DIR, id, publicRun(run)).catch(() => {});
    bus.emit('event', { type: 'run.exit', run: publicRun(run) });
  });
  if (stdinText != null) { child.stdin.on('error', () => {}); child.stdin.end(stdinText); }
  return run;
}

export function stopRun(id) {
  const run = runs.get(id);
  if (!run || !run._child) return false;
  run.status = 'stopping';
  signalGroup(run, 'SIGTERM');
  setTimeout(() => signalGroup(run, 'SIGKILL'), 3000);
  return true;
}
function signalGroup(run, sig) { if (!run._child) return; try { process.kill(-run._child.pid, sig); } catch { try { run._child.kill(sig); } catch {} } }
export function killAllHard() { for (const r of runs.values()) if (r._child) signalGroup(r, 'SIGKILL'); }

export function stopAll() { for (const r of runs.values()) if (r._child) stopRun(r.id); }
export function activeRuns() { return [...runs.values()].filter((r) => r._child).map(publicRun); }
export function getRun(id) { const r = runs.get(id); return r ? publicRun(r) : null; }
export async function allRuns() { const live = [...runs.values()].map(publicRun); const ids = new Set(live.map((r) => r.id)); const saved = (await listAll(RUNS_DIR)).filter((r) => !ids.has(r.id)).map((r) => r.status === 'running' || r.status === 'stopping' ? { ...r, status: 'interrupted', error: 'server exited while process was running' } : r); return [...live, ...saved].sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
export function runText(run) { return (run.chunks || []).map((c) => c.d).join(''); }
export function waitForRun(run) { return new Promise((resolve) => { if (!run._child) return resolve(run); run._child.on('close', () => setImmediate(() => resolve(run))); }); }
export function publicRun(r) { const { _child, ...rest } = r; return rest; }
