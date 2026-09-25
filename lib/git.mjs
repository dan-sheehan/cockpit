import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

async function git(cwd, args, opts = {}) {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: opts.timeout ?? 8000, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, out: stdout };
  } catch (e) {
    return { ok: false, out: e.stdout || '', err: (e.stderr || e.message || '').trim() };
  }
}

export async function gitSummary(cwd) {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out.trim() !== 'true') return { isRepo: false };
  const [root, branch, status, log, remotes] = await Promise.all([
    git(cwd, ['rev-parse', '--show-toplevel']),
    git(cwd, ['branch', '--show-current']),
    git(cwd, ['status', '--porcelain=v1', '--untracked-files=normal']),
    git(cwd, ['log', '-5', '--format=%h%x09%s%x09%ar%x09%an']),
    git(cwd, ['remote', '-v']),
  ]);
  const lines = status.out.split('\n').filter(Boolean);
  const files = lines.map((l) => ({ status: l.slice(0, 2).trim() || '??', path: l.slice(3) }));
  return {
    isRepo: true,
    root: root.out.trim(),
    branch: branch.out.trim() || '(detached)',
    dirty: files.length > 0,
    changedCount: files.length,
    files: files.slice(0, 200),
    recentCommits: log.out.split('\n').filter(Boolean).map((l) => {
      const [hash, subject, when, author] = l.split('\t');
      return { hash, subject, when, author };
    }),
    remotes: remotes.out.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[0]).filter((v, i, a) => a.indexOf(v) === i),
  };
}

export async function gitDiff(cwd, { stat = false } = {}) {
  const args = stat ? ['diff', '--stat'] : ['diff'];
  const tracked = await git(cwd, args, { timeout: 15000 });
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  return { diff: tracked.out, untracked: untracked.out.split('\n').filter(Boolean) };
}

// Snapshot the working tree so a later diff can be computed against it even if the repo had prior dirty state.
export async function treeSnapshot(cwd) {
  const status = await git(cwd, ['status', '--porcelain=v1']);
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  const stash = await git(cwd, ['stash', 'create']); // does not modify the tree or the stash list
  return { head: head.out.trim(), stashRef: stash.out.trim() || null, porcelain: status.out };
}

export async function diffSince(cwd, snapshot) {
  const base = snapshot?.stashRef || snapshot?.head || 'HEAD';
  const d = await git(cwd, ['diff', base], { timeout: 15000 });
  const stat = await git(cwd, ['diff', '--stat', base], { timeout: 15000 });
  const names = await git(cwd, ['diff', '--name-status', base]);
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  const untrackedList = untracked.out.split('\n').filter(Boolean);
  const changed = names.out.split('\n').filter(Boolean).map((l) => { const [s, ...p] = l.split('\t'); return { status: s, path: p.join('\t') }; });
  return { base, diff: d.out, stat: stat.out, changed, untracked: untrackedList };
}
