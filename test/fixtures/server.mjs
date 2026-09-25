// Boots the real server on a spare port from an unrelated cwd, with the given environment overrides.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function bootServer(env, attempts = 3) {
  try { return await bootOnce(env); } catch (e) { if (attempts <= 1) throw e; return bootServer(env, attempts - 1); } // e.g. the random port was taken
}

async function bootOnce(env) {
  const port = 4899 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: os.tmpdir(), env: { ...process.env, ...env, COCKPIT_PORT: String(port), COCKPIT_DATA_DIR: path.join(os.tmpdir(), 'cockpit-test-data-' + port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.stdout.on('data', (d) => { if (String(d).includes('cockpit ')) resolve(); }); child.on('exit', (c) => reject(new Error('server exited ' + c))); setTimeout(() => reject(new Error('server start timeout')), 10000); });
  return { child, port, base: `http://127.0.0.1:${port}` };
}
