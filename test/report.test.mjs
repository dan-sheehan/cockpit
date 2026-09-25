import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionReport } from '../lib/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('report renders every saved session without throwing and carries attribution', async () => {
  const dir = path.join(ROOT, 'data', 'sessions');
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const s = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
    const md = sessionReport(s);
    assert.match(md, /^# Cockpit session /);
    assert.match(md, /## Stages/);
    for (const fnd of s.findings) { assert.ok(md.includes(fnd.title), 'finding title present'); if (fnd.disposition) assert.ok(md.includes(fnd.disposition.disposition), 'disposition present'); }
  }
  // synthetic minimal session
  const md = sessionReport({ id: 'x', task: 't', project: { path: '/p' }, status: 'queued', createdAt: null, participants: { claude: { role: 'r', permissionModes: {} }, codex: { role: 'r', sandbox: 'read-only' }, cockpit: { role: 'r' } }, limits: { maxReviewRounds: 2, maxRetriesPerStage: 1, recursion: 'forbidden' }, stages: [], artifacts: { reviews: [], dispositions: [], diffs: [] }, findings: [], events: [] });
  assert.match(md, /Cockpit session x/);
});
