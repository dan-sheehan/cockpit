// Where Claude Code and Codex keep their state: one definition shared by the scanner, watcher, transcript parser and server.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
// Claude Code: CLAUDE_CONFIG_DIR replaces ~/.claude, and its global .claude.json then lives inside that directory too.
export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
export const CLAUDE_JSON = path.join(process.env.CLAUDE_CONFIG_DIR || HOME, '.claude.json');
// Codex: CODEX_HOME replaces ~/.codex.
export const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');

// For display: the resolved path with the home directory shown as ~ (so the default reads ~/.claude, a moved one its real place).
export const tildify = (p) => (p === HOME || p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p);

// True when p is dir itself or inside it (path-segment aware, so /Users/me2 is not inside /Users/me).
export function coversPath(dir, p) {
  const rel = path.relative(dir, p);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// The real path of p when it resolves (symlinks followed) to realRoot or somewhere inside it; null when it escapes or does not exist.
// realRoot must already be a real path (fs.realpath), so both sides of the coversPath comparison are resolved.
export async function realPathWithin(realRoot, p) {
  const real = await fs.realpath(p).catch(() => null);
  return real && coversPath(realRoot, real) ? real : null;
}
