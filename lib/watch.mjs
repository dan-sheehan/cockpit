// Watches the files that shape agent behaviour and asks for a rescan when they change. Read-only; never writes.
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME, CLAUDE_JSON, CODEX_HOME } from './homes.mjs';

const RELEVANT = /(^|\/)(settings(\.local)?\.json|CLAUDE(\.local)?\.md|AGENTS(\.override)?\.md|config\.toml|\.mcp\.json|package\.json|known_marketplaces\.json|installed_plugins\.json|SKILL\.md|[^/]+\.rules|[^/]+\.md)$|(^|\/)(skills|agents|commands|rules|plugins)(\/|$)/;
const IGNORE = /(^|\/)(projects|sessions|session-env|shell-snapshots|shell_snapshots|paste-cache|file-history|cache|\.tmp|tmp|logs?|node_modules|\.git|\.next|data|telemetry|ide|downloads|backups|generated_images|ipc|thread-writer-locks|plans|statsig)(\/|$)|\.sqlite|history\.jsonl/;

// Live transcript watch: the agents' own logs grow while they run. Emits per-file change events (debounced) so the UI can follow a session that Cockpit does not own.
export function watchTranscripts({ onChange, debounceMs = 800 }) {
  const timers = new Map(); const watchers = [];
  const fire = (root, file) => { const f = String(file || ''); if (!f.endsWith('.jsonl')) return; const full = path.join(root, f); clearTimeout(timers.get(full)); timers.set(full, setTimeout(() => { timers.delete(full); onChange(full); }, debounceMs)); };
  for (const root of [path.join(CLAUDE_HOME, 'projects'), path.join(CODEX_HOME, 'sessions')]) { try { if (!fs.existsSync(root)) continue; const w = fs.watch(root, { recursive: true, persistent: false }, (ev, file) => fire(root, file)); w.on('error', () => {}); watchers.push(w); } catch {} }
  return { close: () => { for (const w of watchers) try { w.close(); } catch {} } };
}
// IGNORE applies to the path inside a watched root, never to the root's own location: a project under ~/tmp or a config dir under /data is still watched.
export function startWatching({ projectPaths, onChange, debounceMs = 1500 }) {
  const watchers = []; let timer = null; const pending = new Set();
  const fire = (root, file) => { const rel = file || ''; const full = path.join(root, rel); if (IGNORE.test(rel)) return; if (!RELEVANT.test(full) && !RELEVANT.test(rel)) return; pending.add(full); clearTimeout(timer); timer = setTimeout(() => { const changed = [...pending]; pending.clear(); onChange(changed); }, debounceMs); };
  const add = (root, recursive) => { try { if (!fs.existsSync(root)) return; const w = fs.watch(root, { recursive, persistent: false }, (ev, file) => fire(root, file ? String(file) : '')); w.on('error', () => {}); watchers.push({ root, w }); } catch {} };
  add(CLAUDE_HOME, true); add(CLAUDE_JSON, false); add(CODEX_HOME, true);
  for (const p of projectPaths) { add(p, false); add(path.join(p, '.claude'), true); add(path.join(p, '.agents'), true); addGit(p); }
  function addGit(p) { const g = path.join(p, '.git'); try { if (!fs.existsSync(g)) return; const w = fs.watch(g, { recursive: false, persistent: false }, (ev, file) => { if (/^(index|HEAD|ORIG_HEAD|FETCH_HEAD)$/.test(String(file || ''))) { pending.add(path.join(g, String(file))); clearTimeout(timer); timer = setTimeout(() => { const changed = [...pending]; pending.clear(); onChange(changed); }, debounceMs); } }); w.on('error', () => {}); watchers.push({ root: g, w }); } catch {} }
  return { roots: watchers.map((w) => w.root), close: () => { for (const { w } of watchers) try { w.close(); } catch {} } };
}
