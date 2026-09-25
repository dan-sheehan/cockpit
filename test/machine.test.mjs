// Real-machine integration: scans the actual ~/.claude, ~/.codex and installed CLIs. Opt-in (npm run test:machine),
// because the default suite must pass on a machine or CI runner without Claude Code or Codex.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const skip = process.env.COCKPIT_MACHINE_TESTS !== '1' && 'real-machine test; run with npm run test:machine';

test('scan of the real machine finds both CLIs, discovers cockpit, and leaks no credentials', { skip }, async () => {
  const { scanEnvironment, COCKPIT_ROOT } = await import('../lib/scan.mjs');
  const env = await scanEnvironment();
  assert.ok(Array.isArray(env.skills));
  assert.ok(Array.isArray(env.projects));
  assert.ok(env.tools.find((t) => t.name === 'claude').version, 'Claude Code installed');
  assert.ok(env.tools.find((t) => t.name === 'codex').version, 'Codex installed');
  assert.ok(env.projects.some((p) => p.path === COCKPIT_ROOT), 'cockpit itself is a discovered project');
  const text = JSON.stringify(env);
  assert.doesNotMatch(text, /sk-[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(text, /auth\.json"?:\s*\{/);
  for (const s of env.skills) { assert.ok(s.name); assert.ok(s.path.endsWith('SKILL.md')); }
});
