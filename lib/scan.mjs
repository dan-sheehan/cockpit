// Environment scanner. Reads the real machine; never writes. Every fact is tagged with where it came from.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './frontmatter.mjs';
import { redactText, redactInline, redactArgs, redactObject, safeEnvNames } from './redact.mjs';
import { gitSummary } from './git.mjs';
import { HOME, CLAUDE_HOME, CLAUDE_JSON, CODEX_HOME, coversPath, realPathWithin } from './homes.mjs';

const run = promisify(execFile);
// Cockpit's own checkout, derived from this module's location (lib/..), so it never depends on process.cwd().
export const COCKPIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Optional extra roots whose children (and grandchildren) are checked for projects. No default: Cockpit does not guess a personal layout.
// COCKPIT_PROJECT_ROOTS holds absolute directories separated by path.delimiter (':' on macOS/Linux, ';' on Windows), like PATH.
export function parseProjectRoots(value) {
  return [...new Set((value || '').split(path.delimiter).map((s) => s.trim()).filter((s) => s && path.isAbsolute(s)).map((s) => path.resolve(s)))];
}
export const PROJECT_ROOTS = parseProjectRoots(process.env.COCKPIT_PROJECT_ROOTS);
const MAX_TEXT = 200 * 1024;

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
// root: a project's real path. When given, p is used only if it resolves (symlinks followed) inside that root, and is otherwise treated
// as missing, so a project file symlinked elsewhere (CLAUDE.md -> ../../private.txt) is never read. Without root (Claude/Codex homes) p is used as is.
async function within(p, root) { return root ? realPathWithin(root, p) : p; }
async function readText(p, root) { const f = await within(p, root); if (!f) return null; try { const s = await fs.stat(f); if (s.size > MAX_TEXT) return (await fs.readFile(f, 'utf8')).slice(0, MAX_TEXT) + '\n…[truncated]'; return await fs.readFile(f, 'utf8'); } catch { return null; } }
// Instruction-type files (CLAUDE.md, AGENTS.md, memory, rules, skills, agents, commands, plans) go into /api/env with their text,
// so they are read through the same redaction the file viewer applies; everything derived from them (frontmatter, titles) inherits it.
async function readInstruction(p, root) { const t = await readText(p, root); return t == null ? t : redactText(t); }
async function readJson(p, root) { const t = await readText(p, root); if (t == null) return null; try { return JSON.parse(t); } catch { return { __parseError: true }; } }
async function listDirs(p, root) { const d = await within(p, root); if (!d) return []; try { return (await fs.readdir(d, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch { return []; } }
async function statOr(p, root) { const f = await within(p, root); if (!f) return null; try { const s = await fs.stat(f); return { size: s.size, mtime: s.mtime.toISOString() }; } catch { return null; } }
async function version(cmd, args = ['--version']) {
  try { const { stdout } = await run(cmd, args, { timeout: 6000 }); return stdout.trim().split('\n')[0]; } catch { return null; }
}
async function dirSizes(root) {
  const out = [];
  for (const e of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(root, e.name);
    try { const { stdout } = await run('du', ['-sk', p], { timeout: 8000 }); out.push({ name: e.name, dir: e.isDirectory(), kb: Number(stdout.split('\t')[0]) || 0 }); } catch {}
  }
  return out.sort((a, b) => b.kb - a.kb);
}
// Like fs.readdir (it still rejects on a read error), but a directory outside root lists as empty.
async function readdirWithin(p, root) { const d = await within(p, root); return d ? fs.readdir(d) : []; }
async function which(cmd) { try { const { stdout } = await run('which', [cmd], { timeout: 3000 }); return stdout.trim() || null; } catch { return null; } }

// ---------- skills ----------
async function scanSkillDir(dir, { provider, scope, source, projectPath, root }) {
  const out = [];
  for (const name of await listDirs(dir, root)) {
    const file = path.join(dir, name, 'SKILL.md');
    const text = await readInstruction(file, root);
    if (text == null) continue;
    const { data, body } = parseFrontmatter(text);
    const links = [...new Set([...body.matchAll(/\[\[([a-z0-9_-]+)\]\]/gi)].map((m) => m[1].toLowerCase()))];
    const slashRefs = [...new Set([...body.matchAll(/(?:^|\s)\/([a-z][a-z0-9_-]{1,30})\b/g)].map((m) => m[1]))];
    const files = (await readdirWithin(path.join(dir, name), root)).filter((f) => f !== 'SKILL.md');
    out.push({
      id: `${provider}:${scope}:${name}`, provider, scope, source, projectPath: projectPath || null,
      name: data.name || name, dirName: name, description: data.description || '', userInvocable: data['user-invocable'] === true || data['user-invocable'] === 'true',
      frontmatter: data, path: file, dir: path.join(dir, name), links, slashRefs, files, body, stat: await statOr(file, root),
      system: source === 'system',
    });
  }
  return out;
}

// ---------- hooks ----------
function extractHooks(settings, sourcePath, scope) {
  const hooks = [];
  const h = settings?.hooks;
  if (!h || typeof h !== 'object') return hooks;
  for (const [event, entries] of Object.entries(h)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const list = Array.isArray(entry.hooks) ? entry.hooks : [entry];
      for (const hk of list) hooks.push({ event, matcher: entry.matcher || '*', type: hk.type || 'command', command: redactInline(String(hk.command || hk.url || '')), timeout: hk.timeout ?? null, source: sourcePath, scope });
    }
  }
  return hooks;
}

// ---------- mcp ----------
function extractMcp(obj, source, scope) {
  const out = [];
  const servers = obj?.mcpServers;
  if (!servers || typeof servers !== 'object') return out;
  for (const [name, cfg] of Object.entries(servers)) {
    out.push({ name, source, scope, type: cfg.type || (cfg.url ? 'http' : 'stdio'), command: cfg.command || null, args: redactArgs(cfg.args || []), url: cfg.url ? redactInline(String(cfg.url)) : null, envNames: Object.keys(cfg.env || {}) });
  }
  return out;
}

// ---------- toml (tiny, for codex config) ----------
// One value: a string, boolean, number, or a one-line inline array/table (args = ["…"], env = { KEY = "…" }) so that its keys
// and elements reach redactObject/redactArgs as structure. Nested or multi-line ones stay raw text.
function tomlValue(raw) {
  const v = raw.trim();
  if (/^".*"$/.test(v)) return v.slice(1, -1);
  if (/^(true|false)$/.test(v)) return v === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  const inner = v.match(/^\[(.*)\]$/) || v.match(/^\{(.*)\}$/);
  if (!inner || /[[\]{}]/.test(inner[1].replace(/"(?:[^"\\]|\\.)*"/g, ''))) return v;
  const parts = (inner[1].match(/(?:"(?:[^"\\]|\\.)*"|[^,"])+/g) || []).map((x) => x.trim()).filter(Boolean);
  if (v[0] === '[') return parts.map(tomlValue);
  const table = {};
  for (const part of parts) { const kv = part.match(/^("[^"]+"|[A-Za-z0-9_.-]+)\s*=\s*(.+)$/); if (!kv) return v; table[kv[1].replace(/^"|"$/g, '')] = tomlValue(kv[2]); }
  return table;
}
function parseTomlLite(text) {
  const root = {}; let cur = root;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const t = line.match(/^\[(.+)\]$/);
    if (t) {
      const keys = t[1].match(/"[^"]+"|[^.]+/g).map((k) => k.replace(/^"|"$/g, ''));
      cur = root; for (const k of keys) cur = (cur[k] ??= {});
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_."-]+)\s*=\s*(.+)$/);
    if (kv) cur[kv[1].replace(/^"|"$/g, '')] = tomlValue(kv[2]);
  }
  return root;
}

// ---------- projects ----------
function detectStack(entries, pkg) {
  const s = new Set();
  const has = (n) => entries.includes(n);
  if (pkg) { s.add('node'); if (pkg.dependencies?.next) s.add('next'); if (pkg.dependencies?.react) s.add('react'); if (pkg.devDependencies?.typescript || has('tsconfig.json')) s.add('typescript'); if (pkg.dependencies?.['@supabase/supabase-js'] || has('supabase')) s.add('supabase'); }
  if (has('pyproject.toml') || has('requirements.txt') || entries.some((e) => e.endsWith('.py'))) s.add('python');
  if (has('Cargo.toml')) s.add('rust'); if (has('go.mod')) s.add('go');
  if (has('Dockerfile') || has('docker-compose.yml')) s.add('docker');
  if (has('.github')) s.add('github-actions');
  return [...s];
}

async function scanProject(p, ctx) {
  // Every project file below is read only if it really lies inside the project (see within()).
  const root = await fs.realpath(p).catch(() => path.resolve(p));
  const entries = (await fs.readdir(p).catch(() => [])).filter((e) => e !== '.DS_Store');
  const pkg = await readJson(path.join(p, 'package.json'), root);
  const git = await gitSummary(p);
  const claudeMd = await readInstruction(path.join(p, 'CLAUDE.md'), root);
  const agentsMd = await readInstruction(path.join(p, 'AGENTS.md'), root);
  const claudeLocalMd = await readInstruction(path.join(p, 'CLAUDE.local.md'), root);
  const dotClaude = path.join(p, '.claude');
  const dotClaudeEntries = await readdirWithin(dotClaude, root).catch(() => []);
  const settings = await readJson(path.join(dotClaude, 'settings.json'), root);
  const settingsLocal = await readJson(path.join(dotClaude, 'settings.local.json'), root);
  const mcpJson = await readJson(path.join(p, '.mcp.json'), root);
  const skills = [
    ...(await scanSkillDir(path.join(dotClaude, 'skills'), { provider: 'claude', scope: 'PROJECT', source: 'project', projectPath: p, root })),
    ...(await scanSkillDir(path.join(p, '.agents', 'skills'), { provider: 'codex', scope: 'PROJECT', source: 'project', projectPath: p, root })),
  ];
  const agents = await scanAgentsDir(path.join(dotClaude, 'agents'), { provider: 'claude', scope: 'PROJECT', projectPath: p, root });
  const commandsDir = path.join(dotClaude, 'commands');
  const commands = [];
  for (const f of await readdirWithin(commandsDir, root).catch(() => [])) if (f.endsWith('.md')) { const t = await readInstruction(path.join(commandsDir, f), root); const { data, body } = parseFrontmatter(t || ''); commands.push({ name: f.replace(/\.md$/, ''), path: path.join(commandsDir, f), description: data.description || body.split('\n').find(Boolean) || '' }); }
  const hooks = [...extractHooks(settings, path.join(dotClaude, 'settings.json'), 'PROJECT'), ...extractHooks(settingsLocal, path.join(dotClaude, 'settings.local.json'), 'PROJECT-LOCAL')];
  const mcp = [...extractMcp(mcpJson, path.join(p, '.mcp.json'), 'PROJECT'), ...extractMcp(ctx.claudeJson?.projects?.[p], CLAUDE_JSON + ' projects[' + p + ']', 'PROJECT-USER')];
  const instructions = [];
  if (claudeMd != null) instructions.push({ provider: 'claude', scope: 'PROJECT', path: path.join(p, 'CLAUDE.md'), content: claudeMd, includes: [...claudeMd.matchAll(/^@(\S+)/gm)].map((m) => m[1]) });
  if (claudeLocalMd != null) instructions.push({ provider: 'claude', scope: 'PROJECT-LOCAL', path: path.join(p, 'CLAUDE.local.md'), content: claudeLocalMd, includes: [] });
  if (agentsMd != null) instructions.push({ provider: 'codex', scope: 'PROJECT', path: path.join(p, 'AGENTS.md'), content: agentsMd, includes: [] });
  const swag = await readText(path.join(dotClaude, 'swag.md'), root);
  const sessionsDirName = p.replace(/[\/.]/g, '-');
  const claudeSessions = (await fs.readdir(path.join(CLAUDE_HOME, 'projects', sessionsDirName)).catch(() => [])).filter((f) => f.endsWith('.jsonl'));
  const memoryDir = path.join(CLAUDE_HOME, 'projects', sessionsDirName, 'memory');
  const memoryFiles = (await fs.readdir(memoryDir).catch(() => [])).filter((f) => f.endsWith('.md'));
  for (const f of memoryFiles) { const t = await readInstruction(path.join(memoryDir, f)); if (t != null) instructions.push({ provider: 'claude', scope: 'MEMORY', kind: f === 'MEMORY.md' ? 'memory-index' : 'memory', path: path.join(memoryDir, f), content: t, includes: [] }); }
  return {
    id: p, name: path.basename(p), path: p, parent: path.dirname(p), git, stack: detectStack(entries, pkg),
    scripts: pkg?.scripts || {}, packageName: pkg?.name || null, entries: entries.slice(0, 60),
    ai: {
      hasClaudeMd: claudeMd != null, hasAgentsMd: agentsMd != null, hasClaudeLocalMd: claudeLocalMd != null, dotClaude: dotClaudeEntries, hasMcpJson: mcpJson != null,
      settings: settings ? redactObject(settings) : null, settingsLocal: settingsLocal ? redactObject(settingsLocal) : null, swag: swag != null,
      claudeTrusted: !!ctx.claudeJson?.projects?.[p]?.hasTrustDialogAccepted, codexTrust: ctx.codexConfig?.projects?.[p]?.trust_level || null,
      claudeSessionCount: claudeSessions.length, memoryFiles: memoryFiles.length, memoryDir: memoryFiles.length ? memoryDir : null,
    },
    skills, agents, commands, hooks, mcp, instructions,
  };
}

async function scanAgentsDir(dir, { provider, scope, projectPath, root }) {
  const out = [];
  for (const f of await readdirWithin(dir, root).catch(() => [])) {
    if (!f.endsWith('.md')) continue;
    const text = await readInstruction(path.join(dir, f), root);
    const { data, body } = parseFrontmatter(text || '');
    out.push({ provider, scope, projectPath: projectPath || null, name: data.name || f.replace(/\.md$/, ''), description: data.description || '', tools: data.tools || null, model: data.model || null, path: path.join(dir, f), body });
  }
  return out;
}

// A project is a file-viewer root and an action target, so it must never be the filesystem root, HOME, or an ancestor of HOME
// (Claude/Codex record whatever directory a session ran in, even / or ~). Real paths, so a symlink or a case variant cannot slip past.
async function tooBroadForProject(p) {
  const real = await fs.realpath(p).catch(() => null);
  if (!real) return true; // missing: never a project anyway
  return real === path.parse(real).root || coversPath(real, await fs.realpath(HOME).catch(() => HOME));
}

// Sources: Cockpit itself, COCKPIT_PROJECT_ROOTS (two levels deep at most), and paths known to Claude Code / Codex that still exist.
export async function discoverProjectPaths(ctx, { roots = PROJECT_ROOTS, self = COCKPIT_ROOT } = {}) {
  const found = new Set([self]);
  const add = async (p) => { if (!(await tooBroadForProject(p))) found.add(p); };
  for (const root of roots) {
    for (const d of await listDirs(root)) {
      const p = path.join(root, d);
      const entries = await fs.readdir(p).catch(() => []);
      const looksLikeProject = entries.some((e) => ['.git', 'package.json', 'CLAUDE.md', 'AGENTS.md', 'pyproject.toml', 'README.md', '.claude'].includes(e));
      if (looksLikeProject) await add(p);
      else for (const sub of await listDirs(p)) { const sp = path.join(p, sub); const se = await fs.readdir(sp).catch(() => []); if (se.some((e) => ['.git', 'package.json', 'CLAUDE.md', 'AGENTS.md', 'pyproject.toml', 'README.md'].includes(e))) await add(sp); }
    }
  }
  for (const p of Object.keys(ctx.claudeJson?.projects || {})) await add(p);
  for (const p of Object.keys(ctx.codexConfig?.projects || {})) await add(p);
  return [...found].sort();
}

// ---------- main ----------
export async function scanEnvironment() {
  const started = Date.now();
  const claudeJson = await readJson(CLAUDE_JSON);
  const codexConfigText = await readText(path.join(CODEX_HOME, 'config.toml'));
  const codexConfig = codexConfigText ? parseTomlLite(codexConfigText) : null;
  const ctx = { claudeJson, codexConfig };

  const [claudeVersion, codexVersion, nodeV, npmV, gitV, ghV, pyV, jqV, claudePath, codexPath] = await Promise.all([
    version('claude'), version('codex'), version('node'), version('npm'), version('git'), version('gh'), version('python3'), version('jq'), which('claude'), which('codex'),
  ]);
  const tools = [
    { name: 'claude', label: 'Claude Code', version: claudeVersion, path: claudePath, role: 'agent', configHome: CLAUDE_HOME },
    { name: 'codex', label: 'Codex CLI', version: codexVersion, path: codexPath, role: 'agent', configHome: CODEX_HOME },
    { name: 'node', label: 'Node.js', version: nodeV, path: await which('node'), role: 'runtime' },
    { name: 'npm', label: 'npm', version: npmV, path: await which('npm'), role: 'runtime' },
    { name: 'git', label: 'git', version: gitV, path: await which('git'), role: 'vcs' },
    { name: 'gh', label: 'GitHub CLI', version: ghV, path: await which('gh'), role: 'vcs' },
    { name: 'python3', label: 'Python', version: pyV, path: await which('python3'), role: 'runtime' },
    { name: 'jq', label: 'jq', version: jqV, path: await which('jq'), role: 'util' },
  ].map((t) => ({ ...t, status: t.version ? 'available' : 'missing' }));
  for (const name of ['ollama', 'lms', 'bun', 'deno', 'uv', 'docker']) { const p = await which(name); if (p) tools.push({ name, label: name, version: await version(name), path: p, role: 'other', status: 'available' }); }

  // Claude global
  const claudeSettings = await readJson(path.join(CLAUDE_HOME, 'settings.json'));
  const claudeSettingsLocal = await readJson(path.join(CLAUDE_HOME, 'settings.local.json'));
  const globalClaudeMd = await readInstruction(path.join(CLAUDE_HOME, 'CLAUDE.md'));
  const globalSkills = await scanSkillDir(path.join(CLAUDE_HOME, 'skills'), { provider: 'claude', scope: 'GLOBAL', source: 'user' });
  const globalAgents = await scanAgentsDir(path.join(CLAUDE_HOME, 'agents'), { provider: 'claude', scope: 'GLOBAL' });
  const globalCommands = [];
  for (const f of await fs.readdir(path.join(CLAUDE_HOME, 'commands')).catch(() => [])) if (f.endsWith('.md')) { const t = await readInstruction(path.join(CLAUDE_HOME, 'commands', f)); const { data, body } = parseFrontmatter(t || ''); globalCommands.push({ name: f.replace(/\.md$/, ''), path: path.join(CLAUDE_HOME, 'commands', f), description: data.description || body.split('\n').find(Boolean) || '', scope: 'GLOBAL' }); }
  const rulesDir = path.join(CLAUDE_HOME, 'rules');
  const claudeRules = [];
  for (const f of await fs.readdir(rulesDir).catch(() => [])) if (f.endsWith('.md')) claudeRules.push({ name: f, path: path.join(rulesDir, f), content: await readInstruction(path.join(rulesDir, f)) });
  const marketplaces = await readJson(path.join(CLAUDE_HOME, 'plugins', 'known_marketplaces.json'));
  const installedPlugins = await readJson(path.join(CLAUDE_HOME, 'plugins', 'installed_plugins.json'));
  const marketplaceDirs = await listDirs(path.join(CLAUDE_HOME, 'plugins', 'marketplaces'));
  const marketplaceInfo = [];
  for (const m of marketplaceDirs) {
    const base = path.join(CLAUDE_HOME, 'plugins', 'marketplaces', m);
    const ext = await listDirs(path.join(base, 'external_plugins'));
    const internal = await listDirs(path.join(base, 'plugins'));
    marketplaceInfo.push({ name: m, path: base, externalPlugins: ext, plugins: internal });
  }
  const historyText = await readText(path.join(CLAUDE_HOME, 'history.jsonl'));
  const claudeHistory = (historyText || '').split('\n').filter(Boolean).slice(-40).map((l) => { try { const j = JSON.parse(l); return { display: redactText(String(j.display || '')).slice(0, 200), project: j.project, ts: j.timestamp, sessionId: j.sessionId }; } catch { return null; } }).filter(Boolean).reverse();
  const claudeProjectDirs = await listDirs(path.join(CLAUDE_HOME, 'projects'));
  let claudeSessionTotal = 0; const claudeSessionsByProject = [];
  for (const d of claudeProjectDirs) { const files = (await fs.readdir(path.join(CLAUDE_HOME, 'projects', d)).catch(() => [])).filter((f) => f.endsWith('.jsonl')); claudeSessionTotal += files.length; claudeSessionsByProject.push({ dir: d, count: files.length }); }
  const plansDir = await fs.readdir(path.join(CLAUDE_HOME, 'plans')).catch(() => []);
  const plans = []; for (const f of plansDir.filter((x) => x.endsWith('.md'))) { const st = await statOr(path.join(CLAUDE_HOME, 'plans', f)); const t = await readInstruction(path.join(CLAUDE_HOME, 'plans', f)); plans.push({ name: f, path: path.join(CLAUDE_HOME, 'plans', f), mtime: st?.mtime, size: st?.size, title: (t || '').split('\n').find((l) => l.startsWith('#'))?.replace(/^#+\s*/, '') || null }); }

  // Codex global
  const codexRulesDir = path.join(CODEX_HOME, 'rules');
  const codexRules = [];
  for (const f of await fs.readdir(codexRulesDir).catch(() => [])) { const t = await readInstruction(path.join(codexRulesDir, f)); codexRules.push({ name: f, path: path.join(codexRulesDir, f), content: redactText(t || ''), rules: (t || '').split('\n').filter((l) => l.trim().startsWith('prefix_rule')).map((l) => { const pat = l.match(/pattern=\[(.*?)\]/); const dec = l.match(/decision="(\w+)"/); return { pattern: pat ? pat[1].replace(/"/g, '').split(',').map((s) => s.trim()).join(' ') : l, decision: dec ? dec[1] : '?' }; }) }); }
  const codexUserSkills = await scanSkillDir(path.join(CODEX_HOME, 'skills'), { provider: 'codex', scope: 'GLOBAL', source: 'user' });
  const codexSystemSkills = await scanSkillDir(path.join(CODEX_HOME, 'skills', '.system'), { provider: 'codex', scope: 'GLOBAL', source: 'system' });
  const codexAgentsMd = await readInstruction(path.join(CODEX_HOME, 'AGENTS.md'));
  const codexSessionIndexText = await readText(path.join(CODEX_HOME, 'session_index.jsonl'));
  const codexSessions = Object.values(Object.fromEntries((codexSessionIndexText || '').split('\n').filter(Boolean).map((l) => { try { const j = JSON.parse(l); return [j.id, { id: j.id, name: redactText(j.thread_name || ''), updatedAt: j.updated_at }]; } catch { return null; } }).filter(Boolean))).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const codexVersionJson = await readJson(path.join(CODEX_HOME, 'version.json'));
  const codexPluginCache = await listDirs(path.join(CODEX_HOME, 'plugins', 'cache'));
  const codexPlugins = [];
  for (const m of codexPluginCache) codexPlugins.push({ marketplace: m, plugins: await listDirs(path.join(CODEX_HOME, 'plugins', 'cache', m)) });
  const codexMcp = Object.entries(codexConfig?.mcp_servers || {}).map(([name, cfg]) => ({ name, source: path.join(CODEX_HOME, 'config.toml'), scope: 'GLOBAL', type: cfg.url ? 'http' : 'stdio', command: cfg.command || null, args: redactArgs(cfg.args || []), url: cfg.url ? redactInline(String(cfg.url)) : null, envNames: Object.keys(cfg.env || {}), provider: 'codex' }));

  // Projects
  const projectPaths = await discoverProjectPaths(ctx);
  const projects = [];
  for (const p of projectPaths) projects.push(await scanProject(p, ctx));

  // Aggregate
  const skills = [...globalSkills, ...codexUserSkills, ...codexSystemSkills, ...projects.flatMap((p) => p.skills)];
  const skillNames = new Set(skills.map((s) => s.name.toLowerCase()));
  for (const s of skills) { s.linksResolved = s.links.map((l) => ({ name: l, exists: skillNames.has(l) })); s.slashRefsResolved = s.slashRefs.filter((r) => skillNames.has(r.toLowerCase()) && r.toLowerCase() !== s.name.toLowerCase()); }
  const hooks = [
    ...extractHooks(claudeSettings, path.join(CLAUDE_HOME, 'settings.json'), 'GLOBAL'),
    ...extractHooks(claudeSettingsLocal, path.join(CLAUDE_HOME, 'settings.local.json'), 'GLOBAL-LOCAL'),
    ...projects.flatMap((p) => p.hooks.map((h) => ({ ...h, project: p.path }))),
  ];
  const mcp = [
    ...extractMcp(claudeJson, CLAUDE_JSON, 'GLOBAL').map((m) => ({ ...m, provider: 'claude' })),
    ...projects.flatMap((p) => p.mcp.map((m) => ({ ...m, provider: 'claude', project: p.path }))),
    ...codexMcp,
  ];
  const instructions = [
    { provider: 'claude', scope: 'GLOBAL', path: path.join(CLAUDE_HOME, 'CLAUDE.md'), content: globalClaudeMd, exists: globalClaudeMd != null, includes: [] },
    { provider: 'claude', scope: 'GLOBAL', kind: 'settings', path: path.join(CLAUDE_HOME, 'settings.json'), content: claudeSettings ? JSON.stringify(redactObject(claudeSettings), null, 2) : null, exists: claudeSettings != null, includes: [] },
    { provider: 'claude', scope: 'GLOBAL-LOCAL', kind: 'settings', path: path.join(CLAUDE_HOME, 'settings.local.json'), content: claudeSettingsLocal ? JSON.stringify(redactObject(claudeSettingsLocal), null, 2) : null, exists: claudeSettingsLocal != null, includes: [] },
    ...claudeRules.map((r) => ({ provider: 'claude', scope: 'GLOBAL', kind: 'rule', path: r.path, content: r.content, exists: true, includes: [] })),
    { provider: 'codex', scope: 'GLOBAL', path: path.join(CODEX_HOME, 'AGENTS.md'), content: codexAgentsMd, exists: codexAgentsMd != null, includes: [] },
    { provider: 'codex', scope: 'GLOBAL', kind: 'settings', path: path.join(CODEX_HOME, 'config.toml'), content: codexConfigText ? redactText(codexConfigText) : null, exists: codexConfigText != null, includes: [] },
    ...codexRules.map((r) => ({ provider: 'codex', scope: 'GLOBAL', kind: 'rule', path: r.path, content: r.content, exists: true, includes: [], parsedRules: r.rules })),
    ...projects.flatMap((p) => p.instructions.map((i) => ({ ...i, exists: true, project: p.path }))),
    ...projects.filter((p) => p.ai.settings).map((p) => ({ provider: 'claude', scope: 'PROJECT', kind: 'settings', path: path.join(p.path, '.claude', 'settings.json'), content: JSON.stringify(p.ai.settings, null, 2), exists: true, includes: [], project: p.path })),
    ...projects.filter((p) => p.ai.settingsLocal).map((p) => ({ provider: 'claude', scope: 'PROJECT-LOCAL', kind: 'settings', path: path.join(p.path, '.claude', 'settings.local.json'), content: JSON.stringify(p.ai.settingsLocal, null, 2), exists: true, includes: [], project: p.path })),
  ].map((i) => ({ ...i, kind: i.kind || 'instructions', size: i.content ? i.content.length : 0 }));
  const agents = [...globalAgents, ...projects.flatMap((p) => p.agents)];

  const [claudeFootprint, codexFootprint] = await Promise.all([dirSizes(CLAUDE_HOME), dirSizes(CODEX_HOME)]);
  return {
    scannedAt: new Date().toISOString(), scanMs: Date.now() - started,
    footprint: { claude: claudeFootprint, codex: codexFootprint },
    machine: { hostname: os.hostname(), platform: process.platform, release: os.release(), arch: process.arch, user: os.userInfo().username, home: HOME, node: process.version, cpus: os.cpus().length, memGb: Math.round(os.totalmem() / 1e9) },
    tools,
    claude: {
      version: claudeVersion, home: CLAUDE_HOME, jsonPath: CLAUDE_JSON, path: claudePath, settings: redactObject(claudeSettings || {}), settingsLocal: claudeSettingsLocal ? redactObject(claudeSettingsLocal) : null,
      model: claudeSettings?.model || null, effort: claudeSettings?.modelSettings ? Object.values(claudeSettings.modelSettings)[0]?.effortLevel : null, theme: claudeSettings?.theme || null, tui: claudeSettings?.tui || null,
      hasGlobalClaudeMd: globalClaudeMd != null, skillCount: globalSkills.length, agentCount: globalAgents.length, commandCount: globalCommands.length, ruleCount: claudeRules.length,
      marketplaces: marketplaceInfo, knownMarketplaces: marketplaces ? Object.keys(marketplaces) : [], installedPlugins: installedPlugins ? redactObject(installedPlugins) : null,
      history: claudeHistory, sessionTotal: claudeSessionTotal, sessionsByProject: claudeSessionsByProject, planCount: plansDir.length, plans: plans.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || '')),
      trustedProjects: Object.entries(claudeJson?.projects || {}).filter(([, v]) => v.hasTrustDialogAccepted).map(([k]) => k),
      installMethod: claudeJson?.installMethod || null, autoUpdates: claudeJson?.autoUpdates ?? null, firstStartVersion: claudeJson?.firstStartVersion || null,
      chrome: !!claudeJson?.cachedChromeExtensionInstalled,
    },
    codex: {
      version: codexVersion, home: CODEX_HOME, path: codexPath, configText: codexConfigText ? redactText(codexConfigText) : null, config: redactObject(codexConfig || {}),
      approvalsReviewer: codexConfig?.approvals_reviewer || null, trustedProjects: Object.entries(codexConfig?.projects || {}).map(([k, v]) => ({ path: k, trust: v.trust_level })),
      rules: codexRules, userSkillCount: codexUserSkills.length, systemSkillCount: codexSystemSkills.length, sessions: codexSessions.slice(0, 30), sessionTotal: codexSessions.length,
      latestVersion: codexVersionJson?.latest_version || null, plugins: codexPlugins, hasGlobalAgentsMd: codexAgentsMd != null, mcpCount: codexMcp.length,
      authConfigured: await exists(path.join(CODEX_HOME, 'auth.json')),
    },
    skills, hooks, mcp, agents, instructions, projects,
    commands: [...globalCommands, ...projects.flatMap((p) => p.commands.map((c) => ({ ...c, scope: 'PROJECT', project: p.path })))],
    env: safeEnvNames(),
  };
}
