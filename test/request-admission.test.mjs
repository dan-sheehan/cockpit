// Cross-site request forgery: a foreign web page can make the browser send a "simple" POST (text/plain, form) to
// 127.0.0.1 without any CORS preflight. Every state-changing request must come from Cockpit's own page, as JSON.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { makeFixtureHomes, readOsascriptCalls } from './fixtures/homes.mjs';
import { bootServer } from './fixtures/server.mjs';

let server, fx, proj, ORIGIN;

// Raw request so the test fully controls which headers are (not) sent.
function send(pathname, { method = 'POST', origin, type = 'application/json', body = '', host } = {}) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (type !== null) headers['content-type'] = type;
  if (host) headers.host = host;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, path: pathname, method, headers }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
    req.on('error', reject); req.end(body);
  });
}
const action = (a) => JSON.stringify({ projectPath: proj, ...a });
const runCount = async () => JSON.parse((await send('/api/runs', { method: 'GET', type: null })).body).length;
const sessionCount = async () => JSON.parse((await send('/api/sessions', { method: 'GET', type: null })).body).length;

before(async () => {
  fx = await makeFixtureHomes();
  proj = path.join(fx.base, 'projects', 'app');
  await fs.mkdir(proj, { recursive: true }); await fs.writeFile(path.join(proj, 'README.md'), '# app\n');
  server = await bootServer({ ...fx.env, COCKPIT_PROJECT_ROOTS: path.join(fx.base, 'projects') });
  ORIGIN = `http://127.0.0.1:${server.port}`;
});
after(() => { server?.child.kill('SIGTERM'); });

test('a foreign page cannot trigger actions: every refused request has no side effect', async () => {
  const runs = await runCount(), sessions = await sessionCount();
  const attempts = [
    { origin: 'https://evil.example', type: 'text/plain', body: action({ action: 'git.status' }) }, // the reproduced attack
    { origin: 'https://evil.example', type: 'text/plain', body: action({ action: 'launch.terminal', tool: 'claude' }) },
    { origin: 'https://evil.example', type: 'application/x-www-form-urlencoded', body: 'action=git.status' },
    { origin: 'https://evil.example', type: 'application/json', body: action({ action: 'git.status' }) },
    { origin: 'null', type: 'application/json', body: action({ action: 'git.status' }) },
    { type: 'application/json', body: action({ action: 'git.status' }) }, // no Origin at all
  ];
  for (const a of attempts) {
    const r = await send('/api/actions', a);
    assert.equal(r.status, 403, JSON.stringify(a));
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
  for (const [p, body] of [['/api/sessions', JSON.stringify({ task: 'x', projectPath: proj })], ['/api/runs/run_x/stop', ''], ['/api/sessions/s_x/cancel', ''], ['/api/sessions/s_x/retry', '']]) {
    assert.equal((await send(p, { origin: 'https://evil.example', type: 'text/plain', body })).status, 403, p);
  }
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await runCount(), runs, 'no run was started');
  assert.equal(await sessionCount(), sessions, 'no session was created');
  assert.deepEqual(await readOsascriptCalls(fx), [], 'Terminal was never asked to do anything');
});

test('malformed and look-alike origins are refused', async () => {
  const port = server.port;
  for (const origin of ['', 'not a url', `http://127.0.0.1:${port}/`, 'http://127.0.0.1', `https://127.0.0.1:${port}`, `http://127.0.0.1:${port}.evil.example`,
    `http://127.0.0.2:${port}`, `http://[::1]:${port}`, `http://127.0.0.1:${port + 1}`, `http://127.0.0.1:${port}, https://evil.example`, `HTTP://EVIL.EXAMPLE`]) {
    assert.equal((await send('/api/actions', { origin, body: action({ action: 'git.status' }) })).status, 403, JSON.stringify(origin));
  }
});

test("Cockpit's own origin must still send JSON", async () => {
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', 'text/json', null]) {
    assert.equal((await send('/api/actions', { origin: ORIGIN, type, body: action({ action: 'git.status' }) })).status, 415, String(type));
  }
});

test("a JSON request from Cockpit's own page still works, from 127.0.0.1 or localhost", async () => {
  for (const [origin, type] of [[ORIGIN, 'application/json'], [`http://localhost:${server.port}`, 'application/json; charset=utf-8']]) {
    const r = await send('/api/actions', { origin, type, body: action({ action: 'git.status' }) });
    assert.equal(r.status, 200, origin);
    assert.equal(JSON.parse(r.body).run.status, 'running');
  }
  assert.equal((await send('/api/runs/run_missing/stop', { origin: ORIGIN })).status, 200, 'body-less POSTs from the UI still work');
  assert.match(JSON.parse((await send('/api/actions', { origin: ORIGIN, body: action({ action: 'npm.run', script: 'x', projectPath: '/' }) })).body).error, /discovered project/, 'the allow-list still applies after admission');
});

test('Host validation is unchanged, and no CORS permission is ever granted', async () => {
  assert.equal((await send('/api/actions', { origin: ORIGIN, host: 'evil.example', body: action({ action: 'git.status' }) })).status, 403);
  const pre = await send('/api/actions', { method: 'OPTIONS', origin: 'https://evil.example', type: null });
  assert.equal(pre.status, 403);
  assert.equal(pre.headers['access-control-allow-origin'], undefined);
  const get = await send('/api/env', { method: 'GET', origin: 'https://evil.example', type: null });
  assert.equal(get.headers['access-control-allow-origin'], undefined);
});
