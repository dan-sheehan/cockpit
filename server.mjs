// Cockpit server: local-only HTTP + SSE. Zero dependencies. Binds 127.0.0.1.
import http from 'node:http';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanEnvironment } from './lib/scan.mjs';
import { HOME, CLAUDE_HOME, CLAUDE_JSON, CODEX_HOME, coversPath } from './lib/homes.mjs';
import { redactText } from './lib/redact.mjs';
import { gitSummary, gitDiff } from './lib/git.mjs';
import { load as loadStore, RUNS_DIR } from './lib/store.mjs';
const loadRun = (id) => /^run_[A-Za-z0-9_]+$/.test(id) ? loadStore(RUNS_DIR, id) : null;
import { bus, startRun, stopRun, stopAll, killAllHard, getRun, allRuns, activeRuns } from './lib/runs.mjs';
import { startClaude, CLAUDE_MODELS } from './lib/adapters/claude.mjs';
import { startCodexReview } from './lib/adapters/codex.mjs';
import { terminalLaunch } from './lib/terminal.mjs';
import { listClaudeTranscripts, listCodexTranscripts, parseClaudeTranscript, parseCodexTranscript, transcriptAllowed } from './lib/transcripts.mjs';
import { startWatching, watchTranscripts } from './lib/watch.mjs';
import { sessionReport } from './lib/report.mjs';
import { diffEnv } from './lib/envdiff.mjs';
import { DATA_DIR } from './lib/store.mjs';
const CHANGES_FILE = path.join(DATA_DIR, 'changes.jsonl');
let recentChanges = [];
try { recentChanges = (await fs.readFile(CHANGES_FILE, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(-500); } catch {}
import { createSession, cancelSession, retrySession, listSessions, getSession, markInterruptedOnShutdown, redactDiff } from './lib/workflow.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.COCKPIT_PORT || 4848);
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

let envCache = null; let envPromise = null;
async function getEnv(refresh = false) {
  if (!refresh && envCache) return envCache;
  if (!envPromise) envPromise = scanEnvironment().then((e) => { const changes = diffEnv(envCache, e); envCache = e; envPromise = null; if (changes.length) { recentChanges.push(...changes); recentChanges = recentChanges.slice(-500); fs.appendFile(CHANGES_FILE, changes.map((c) => JSON.stringify(c)).join('\n') + '\n').catch(() => {}); console.log(`changed  ${changes.map((c) => c.text).join(' · ').slice(0, 200)}`); } bus.emit('event', { type: 'env.scanned', scannedAt: e.scannedAt, changes }); return e; }).catch((e) => { envPromise = null; throw e; });
  return envPromise;
}

function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
async function readBody(req) { let b = ''; for await (const c of req) { b += c; if (b.length > 2e6) throw new Error('body too large'); } return b ? JSON.parse(b) : {}; }

// Files Cockpit never shows, wherever they sit: credentials, private keys, secrets files and databases. Everything else it shows is redacted.
const BLOCKED_FILE = /^auth\.json$|\.sqlite|\.credentials|^credentials$|^\.git-credentials$|\.env$|\.env\.|^\.netrc$|^\.npmrc$|history\.jsonl$|\.pem$|id_rsa|id_dsa|id_ecdsa|id_ed25519/;

// Files Cockpit may show: under the Claude and Codex homes (minus BLOCKED_FILE), Claude's .claude.json, discovered projects, and cockpit itself.
async function fileAllowed(p, env) {
  let real; try { real = await fs.realpath(p); } catch { return false; } // resolves symlinks so an alias cannot escape the roots
  const base = path.basename(real);
  const realOf = (r) => fs.realpath(r).catch(() => r);
  // A Claude/Codex home set at or above HOME (e.g. CLAUDE_CONFIG_DIR=$HOME) is not a root: like project discovery, which never treats HOME as a project, Cockpit never opens the whole home directory.
  const home = await realOf(HOME);
  const [claudeHome, codexHome] = (await Promise.all([CLAUDE_HOME, CODEX_HOME].map(realOf))).map((r) => (coversPath(r, home) ? null : r));
  // No exceptions, history.jsonl included: the recent-prompts list comes from the scanner (redacted, truncated), never from this viewer.
  if (BLOCKED_FILE.test(base)) return false;
  const roots = [claudeHome, codexHome, ...(await Promise.all([CLAUDE_JSON, ROOT, ...(env?.projects || []).map((x) => x.path)].map(realOf)))].filter(Boolean);
  return roots.some((r) => real === r || real.startsWith(r + path.sep));
}

const sseClients = new Set();
bus.on('event', (ev) => { const data = `data: ${JSON.stringify(ev)}\n\n`; for (const res of sseClients) res.write(data); });
setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 15000).unref();

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, resource, id, sub] = parts;
  if (req.method === 'GET' && resource === 'env') return json(res, 200, await getEnv(url.searchParams.has('refresh')));
  if (req.method === 'GET' && resource === 'changes') return json(res, 200, recentChanges.slice().reverse());
  if (req.method === 'GET' && resource === 'events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', activeRuns: activeRuns().map((r) => r.id), time: new Date().toISOString() })}\n\n`);
    sseClients.add(res); req.on('close', () => sseClients.delete(res)); return;
  }
  if (req.method === 'GET' && resource === 'file') {
    const p = url.searchParams.get('path'); const env = await getEnv();
    if (!p || !(await fileAllowed(p, env))) return json(res, 403, { error: 'path not allowed' });
    try { const st = await fs.stat(p); if (st.isDirectory()) { const entries = await fs.readdir(p, { withFileTypes: true }); return json(res, 200, { path: p, directory: true, entries: entries.map((e) => ({ name: e.name, dir: e.isDirectory() })) }); } if (st.size > 1.5e6) return json(res, 200, { path: p, size: st.size, content: null, note: 'file too large to display' }); const content = await fs.readFile(p, 'utf8'); return json(res, 200, { path: p, size: st.size, mtime: st.mtime.toISOString(), content: redactText(content) }); } catch (e) { return json(res, 404, { error: e.message }); }
  }
  if (req.method === 'GET' && resource === 'claude-sessions') {
    const project = url.searchParams.get('project'); if (!project) return json(res, 400, { error: 'project required' });
    const dir = path.join(CLAUDE_HOME, 'projects', project.replace(/[\/.]/g, '-'));
    const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.jsonl'));
    const out = [];
    for (const f of files) { const fp = path.join(dir, f); const st = await fs.stat(fp); const head = (await fs.readFile(fp, 'utf8')).split('\n').slice(0, 80); let first = null, cwd = null, version = null, model = null; for (const l of head) { try { const j = JSON.parse(l); if (j.cwd) cwd = j.cwd; if (j.version) version = j.version; if (j.type === 'user' && !j.isMeta && typeof j.message?.content === 'string' && !first) first = j.message.content.slice(0, 240); if (j.type === 'user' && !j.isMeta && Array.isArray(j.message?.content) && !first) { const t = j.message.content.find((c) => c.type === 'text'); if (t) first = t.text.slice(0, 240); } if (j.message?.model) model = j.message.model; } catch {} } out.push({ id: f.replace('.jsonl', ''), path: fp, size: st.size, mtime: st.mtime.toISOString(), firstPrompt: first ? redactText(first) : null, cwd, version, model }); }
    return json(res, 200, { dir, sessions: out.sort((a, b) => b.mtime.localeCompare(a.mtime)) });
  }
  if (req.method === 'GET' && resource === 'transcripts') { const [c, x] = await Promise.all([listClaudeTranscripts(), listCodexTranscripts()]); return json(res, 200, { claude: c, codex: x }); }
  if (req.method === 'GET' && resource === 'transcript') {
    const p = url.searchParams.get('path'); if (!p || !transcriptAllowed(p)) return json(res, 403, { error: 'path not allowed' });
    try { const isCodex = path.resolve(p).startsWith(path.join(CODEX_HOME, 'sessions') + path.sep); return json(res, 200, isCodex ? await parseCodexTranscript(p) : await parseClaudeTranscript(p)); } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (req.method === 'GET' && resource === 'git') {
    const p = url.searchParams.get('path'); const env = await getEnv(); const proj = env.projects.find((x) => x.path === p); if (!proj) return json(res, 403, { error: 'unknown project' });
    if (id === 'diff') return json(res, 200, await gitDiff(p));
    return json(res, 200, await gitSummary(p));
  }
  if (req.method === 'GET' && resource === 'runs') { if (id) { const r = getRun(id) || await loadRun(id); return r ? json(res, 200, r) : json(res, 404, { error: 'not found' }); } return json(res, 200, (await allRuns()).map((r) => ({ ...r, chunks: undefined, outputChars: (r.chunks || []).reduce((a, c) => a + c.d.length, 0) }))); }
  if (req.method === 'POST' && resource === 'runs' && id && sub === 'stop') return json(res, 200, { stopped: stopRun(id) });
  if (req.method === 'POST' && resource === 'actions') {
    const body = await readBody(req); const env = await getEnv();
    const proj = env.projects.find((x) => x.path === body.projectPath);
    if (!proj && body.action !== 'tool.version') return json(res, 403, { error: 'projectPath must be a discovered project' });
    switch (body.action) {
      case 'npm.run': { if (!proj.scripts[body.script]) return json(res, 400, { error: 'script not in package.json' }); const args = body.script === 'test' ? ['test'] : ['run', body.script]; return json(res, 200, { run: startRun({ kind: 'command', label: `npm ${args.join(' ')}`, cmd: 'npm', args, cwd: proj.path }) }); }
      case 'git.status': return json(res, 200, { run: startRun({ kind: 'command', label: 'git status', cmd: 'git', args: ['status'], cwd: proj.path }) });
      case 'git.diff': return json(res, 200, { run: startRun({ kind: 'command', label: 'git diff --stat', cmd: 'git', args: ['diff', '--stat'], cwd: proj.path }) });
      case 'git.log': return json(res, 200, { run: startRun({ kind: 'command', label: 'git log', cmd: 'git', args: ['log', '--oneline', '-20'], cwd: proj.path }) });
      case 'open.finder': return json(res, 200, { run: startRun({ kind: 'command', label: `open ${proj.path}`, cmd: 'open', args: [proj.path], cwd: proj.path }) });
      case 'open.editor': return json(res, 200, { run: startRun({ kind: 'command', label: `code ${proj.path}`, cmd: 'code', args: [proj.path], cwd: proj.path }) });
      case 'launch.terminal': { const tool = body.tool === 'codex' ? 'codex' : 'claude'; const { cmd, args } = terminalLaunch(proj.path, tool); return json(res, 200, { run: startRun({ kind: 'command', label: `Terminal → ${tool} in ${proj.name}`, cmd, args, cwd: proj.path, participant: tool, meta: { note: 'interactive session opened in Terminal.app; Cockpit does not own or observe it' } }) }); }
      case 'claude.task': { if (!body.prompt?.trim()) return json(res, 400, { error: 'prompt required' }); const mode = body.mode === 'acceptEdits' ? 'acceptEdits' : 'plan'; const run = startClaude({ prompt: body.prompt.trim(), mode, model: body.model || undefined, maxBudgetUsd: 2, cwd: proj.path, label: `claude -p (${mode}) · ad-hoc`, allowedTools: mode === 'acceptEdits' ? ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(npm test*)', 'Bash(ls*)'] : undefined }); return json(res, 200, { run }); }
      case 'codex.review': { const d = await gitDiff(proj.path); const prompt = `You are a read-only code reviewer. Review the current uncommitted changes in this repository for bugs, security problems, missing edge cases and unnecessary complexity. Cite file and line. If there are no material findings, say so plainly.\n\n${body.prompt ? 'Focus: ' + body.prompt + '\n\n' : ''}UNTRACKED:\n${d.untracked.join('\n') || '(none)'}\n\nDIFF:\n${redactDiff(d.diff).slice(0, 100000) || '(no tracked changes)'}`; const { run } = await startCodexReview({ cwd: proj.path, prompt, label: 'codex exec --sandbox read-only · ad-hoc review', model: body.model || undefined }); return json(res, 200, { run }); }
      default: return json(res, 400, { error: 'unknown action' });
    }
  }
  if (resource === 'sessions') {
    if (req.method === 'GET' && !id) return json(res, 200, await listSessions());
    if (req.method === 'GET' && id && sub === 'report') { const s = await getSession(id); if (!s) return json(res, 404, { error: 'not found' }); res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' }); return res.end(sessionReport(s)); }
    if (req.method === 'GET' && id) { const s = await getSession(id); return s ? json(res, 200, s) : json(res, 404, { error: 'not found' }); }
    if (req.method === 'POST' && !id) { const body = await readBody(req); const env = await getEnv(); try { const s = await createSession({ ...body, env }); return json(res, 200, { id: s.id }); } catch (e) { return json(res, 400, { error: e.message }); } }
    if (req.method === 'POST' && id && sub === 'cancel') return json(res, 200, { cancelled: cancelSession(id) });
    if (req.method === 'POST' && id && sub === 'retry') return json(res, 200, await retrySession(id, await getEnv()));
  }
  if (req.method === 'GET' && resource === 'meta') return json(res, 200, { port: PORT, root: ROOT, version: VERSION, claudeModels: CLAUDE_MODELS, pid: process.pid, startedAt: STARTED });
  json(res, 404, { error: 'no such endpoint' });
}

// Cross-site request forgery guard. Any web page can make the browser send a "simple" POST (text/plain or form data, no CORS
// preflight) to 127.0.0.1, and the Host check alone cannot tell it apart from Cockpit's own page. So every request that is not a
// plain read must carry the exact Origin of Cockpit's UI and a JSON body. The UI is served from this port on 127.0.0.1 (the
// printed URL) or localhost; the server never listens on [::1], so no Cockpit page can have that origin. No CORS headers are sent.
const UI_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
function admissionRefusal(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  if (!UI_ORIGINS.has(req.headers.origin)) return { status: 403, error: 'origin not allowed' };
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return { status: 415, error: 'content-type must be application/json' };
  return null;
}

const STARTED = new Date().toISOString();
const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) { res.writeHead(403); return res.end('local only'); }
  const refusal = admissionRefusal(req);
  if (refusal) return json(res, refusal.status, { error: refusal.error });
  res.setHeader('x-content-type-options', 'nosniff');
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const fp = path.join(PUBLIC, path.normalize(file));
    if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    const data = await fs.readFile(fp).catch(() => null);
    if (!data) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(data);
  } catch (e) { json(res, 500, { error: e.message }); }
});

server.on('error', (e) => { if (e.code === 'EADDRINUSE') { console.error(`cockpit: port ${PORT} is already in use (another Cockpit running?). Try COCKPIT_PORT=4849 npm start`); process.exit(1); } throw e; });
server.listen(PORT, '127.0.0.1', async () => {
  console.log(`cockpit  http://127.0.0.1:${PORT}/   (pid ${process.pid})`);
  const env = await getEnv();
  // The watcher follows the project set it was built from: when a rescan discovers a different set of paths (added, removed or
  // replaced, even at the same count), it is rebuilt with this same callback and that set becomes the watched one.
  const projectPaths = (e) => [...new Set(e.projects.map((p) => p.path))].sort();
  let watchedPaths = projectPaths(env);
  const onChange = async (changed) => { console.log(`change   ${changed.slice(0, 3).map((c) => c.replace(HOME, '~')).join(', ')}${changed.length > 3 ? ` +${changed.length - 3}` : ''} → rescan`); bus.emit('event', { type: 'env.changed', changed }); const fresh = await getEnv(true).catch(() => null); if (!fresh) return; const paths = projectPaths(fresh); if (paths.join('\0') === watchedPaths.join('\0')) return; watcher.close(); watchedPaths = paths; watcher = startWatching({ projectPaths: paths, onChange }); console.log(`watching ${watcher.roots.length} roots for configuration changes (project set changed)`); };
  let watcher = startWatching({ projectPaths: watchedPaths, onChange });
  console.log(`watching ${watcher.roots.length} roots for configuration changes`);
  watchTranscripts({ onChange: async (file) => { let size = null, mtime = null; try { const st = await fs.stat(file); size = st.size; mtime = st.mtime.toISOString(); } catch {} bus.emit('event', { type: 'transcript.changed', path: file, size, mtime, provider: file.startsWith(CODEX_HOME + path.sep) ? 'codex' : 'claude' }); } }); console.log('watching transcripts for live sessions');
  console.log(`scanned  ${env.skills.length} skills · ${env.projects.length} projects · ${env.instructions.filter((i) => i.exists).length} instruction files · ${env.hooks.length} hooks · ${env.mcp.length} mcp servers · ${env.scanMs}ms`);
});
function shutdown() { console.log('\ncockpit shutting down: stopping owned subprocesses'); markInterruptedOnShutdown(); stopAll(); setTimeout(() => { killAllHard(); setTimeout(() => process.exit(0), 300); }, 1500); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
