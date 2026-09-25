// Diff two environment scans into human-readable change events. Pure function; the server persists the result.
import { tildify } from './homes.mjs';
export function diffEnv(prev, next) {
  if (!prev) return [];
  const ch = [];
  const at = next.scannedAt;
  const add = (kind, text, target) => ch.push({ t: at, kind, text, target });
  const byId = (arr, key) => new Map(arr.map((x) => [x[key], x]));
  // skills
  const ps = byId(prev.skills, 'id'), ns = byId(next.skills, 'id');
  for (const [id, s] of ns) if (!ps.has(id)) add('skill', `skill added: /${s.name} (${s.scope})`, { view: 'skills', id }); else if (ps.get(id).stat?.mtime !== s.stat?.mtime) add('skill', `skill edited: /${s.name}`, { view: 'skills', id });
  for (const [id, s] of ps) if (!ns.has(id)) add('skill', `skill removed: /${s.name}`, { view: 'skills' });
  // instruction files
  const pi = byId(prev.instructions.filter((i) => i.exists), 'path'), ni = byId(next.instructions.filter((i) => i.exists), 'path');
  for (const [p, i] of ni) if (!pi.has(p)) add('instructions', `${i.kind} file appeared: ${p}`, { view: 'instructions', id: p }); else if (pi.get(p).content !== i.content) add('instructions', `${i.kind} changed: ${p} (${pi.get(p).size} → ${i.size} chars)`, { view: 'instructions', id: p });
  for (const [p, i] of pi) if (!ni.has(p)) add('instructions', `${i.kind} file removed: ${p}`, { view: 'instructions' });
  // hooks / mcp / agents counts
  for (const [k, label, view] of [['hooks', 'hooks', 'hooks'], ['mcp', 'MCP servers', 'mcp'], ['agents', 'agent definitions', 'agents']]) if (prev[k].length !== next[k].length) add(k, `${label}: ${prev[k].length} → ${next[k].length}`, { view });
  // versions
  for (const t of next.tools) { const o = prev.tools.find((x) => x.name === t.name); if (o && o.version !== t.version) add('tool', `${t.label}: ${o.version || 'missing'} → ${t.version || 'missing'}`, { view: 'overview' }); }
  // settings
  if (JSON.stringify(prev.claude.settings) !== JSON.stringify(next.claude.settings)) add('settings', `${tildify(next.claude.home + '/settings.json')} changed (model ${prev.claude.model} → ${next.claude.model})`, { view: 'instructions', id: next.claude.home + '/settings.json' });
  if (prev.codex.configText !== next.codex.configText) add('settings', `${tildify(next.codex.home + '/config.toml')} changed`, { view: 'instructions', id: next.codex.home + '/config.toml' });
  const prules = prev.codex.rules.reduce((a, r) => a + r.rules.length, 0), nrules = next.codex.rules.reduce((a, r) => a + r.rules.length, 0);
  if (prules !== nrules) add('policy', `Codex exec-policy rules: ${prules} → ${nrules}`, { view: 'hooks' });
  // projects
  const pp = byId(prev.projects, 'path'), np = byId(next.projects, 'path');
  for (const [p, x] of np) { const o = pp.get(p); if (!o) { add('project', `project discovered: ${x.name}`, { view: 'projects', id: p }); continue; }
    if (o.git.branch !== x.git.branch) add('git', `${x.name}: branch ${o.git.branch} → ${x.git.branch}`, { view: 'projects', id: p, tab: 'git' });
    if (o.git.recentCommits?.[0]?.hash !== x.git.recentCommits?.[0]?.hash && x.git.recentCommits?.[0]) add('git', `${x.name}: new commit ${x.git.recentCommits[0].hash} ${x.git.recentCommits[0].subject}`, { view: 'projects', id: p, tab: 'git' });
    if (o.git.dirty !== x.git.dirty) add('git', `${x.name}: ${x.git.dirty ? 'now dirty (' + x.git.changedCount + ' paths)' : 'now clean'}`, { view: 'projects', id: p, tab: 'git' });
    if (o.ai.hasClaudeMd !== x.ai.hasClaudeMd) add('instructions', `${x.name}: CLAUDE.md ${x.ai.hasClaudeMd ? 'added' : 'removed'}`, { view: 'projects', id: p, tab: 'ai config' });
    if (o.ai.hasAgentsMd !== x.ai.hasAgentsMd) add('instructions', `${x.name}: AGENTS.md ${x.ai.hasAgentsMd ? 'added' : 'removed'}`, { view: 'projects', id: p, tab: 'ai config' });
    if (o.ai.claudeTrusted !== x.ai.claudeTrusted) add('trust', `${x.name}: Claude trust ${x.ai.claudeTrusted ? 'granted' : 'revoked'}`, { view: 'projects', id: p });
    if (o.ai.codexTrust !== x.ai.codexTrust) add('trust', `${x.name}: Codex trust ${o.ai.codexTrust || 'none'} → ${x.ai.codexTrust || 'none'}`, { view: 'projects', id: p });
  }
  for (const [p, x] of pp) if (!np.has(p)) add('project', `project gone: ${x.name}`, { view: 'projects' });
  if (prev.claude.sessionTotal !== next.claude.sessionTotal) add('transcript', `Claude Code sessions on disk: ${prev.claude.sessionTotal} → ${next.claude.sessionTotal}`, { view: 'transcripts' });
  if (prev.codex.sessionTotal !== next.codex.sessionTotal) add('transcript', `Codex threads: ${prev.codex.sessionTotal} → ${next.codex.sessionTotal}`, { view: 'transcripts' });
  if ((prev.claude.plans?.length || 0) !== (next.claude.plans?.length || 0)) add('plan', `Claude plan files: ${prev.claude.plans?.length || 0} → ${next.claude.plans?.length || 0}`, { view: 'overview' });
  return ch;
}
