import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.COCKPIT_DATA_DIR || path.join(ROOT, 'data');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export const RUNS_DIR = path.join(DATA_DIR, 'runs');

await fs.mkdir(SESSIONS_DIR, { recursive: true });
await fs.mkdir(RUNS_DIR, { recursive: true });

const timers = new Map();
// `obj` may be a function returning the current snapshot, so a debounced write never persists stale state.
export function saveSoon(dir, id, obj, delay = 250) {
  const key = dir + '/' + id;
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => { timers.delete(key); saveNow(dir, id, obj).catch(() => {}); }, delay));
}
export async function saveNow(dir, id, obj) {
  const key = dir + '/' + id;
  clearTimeout(timers.get(key)); timers.delete(key);
  if (typeof obj === 'function') obj = obj();
  const file = path.join(dir, id + '.json');
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, file);
}
export async function load(dir, id) { try { return JSON.parse(await fs.readFile(path.join(dir, id + '.json'), 'utf8')); } catch { return null; } }
export async function listAll(dir) {
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) { try { out.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))); } catch {} }
  return out;
}
export function newId(prefix) { return `${prefix}_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`; }
