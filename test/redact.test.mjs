import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactInline, redactArgs, redactObject, safeEnvNames } from '../lib/redact.mjs';

test('redactText hides key-like assignments and known token shapes', () => {
  assert.equal(redactText('api_key = abc123'), 'api_key = <redacted>');
  assert.equal(redactText('OPENAI_API_KEY: "sk-abcdefghijklmnop"'), 'OPENAI_API_KEY: <redacted>');
  assert.match(redactText('token ghp_ABCDEFGHIJKLMNOP1234 in text'), /<redacted>/);
  assert.equal(redactText('model = "gpt-5"'), 'model = "gpt-5"');
});

test('redactText redacts Authorization header credentials but keeps the scheme visible', () => {
  assert.equal(
    redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
    'Authorization: Bearer <redacted>'
  );
  assert.equal(redactText('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: Basic <redacted>');
});

test('redactText fully redacts multi-parameter Digest credentials', () => {
  assert.equal(
    redactText('Authorization: Digest username="alice", nonce="abc", response="secret"'),
    'Authorization: Digest <redacted>'
  );
});

test('redactText fully redacts a credential that partially matches a known token shape', () => {
  assert.equal(
    redactText('Authorization: Bearer sk-abcdefghijklmnop.foo.bar'),
    'Authorization: Bearer <redacted>'
  );
});

test('redactText does not let a missing credential consume the next header line', () => {
  assert.equal(
    redactText('Authorization: Bearer\r\nHost: example.com'),
    'Authorization: Bearer\r\nHost: example.com'
  );
});

test('redactText does not let an empty Authorization header consume the next header line', () => {
  assert.equal(
    redactText('Authorization:\r\nHost: example.com'),
    'Authorization:\r\nHost: example.com'
  );
});

test('redactText leaves an Authorization header embedded in other text untouched rather than corrupting it', () => {
  const line = 'curl -H "Authorization: Bearer opaque-secret" https://example.com';
  assert.equal(redactText(line), line);
});

test('redactObject redacts sensitive keys recursively but keeps structure', () => {
  const out = redactObject({ model: 'x', auth: { token: 'abc', nested: { password: 'p' } }, list: [{ apiKey: 'k' }] });
  assert.deepEqual(out, { model: 'x', auth: { token: '<redacted>', nested: { password: '<redacted>' } }, list: [{ apiKey: '<redacted>' }] });
});

test('safeEnvNames never returns values', () => {
  const names = safeEnvNames({ CLAUDE_FOO: 'secret-value', UNRELATED: 'x', ANTHROPIC_API_KEY: 'sk-123' });
  assert.deepEqual(names.map((n) => n.name), ['ANTHROPIC_API_KEY', 'CLAUDE_FOO']);
  assert.ok(names.every((n) => !('value' in n)));
  assert.equal(names.find((n) => n.name === 'ANTHROPIC_API_KEY').sensitive, true);
});

// All key material below is fake.
test('redactText removes whole private-key blocks, not just the BEGIN line', () => {
  for (const kind of ['OPENSSH ', 'RSA ', 'EC ', 'DSA ', 'ENCRYPTED ', '']) {
    const text = `before\n-----BEGIN ${kind}PRIVATE KEY-----\nMIIFAKEbodyline1\nFAKEbodyline2==\n-----END ${kind}PRIVATE KEY-----\nafter`;
    assert.equal(redactText(text), 'before\n<redacted>\nafter', kind);
  }
  assert.equal(redactText('-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQFAKE\n-----END PGP PRIVATE KEY BLOCK-----'), '<redacted>');
  assert.equal(redactText('x\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnFAKE truncated file'), 'x\n<redacted>', 'a block with no END line is redacted to the end');
  assert.equal(redactText('{"private_key_pem": "-----BEGIN RSA PRIVATE KEY-----\\nMIIFAKE\\n-----END RSA PRIVATE KEY-----\\n"}'), '{"private_key_pem": "<redacted>"}', 'JSON-escaped key');
  assert.equal(redactText('-----BEGIN PUBLIC KEY-----\nMFkwFAKE\n-----END PUBLIC KEY-----'), '-----BEGIN PUBLIC KEY-----\nMFkwFAKE\n-----END PUBLIC KEY-----', 'public keys are not secrets');
});

test('redactText hides npm auth settings and npm tokens', () => {
  assert.equal(redactText('//registry.npmjs.org/:_authToken=fakeOpaqueToken123'), '//registry.npmjs.org/:_authToken=<redacted>');
  assert.equal(redactText('//r.example/:_auth=dXNlcjpwYXNzZmFrZQ=='), '//r.example/:_auth=<redacted>');
  assert.equal(redactText('//r.example/:_password = cGFzc2Zha2U='), '//r.example/:_password = <redacted>');
  assert.equal(redactText('token npm_FakeToken0123456789abcdefghijklmnopq here'), 'token <redacted> here');
  assert.equal(redactText('registry=https://registry.npmjs.org/\nsave-exact=true'), 'registry=https://registry.npmjs.org/\nsave-exact=true');
});

test('redactText hides netrc passwords, single-line and multi-line, but not prose about passwords', () => {
  assert.equal(redactText('machine api.example.com login me password hunter2fake'), 'machine api.example.com login me password <redacted>');
  assert.equal(redactText('default login anon password fake2'), 'default login anon password <redacted>');
  assert.equal(redactText('machine h\n  login me\n  password hunter2fake\n'), 'machine h\n  login me\n  password <redacted>\n');
  for (const prose of ['The password field must be hashed.', 'Reset the password via the admin page', 'passwords are rotated monthly']) assert.equal(redactText(prose), prose);
});

test('redactObject removes private-key blocks and npm tokens from string values', () => {
  const out = redactObject({ env: { DEPLOY_PEM: '-----BEGIN EC PRIVATE KEY-----\nMHcFAKE\n-----END EC PRIVATE KEY-----' }, args: ['--registry-token', 'npm_FakeToken0123456789abcdefghijklmnopq'] });
  assert.deepEqual(out, { env: { DEPLOY_PEM: '<redacted>' }, args: ['--registry-token', '<redacted>'] });
});

test('redactText redacts sensitive JSON key/value pairs and keeps the JSON readable', () => {
  const json = '{\n  "name": "cockpit",\n  "author": "Fake Author",\n  "Authorization": "Bearer secret-value",\n  "password": "secret-value",\n  "api_key": "secret-value",\n  "max_tokens": 4096\n}';
  assert.equal(redactText(json), '{\n  "name": "cockpit",\n  "author": "Fake Author",\n  "Authorization": "<redacted>",\n  "password": "<redacted>",\n  "api_key": "<redacted>",\n  "max_tokens": <redacted>\n}');
  assert.deepEqual(Object.keys(JSON.parse(redactText(json).replace('<redacted>\n', '0\n'))), ['name', 'author', 'Authorization', 'password', 'api_key', 'max_tokens'], 'still parses once the pre-existing numeric line redaction is filled in');
});

test('redactText redacts sensitive pairs inside minified JSON, nested anywhere on the line', () => {
  const min = '{"mcpServers":{"x":{"url":"https://mcp.example.com","headers":{"Authorization":"Bearer opaqueFAKE","X-Api-Key":"opaqueFAKE2"}},"y":{"env":{"GITHUB_TOKEN":"opaqueFAKE3","client_secret":"opaqueFAKE4","cookie":"sid=opaqueFAKE5"}}}}';
  const out = redactText(min);
  for (const raw of ['opaqueFAKE', 'Bearer']) assert.ok(!out.includes(raw), out);
  assert.deepEqual(JSON.parse(out), { mcpServers: { x: { url: 'https://mcp.example.com', headers: { Authorization: '<redacted>', 'X-Api-Key': '<redacted>' } }, y: { env: { GITHUB_TOKEN: '<redacted>', client_secret: '<redacted>', cookie: '<redacted>' } } } });
});

test('redactText leaves ordinary JSON values alone, including values that merely mention secrets', () => {
  const json = '{"model": "opus", "description": "rotate the api_key: monthly", "keywords": ["token", "auth"], "authority": "example.com", "enabled": true}';
  assert.equal(redactText(json), json);
});

test('redactInline redacts credentials mid-command and keeps the command readable', () => {
  assert.equal(
    redactInline('curl -s -H "Authorization: Bearer opaqueFAKE1" -H \'X-Api-Key: opaqueFAKE2\' https://hooks.example.com/notify'),
    'curl -s -H "Authorization: Bearer <redacted>" -H \'X-Api-Key: <redacted>\' https://hooks.example.com/notify');
  assert.equal(redactInline('cd /x && GITHUB_TOKEN=opaqueFAKE3 ./check.sh --api-key opaqueFAKE4 --password="opaque FAKE5" -v'),
    'cd /x && GITHUB_TOKEN=<redacted> ./check.sh --api-key <redacted> --password=<redacted> -v');
  assert.equal(redactInline('notify ghp_FAKEFAKEFAKEFAKE1234'), 'notify <redacted>');
  assert.equal(redactInline('node ~/.claude/hooks/format.mjs --author me'), 'node ~/.claude/hooks/format.mjs --author me', 'ordinary commands are untouched');
});

test('redactText redacts URL query credentials and userinfo passwords but keeps host and path', () => {
  assert.equal(redactText('https://mcp.example.com/sse?api_key=opaqueFAKE&team=core'), 'https://mcp.example.com/sse?api_key=<redacted>&team=core');
  assert.equal(redactText('https://me:opaqueFAKE@mcp.example.com/v1?access_token=opaqueFAKE2'), 'https://me:<redacted>@mcp.example.com/v1?access_token=<redacted>');
  assert.equal(redactText('[mcp_servers.remote]\nurl = "https://mcp.example.com/sse?token=opaqueFAKE"'), '[mcp_servers.remote]\nurl = "https://mcp.example.com/sse?token=<redacted>"', 'config text');
  for (const safe of ['https://mcp.example.com/sse?team=core', 'see https://example.com/docs#token=anchor-only and a&token=notaurl']) assert.equal(redactText(safe), safe);
  assert.equal(redactInline('https://mcp.example.com/sse?api_key=opaqueFAKE&team=core'), 'https://mcp.example.com/sse?api_key=<redacted>&team=core', 'redactInline builds on it');
});

test('redactObject runs command and url values through redactInline (hooks inside settings objects)', () => {
  const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl -H "Authorization: Bearer opaqueFAKE" https://h.example' }, { type: 'http', url: 'https://h.example/x?token=opaqueFAKE2' }] }] }, statusLine: { command: 'echo ok' } };
  assert.deepEqual(redactObject(settings), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl -H "Authorization: Bearer <redacted>" https://h.example' }, { type: 'http', url: 'https://h.example/x?token=<redacted>' }] }] }, statusLine: { command: 'echo ok' } });
});

test('redactText redacts unquoted TOML sensitive keys, in tables and inline tables, and leaves other keys alone', () => {
  const toml = '[mcp_servers.gh.http_headers]\nAuthorization = "Bearer opaqueFAKE1"\nCookie = \'sid=opaqueFAKE2\'\n[mcp_servers.gh]\nhttp_headers = { Authorization = "Bearer opaqueFAKE3", X-Trace = "on" }\nenv = { GITHUB_TOKEN = "opaqueFAKE4", LOG = "debug" }\nauthor = "Fake Author"\nmodel = "gpt-5"';
  assert.equal(redactText(toml), '[mcp_servers.gh.http_headers]\nAuthorization = "<redacted>"\nCookie = "<redacted>"\n[mcp_servers.gh]\nhttp_headers = { Authorization = "<redacted>", X-Trace = "on" }\nenv = { GITHUB_TOKEN = "<redacted>", LOG = "debug" }\nauthor = "Fake Author"\nmodel = "gpt-5"');
});

test('redactText redacts credentials inside quoted-string arrays (TOML and JSON args lists) and nothing else in them', () => {
  assert.equal(
    redactText('args = ["-y", "server", "--api-key", "opaqueFAKE1", "--header", "X-Api-Key: opaqueFAKE2", "--token=opaqueFAKE3", "--verbose"]'),
    'args = ["-y", "server", "--api-key", "<redacted>", "--header", "X-Api-Key: <redacted>", "--token=<redacted>", "--verbose"]');
  const json = '{\n  "args": [\n    "--api-key",\n    "opaqueFAKE4",\n    "--header",\n    "Authorization: Bearer opaqueFAKE5",\n    "API_KEY=opaqueFAKE6"\n  ]\n}';
  assert.deepEqual(JSON.parse(redactText(json)).args, ['--api-key', '<redacted>', '--header', 'Authorization: Bearer <redacted>', 'API_KEY=<redacted>']);
  const plain = '{"files": ["README.md", "--verbose", "token"], "k": ["--port", "8080"]}';
  assert.equal(redactText(plain), plain);
});

test('redactArgs redacts a sensitive flag\'s next element, header elements and inline credentials, element by element', () => {
  assert.deepEqual(
    redactArgs(['-y', 'server', '--api-key', 'opaqueFAKE1', '--header', 'Authorization: Bearer opaqueFAKE2', 'X-Api-Key: opaqueFAKE3', 'API_KEY=opaqueFAKE4', '--token=opaqueFAKE5', 'https://x.example/sse?token=opaqueFAKE6', 'ghp_FAKEFAKEFAKEFAKE1234', '--port', '8080']),
    ['-y', 'server', '--api-key', '<redacted>', '--header', 'Authorization: Bearer <redacted>', 'X-Api-Key: <redacted>', 'API_KEY=<redacted>', '--token=<redacted>', 'https://x.example/sse?token=<redacted>', '<redacted>', '--port', '8080']);
  assert.equal(redactArgs('["--api-key", "opaqueFAKE7"]'), '["--api-key", "<redacted>"]', 'an unparsed TOML list is redacted as text');
});

test('redactObject redacts args arrays inside config objects with redactArgs', () => {
  assert.deepEqual(redactObject({ mcp_servers: { gh: { command: 'npx', args: ['--api-key', 'opaqueFAKE', '--port', '8080'] } } }),
    { mcp_servers: { gh: { command: 'npx', args: ['--api-key', '<redacted>', '--port', '8080'] } } });
});
