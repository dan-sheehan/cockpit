// Collaboration workflow: Claude = lead engineer and only writer. Codex = independent read-only reviewer.
// Hard limits: max 2 Codex review rounds, max 1 retry per failed stage, no recursion, no open-ended chat.
import fs from 'node:fs/promises';
import path from 'node:path';
import { SESSIONS_DIR, saveSoon, saveNow, newId, listAll, load } from './store.mjs';
import { bus, startRun, waitForRun, runText, stopRun, activeRuns, publicRun } from './runs.mjs';
import { startClaude, parseClaudeOutput, buildClaudeArgs } from './adapters/claude.mjs';
import { startCodexReview, parseCodexOutput, buildCodexArgs } from './adapters/codex.mjs';
import { tildify, coversPath, realPathWithin } from './homes.mjs';
import { treeSnapshot, diffSince, gitSummary } from './git.mjs';
import { redactText, redactObject } from './redact.mjs';

const live = new Map();
const MAX_REVIEW_ROUNDS = 2;
const MAX_RETRIES = 1;
const IMPLEMENT_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(npm test*)', 'Bash(npm run *)', 'Bash(node *)', 'Bash(ls*)', 'Bash(cat *)', 'Bash(python3 *)'];
const DISPOSITION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { summary: { type: 'string' }, dispositions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    findingId: { type: 'string' }, disposition: { type: 'string', enum: ['ACCEPTED', 'PARTIALLY ACCEPTED', 'REJECTED', 'DEFERRED'] }, reason: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } },
  }, required: ['findingId', 'disposition', 'reason', 'filesChanged'] } } }, required: ['summary', 'dispositions'],
};

function stageDef(id, name, participant, opts = {}) { return { id, name, participant, status: 'queued', startedAt: null, endedAt: null, runId: null, retries: 0, error: null, summary: null, detail: {}, ...opts }; }
function plan() {
  return [
    stageDef('context', 'Context assembly', 'cockpit'),
    stageDef('investigate', 'Investigate (read-only)', 'claude'),
    stageDef('implement', 'Implement', 'claude'),
    stageDef('diff', 'Capture diff', 'cockpit'),
    stageDef('review-1', 'Codex review · round 1', 'codex'),
    stageDef('disposition-1', 'Claude disposition · round 1', 'claude'),
    stageDef('review-2', 'Codex review · round 2', 'codex', { optional: true }),
    stageDef('disposition-2', 'Claude disposition · round 2', 'claude', { optional: true }),
    stageDef('tests', 'Tests', 'cockpit'),
    stageDef('complete', 'Complete', 'cockpit'),
  ];
}

function emit(s) { saveSoon(SESSIONS_DIR, s.id, () => publicSession(s)); bus.emit("event", { type: "session.update", session: publicSession(s) }); }
function log(s, msg, level = 'info') { s.events.push({ t: new Date().toISOString(), level, msg }); emit(s); }
function stage(s, id) { return s.stages.find((x) => x.id === id); }
function begin(s, id) { const st = stage(s, id); st.status = 'running'; st.startedAt = new Date().toISOString(); st.error = null; s.currentStage = id; s.status = 'running'; emit(s); return st; }
function done(s, id, summary, detail = {}) { const st = stage(s, id); st.status = 'complete'; st.endedAt = new Date().toISOString(); st.summary = summary; st.detail = { ...st.detail, ...detail }; emit(s); }
function skip(s, id, reason) { const st = stage(s, id); st.status = 'skipped'; st.summary = reason; st.endedAt = new Date().toISOString(); emit(s); }
class StageError extends Error { constructor(stageId, msg, detail) { super(msg); this.stageId = stageId; this.detail = detail; } }
function checkCancel(s) { if (s.status === 'cancelled') throw new StageError(s.currentStage, 'cancelled'); }

export async function createSession({ task, projectPath, claudeModel, codexModel, budgetUsd = 3, env }) {
  if (!task?.trim()) throw new Error('task required');
  const project = env.projects.find((p) => p.path === projectPath);
  if (!project) throw new Error('unknown project (must be a discovered local project)');
  const s = {
    id: newId('ses'), kind: 'collaboration', task: task.trim(), project: { path: project.path, name: project.name, branch: project.git.branch || null, isRepo: !!project.git.isRepo },
    participants: {
      claude: { role: 'lead engineer · only writer', model: claudeModel || null, permissionModes: { investigate: 'plan', implement: 'acceptEdits', disposition: 'acceptEdits' }, budgetUsdPerStage: budgetUsd },
      codex: { role: 'independent reviewer · read-only', model: codexModel || null, sandbox: 'read-only', flags: ['--sandbox read-only', '--ephemeral', '--json'] },
      cockpit: { role: 'orchestrator · context, diff, tests, persistence' },
    },
    limits: { maxReviewRounds: MAX_REVIEW_ROUNDS, maxRetriesPerStage: MAX_RETRIES, recursion: 'forbidden' },
    status: 'queued', createdAt: new Date().toISOString(), startedAt: null, endedAt: null, currentStage: null, failedStage: null,
    stages: plan(), context: null, artifacts: { investigation: null, implementation: null, diffs: [], reviews: [], dispositions: [], tests: null }, findings: [], claudeSessionId: null, events: [], result: null,
  };
  live.set(s.id, s);
  await saveNow(SESSIONS_DIR, s.id, s);
  log(s, `session created for ${project.name}`);
  runFrom(s, 0, env).catch(() => {});
  return s;
}

async function runFrom(s, fromIndex, env) {
  s.startedAt ||= new Date().toISOString();
  s.status = 'running'; s.failedStage = null; emit(s);
  try {
    for (let i = fromIndex; i < s.stages.length; i++) {
      checkCancel(s);
      const st = s.stages[i];
      if (st.status === 'complete' || st.status === 'skipped') continue;
      await STAGES[st.id.replace(/-\d$/, '')](s, st.id, env);
    }
    s.status = 'complete'; s.endedAt = new Date().toISOString(); s.currentStage = null;
    log(s, 'session complete');
  } catch (e) {
    const stageId = e.stageId || s.currentStage;
    const st = stage(s, stageId);
    if (s.status === 'cancelled') { if (st) { st.status = 'cancelled'; st.endedAt = new Date().toISOString(); } s.endedAt = new Date().toISOString(); log(s, `cancelled during ${stageId}`, 'warn'); }
    else { if (st) { st.status = 'failed'; st.error = e.message; st.endedAt = new Date().toISOString(); st.detail = { ...st.detail, ...(e.detail || {}) }; } s.status = 'failed'; s.failedStage = stageId; s.endedAt = new Date().toISOString(); log(s, `FAILED at ${stageId}: ${e.message}`, 'error'); }
  }
  await saveNow(SESSIONS_DIR, s.id, s);
  bus.emit('event', { type: 'session.update', session: s });
}

const STAGES = {
  async context(s, id, env) {
    begin(s, id);
    const p = env.projects.find((x) => x.path === s.project.path);
    const git = await gitSummary(p.path);
    const snapshot = git.isRepo ? await treeSnapshot(p.path) : null;
    const testCmd = p.scripts?.test ? 'npm test' : null;
    const globalInstr = env.instructions.filter((i) => i.scope.startsWith('GLOBAL') && i.exists);
    const projInstr = env.instructions.filter((i) => i.project === p.path);
    s.context = {
      assembledAt: new Date().toISOString(),
      task: { value: s.task, evidence: 'OBSERVED', source: 'User (Cockpit form)' },
      workingDirectory: { value: p.path, evidence: 'OBSERVED' },
      writableProject: { value: p.path, evidence: 'OBSERVED', note: 'Only Claude writes here. Codex runs with --sandbox read-only.' },
      git: { value: { branch: git.branch, dirtyBefore: git.dirty, changedBefore: git.changedCount, head: snapshot?.head || null, baseline: snapshot?.stashRef ? 'stash-create snapshot of pre-task tree' : 'HEAD' }, evidence: 'OBSERVED' },
      projectInstructions: { value: projInstr.map((i) => ({ path: i.path, kind: i.kind, provider: i.provider, chars: i.size, includes: i.includes })), evidence: projInstr.length ? 'OBSERVED' : 'OBSERVED (none found)' },
      globalInstructions: { value: globalInstr.map((i) => ({ path: i.path, kind: i.kind, provider: i.provider, chars: i.size })), evidence: 'OBSERVED' },
      memoryFiles: { value: env.instructions.filter((i) => i.scope === 'MEMORY' && i.path.includes('/' + p.path.replace(/[\/.]/g, '-') + '/')).map((i) => i.path), evidence: `OBSERVED (${tildify(env.claude.home)}/projects/<project>/memory)`, note: 'Claude Code auto-loads MEMORY.md for this project at session start.' },
      skillsAvailable: { value: env.skills.filter((k) => k.provider === 'claude' && (k.scope === 'GLOBAL' || k.projectPath === p.path)).map((k) => k.name), evidence: 'OBSERVED (on disk)', note: 'Which skills Claude actually loads is reported by its init event once the run starts.' },
      hooks: { value: env.hooks.filter((h) => !h.project || h.project === p.path), evidence: 'OBSERVED' },
      mcp: { value: env.mcp.filter((m) => !m.project || m.project === p.path).map((m) => m.name), evidence: 'OBSERVED' },
      testCommand: { value: testCmd, evidence: testCmd ? 'OBSERVED (package.json scripts.test)' : 'UNAVAILABLE (no test script detected)' },
      stack: { value: p.stack, evidence: 'INFERRED (from files present)' },
      claudeCli: { value: `claude ${buildClaudeArgs({ prompt: '<prompt>', mode: 'plan', model: s.participants.claude.model, maxBudgetUsd: s.participants.claude.budgetUsdPerStage }).join(' ')}`, evidence: 'OBSERVED (constructed by Cockpit)' },
      codexCli: { value: `codex ${buildCodexArgs({ cwd: p.path, schemaFile: '<schema.json>', lastMessageFile: '<last.json>', model: s.participants.codex.model }).join(' ')}`, evidence: 'OBSERVED (constructed by Cockpit)' },
      modelReasoning: { value: null, evidence: 'UNAVAILABLE', note: 'Hidden model reasoning is not observable. Cockpit shows tool calls, text and results only.' },
      claudeSettings: { value: env.claude.settings, evidence: `OBSERVED (${tildify(env.claude.home)}/settings.json)` },
    };
    s._snapshot = snapshot; s._testCmd = testCmd; s._project = p;
    done(s, id, `${projInstr.length} project instruction file(s), ${globalInstr.length} global, test command ${testCmd || 'unavailable'}`);
  },

  async investigate(s, id) {
    const st = begin(s, id);
    const p = s._project;
    const instrNote = s.context.projectInstructions.value.map((i) => i.path).join(', ') || 'none';
    const prompt = `You are the lead engineer on this task inside Cockpit, a local orchestration tool. This stage is READ-ONLY investigation (plan mode). Do not edit files.\n\nTASK:\n${s.task}\n\nProject instructions on disk: ${instrNote}.\n\nInvestigate the codebase enough to implement the task well. Then report, in under 350 words:\n1. Relevant files (paths)\n2. Exactly what you will change\n3. Risks / assumptions\n4. How you will verify (test command: ${s._testCmd || 'none detected'})\nDo not ask questions; make reasonable assumptions and state them.`;
    const run = startClaude({ prompt, mode: 'plan', model: s.participants.claude.model, maxBudgetUsd: s.participants.claude.budgetUsdPerStage, cwd: p.path, sessionId: s.id, stageId: id, label: 'claude -p (plan) · investigate' });
    st.runId = run.id; st.detail = { command: ['claude', run.args[0], '<prompt>', ...run.args.slice(2)].join(' '), promptChars: prompt.length, prompt }; emit(s);
    await waitForRun(run); checkCancel(s);
    const parsed = parseClaudeOutput(run);
    if (run.status !== 'complete' || parsed.isError) throw new StageError(id, `claude exited ${run.exitCode}${parsed.result ? ': ' + String(parsed.result).slice(0, 300) : ''}`, { stderr: runText(run).split('\n').filter((l) => !l.startsWith('{')).join('\n').slice(-2000) });
    s.claudeSessionId = parsed.sessionId;
    s.artifacts.investigation = { text: parsed.result, toolCalls: parsed.toolCalls, costUsd: parsed.costUsd, durationMs: parsed.durationMs, model: parsed.model, sessionId: parsed.sessionId };
    s.context.modelObserved = { value: parsed.model, evidence: 'OBSERVED (claude init event)' };
    s.context.skillsLoaded = { value: parsed.skills?.length ? parsed.skills : parsed.slashCommands, evidence: 'OBSERVED (claude init event)' };
    s.context.toolsAvailable = { value: parsed.tools, evidence: 'OBSERVED (claude init event)' };
    done(s, id, `${parsed.toolCalls} tool calls · ${parsed.numTurns} turns · $${(parsed.costUsd || 0).toFixed(3)}`, { model: parsed.model, sessionId: parsed.sessionId, costUsd: parsed.costUsd });
  },

  async implement(s, id) {
    const st = begin(s, id);
    const p = s._project;
    const prompt = `Now IMPLEMENT the task you investigated. You are the only writer in this workspace. Stay strictly within the task's scope; do not refactor unrelated code. Do not commit. ${s._testCmd ? `Run \`${s._testCmd}\` before finishing and fix failures you caused.` : 'No test command was detected; verify by reading your changes carefully.'}\nFinish with a concise summary (under 200 words) of what you changed and why, listing changed files.`;
    const run = startClaude({ prompt, mode: 'acceptEdits', resume: s.claudeSessionId, allowedTools: IMPLEMENT_TOOLS, model: s.participants.claude.model, maxBudgetUsd: s.participants.claude.budgetUsdPerStage * 2, cwd: p.path, sessionId: s.id, stageId: id, label: 'claude -p (acceptEdits) · implement' });
    st.runId = run.id; st.detail = { command: ['claude', run.args[0], '<prompt>', ...run.args.slice(2)].join(' '), allowedTools: IMPLEMENT_TOOLS, promptChars: prompt.length, prompt }; emit(s);
    await waitForRun(run); checkCancel(s);
    const parsed = parseClaudeOutput(run);
    if (run.status !== 'complete' || parsed.isError) throw new StageError(id, `claude exited ${run.exitCode}${parsed.result ? ': ' + String(parsed.result).slice(0, 300) : ''}`);
    s.claudeSessionId = parsed.sessionId || s.claudeSessionId;
    s.artifacts.implementation = { text: parsed.result, toolCalls: parsed.toolCalls, filesTouched: parsed.filesTouched, costUsd: parsed.costUsd, durationMs: parsed.durationMs };
    done(s, id, `${parsed.filesTouched.length} file(s) edited · ${parsed.toolCalls} tool calls · $${(parsed.costUsd || 0).toFixed(3)}`, { filesTouched: parsed.filesTouched, costUsd: parsed.costUsd });
  },

  async diff(s, id) {
    begin(s, id);
    const d = await captureDiff(s, 'after implement');
    done(s, id, d ? `${d.changed.length + d.untracked.length} path(s) changed` : 'not a git repo — diff unavailable');
  },

  async review(s, id) {
    const round = Number(id.split('-')[1]);
    const lastDiff = s.artifacts.diffs[s.artifacts.diffs.length - 1];
    if (round > 1) {
      const prev = s.artifacts.dispositions[round - 2];
      const changedAfterAccept = prev?.dispositions?.some((d) => /ACCEPTED/.test(d.disposition) && d.filesChanged?.length);
      if (!changedAfterAccept) return skip(s, id, prev?.noMaterialFindings ? 'round 1 had no material findings' : 'no accepted findings produced changes in round 1');
      await captureDiff(s, 'after disposition round 1');
    }
    const st = begin(s, id);
    const p = s._project;
    const diff = s.artifacts.diffs[s.artifacts.diffs.length - 1];
    const instr = await reviewInstructionTexts(p.path, s.context.projectInstructions.value);
    const diffText = reviewDiffText(diff);
    const prompt = `You are Codex, an INDEPENDENT READ-ONLY reviewer inside Cockpit. Another agent (Claude) implemented the task below. Your sandbox is read-only: do not attempt to modify, create or delete files. You may run read-only commands (cat, ls, git diff, grep, tests if they do not write).\n\nORIGINAL TASK:\n${s.task}\n\nCLAUDE'S INVESTIGATION PLAN:\n${(s.artifacts.investigation?.text || '').slice(0, 4000)}\n\nCLAUDE'S IMPLEMENTATION SUMMARY:\n${(s.artifacts.implementation?.text || '').slice(0, 4000)}\n${round > 1 ? `\nPREVIOUS ROUND DISPOSITIONS:\n${JSON.stringify(s.artifacts.dispositions[round - 2]?.dispositions || [], null, 1).slice(0, 4000)}\n` : ''}\nPROJECT INSTRUCTIONS:\n${instr.join('\n') || '(none)'}\n\nCHANGED FILES:\n${diff ? [...diff.changed.map((c) => `${c.status}\t${c.path}`), ...diff.untracked.map((u) => `??\t${u}`)].join('\n') : '(unknown)'}\n\nDIFF (vs pre-task baseline):\n${diffText}\n\nReview seriously for: bugs, bad assumptions, security problems, missing edge cases, architecture mistakes, unnecessary complexity, scope violations, incorrect implementation, mismatch between request and result. Only report MATERIAL findings with concrete evidence (file + line). If there are none, set noMaterialFindings=true and findings=[] — do not manufacture findings. Use ids F1, F2, ... Respond only with the JSON object required by the output schema.`;
    const { run, lastMessageFile } = await startCodexReview({ cwd: p.path, prompt, sessionId: s.id, stageId: id, model: s.participants.codex.model, label: `codex exec --sandbox read-only · review ${round}` });
    st.runId = run.id; st.detail = { command: ['codex', ...run.args].join(' '), promptChars: prompt.length, sandbox: 'read-only', prompt: prompt.length > 60000 ? prompt.slice(0, 60000) + '\n…[prompt truncated in session record; full diff is in the diff tab]' : prompt }; emit(s);
    await waitForRun(run); checkCancel(s);
    const parsed = await parseCodexOutput(run, lastMessageFile);
    if (run.status !== 'complete') throw new StageError(id, `codex exited ${run.exitCode}: ${runText(run).split('\n').filter((l) => !l.startsWith('{')).join(' ').slice(-400)}`);
    if (!parsed.review) throw new StageError(id, parsed.parseError || 'no review JSON returned', { rawText: parsed.rawText });
    const review = { round, threadId: parsed.threadId, noMaterialFindings: !!parsed.review.noMaterialFindings, summary: parsed.review.summary, findings: parsed.review.findings || [], commandsRun: parsed.commands, usage: parsed.usage, sandboxViolations: parsed.sandboxViolations, readOnlyVerified: { sandboxFlag: true, writeCommandsObserved: parsed.commands.filter((c) => /\b(>|>>|tee|rm |mv |cp |sed -i|git (commit|checkout|reset|apply|stash|add))\b/.test(c.command)).length } };
    s.artifacts.reviews.push(review);
    for (const f of review.findings) s.findings.push({ ...f, round, raisedBy: 'codex', disposition: null });
    done(s, id, review.noMaterialFindings || !review.findings.length ? 'No material findings.' : `${review.findings.length} finding(s) · ${parsed.commands.length} read-only command(s)`, { findingCount: review.findings.length, commandsRun: parsed.commands.length, sandboxViolations: parsed.sandboxViolations });
  },

  async disposition(s, id) {
    const round = Number(id.split('-')[1]);
    const review = s.artifacts.reviews.find((r) => r.round === round);
    if (!review) return skip(s, id, 'no review this round');
    if (review.noMaterialFindings || !review.findings.length) return skip(s, id, 'Codex reported no material findings');
    const st = begin(s, id);
    const p = s._project;
    const prompt = `Codex (an independent read-only reviewer) reviewed your implementation and returned these findings:\n\n${JSON.stringify(review.findings, null, 1)}\n\nFor EACH finding decide exactly one disposition: ACCEPTED, PARTIALLY ACCEPTED, REJECTED, or DEFERRED, with a specific reason grounded in the code. Do not debate; decide. Apply the ACCEPTED and PARTIALLY ACCEPTED changes now (you are the only writer). Do not make unrelated changes. ${s._testCmd ? `Re-run \`${s._testCmd}\` after changes.` : ''} List the files you changed per finding. Return the structured JSON.`;
    const run = startClaude({ prompt, mode: 'acceptEdits', resume: s.claudeSessionId, allowedTools: IMPLEMENT_TOOLS, jsonSchema: DISPOSITION_SCHEMA, model: s.participants.claude.model, maxBudgetUsd: s.participants.claude.budgetUsdPerStage * 2, cwd: p.path, sessionId: s.id, stageId: id, label: `claude -p (acceptEdits) · disposition ${round}` });
    st.runId = run.id; st.detail = { command: ['claude', run.args[0], '<prompt>', ...run.args.slice(2)].join(' ').replace(/--json-schema \S+/, '--json-schema <schema>'), promptChars: prompt.length, prompt }; emit(s);
    await waitForRun(run); checkCancel(s);
    const parsed = parseClaudeOutput(run);
    if (run.status !== 'complete' || parsed.isError) throw new StageError(id, `claude exited ${run.exitCode}`);
    let structured = parsed.structured;
    if (!structured && parsed.result) { try { structured = JSON.parse(parsed.result); } catch { const m = String(parsed.result).match(/```json\s*([\s\S]*?)```/); if (m) try { structured = JSON.parse(m[1]); } catch {} } }
    if (!structured?.dispositions) throw new StageError(id, 'Claude did not return structured dispositions', { raw: String(parsed.result).slice(0, 3000) });
    const disp = { round, summary: structured.summary, dispositions: structured.dispositions, filesTouched: parsed.filesTouched, costUsd: parsed.costUsd, noMaterialFindings: false };
    s.artifacts.dispositions.push(disp);
    for (const d of disp.dispositions) { const f = s.findings.find((x) => x.id === d.findingId && x.round === round); if (f) f.disposition = { by: 'claude', disposition: d.disposition, reason: d.reason, filesChanged: d.filesChanged || [], at: new Date().toISOString() }; }
    for (const f of s.findings.filter((x) => x.round === round && !x.disposition)) f.disposition = { by: 'cockpit', disposition: 'DEFERRED', reason: 'Claude returned no disposition for this finding; recorded as unresolved.', filesChanged: [], at: new Date().toISOString() };
    const counts = disp.dispositions.reduce((a, d) => { a[d.disposition] = (a[d.disposition] || 0) + 1; return a; }, {});
    done(s, id, Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · '), { counts, filesTouched: parsed.filesTouched, costUsd: parsed.costUsd });
  },

  async tests(s, id) {
    if (!s._testCmd) { s.artifacts.tests = { status: 'unavailable', reason: 'no test script detected in package.json' }; return skip(s, id, 'UNAVAILABLE — no test command detected'); }
    const st = begin(s, id);
    await captureDiff(s, 'final');
    const run = startRun({ kind: 'tests', participant: 'cockpit', label: s._testCmd, cmd: 'npm', args: ['test'], cwd: s._project.path, sessionId: s.id, stageId: id });
    st.runId = run.id; st.detail = { command: s._testCmd }; emit(s);
    await waitForRun(run); checkCancel(s);
    const text = runText(run);
    s.artifacts.tests = { status: run.status === 'complete' ? 'passed' : 'failed', exitCode: run.exitCode, command: s._testCmd, tail: text.slice(-3000), runId: run.id };
    if (run.status !== 'complete') throw new StageError(id, `tests failed (exit ${run.exitCode})`, { tail: text.slice(-1500) });
    done(s, id, `passed (exit 0)`);
  },

  async complete(s, id) {
    begin(s, id);
    if (!s.artifacts.diffs.some((d) => d.label === 'final')) await captureDiff(s, 'final');
    const final = s.artifacts.diffs[s.artifacts.diffs.length - 1];
    const totalCost = [s.artifacts.investigation, s.artifacts.implementation, ...s.artifacts.dispositions].reduce((a, x) => a + (x?.costUsd || 0), 0);
    s.result = { filesChanged: final ? final.changed.length + final.untracked.length : null, findings: s.findings.length, dispositions: s.findings.filter((f) => f.disposition).map((f) => f.disposition.disposition), tests: s.artifacts.tests?.status || 'unavailable', claudeCostUsd: Math.round(totalCost * 1000) / 1000, reviewRounds: s.artifacts.reviews.length };
    done(s, id, `${s.result.filesChanged ?? '?'} path(s) changed · ${s.result.findings} finding(s) · tests ${s.result.tests}`);
  },
};

// The project instruction files quoted in the Codex review prompt, re-read from disk. A path inside the project is read only if it still
// resolves inside the project's real root, so a CLAUDE.md symlinked elsewhere (possibly since the scan) is not pulled in; memory files
// live under the Claude home, not the project, and are read as before. Settings files (.claude/settings*.json) get the same redaction
// the scanner gives them before /api/env, since the prompt leaves the machine and is kept in the session record; prose is quoted as is.
export async function reviewInstructionTexts(projectPath, instructions) {
  const root = await fs.realpath(projectPath).catch(() => path.resolve(projectPath));
  return Promise.all(instructions.map(async (i) => {
    const file = coversPath(projectPath, i.path) ? await realPathWithin(root, i.path) : i.path;
    let text = file ? await fs.readFile(file, 'utf8').catch(() => '') : '';
    if (text && (i.kind === 'settings' || path.extname(i.path) === '.json')) text = redactSettingsText(text);
    return `--- ${i.path}\n${text.slice(0, 6000)}`;
  }));
}
// As the scanner shows settings: parsed, redactObject, pretty-printed. Text that is not valid JSON falls back to redactText.
function redactSettingsText(text) {
  try { return JSON.stringify(redactObject(JSON.parse(text)), null, 2); } catch { return redactText(text); }
}

// A git diff through redactText, the way Cockpit redacts any text it shows. Several redactText rules read a line from its start
// (api_key = …, Authorization: …, a JSON args list spanning lines), which a diff's +/-/space marker would hide, so the markers are
// blanked for a second pass and put back after it. The first pass, on the diff as is, removes private-key blocks: the one rule that can
// remove lines, so line i still matches marker i afterwards.
export function redactDiff(text) {
  const lines = redactText(text).split('\n');
  const markers = lines.map((l) => (/^[+\- ]/.test(l) ? l[0] : ''));
  const out = redactText(lines.map((l, i) => (markers[i] ? ' ' + l.slice(1) : l)).join('\n')).split('\n');
  // Not expected; if a rule ever changes the line count, keep the redaction and lose the markers rather than misplace them.
  return out.length === lines.length ? out.map((l, i) => (markers[i] ? markers[i] + l.slice(1) : l)).join('\n') : out.join('\n');
}

// The diff quoted in the Codex review prompt: a captured diff, already redacted by captureDiff.
export function reviewDiffText(diff) {
  return diff ? diff.diff.slice(0, 120000) : '(no git diff available; inspect the working tree directly)';
}

// The one redaction boundary for session diffs: the stored diff (session file, sessions API, diff tab, report) and the review prompt
// built from it only ever hold the redacted text. Redacted before truncation, so a cut can never leave half a credential unmatched.
export async function captureDiff(s, label) {
  if (!s._snapshot) return null;
  const d = await diffSince(s._project.path, s._snapshot);
  const diff = redactDiff(d.diff);
  const entry = { label, at: new Date().toISOString(), base: d.base, stat: d.stat, changed: d.changed, untracked: d.untracked, diff: diff.slice(0, 400000), truncated: diff.length > 400000 };
  s.artifacts.diffs.push(entry); emit(s);
  return entry;
}

export function cancelSession(id) {
  const s = live.get(id); if (!s || !['running', 'queued'].includes(s.status)) return false;
  s.status = 'cancelled'; emit(s);
  for (const r of activeRuns()) if (r.sessionId === id) stopRun(r.id);
  return true;
}

export async function retrySession(id, env) {
  let s = live.get(id); if (!s) { s = await load(SESSIONS_DIR, id); if (s) live.set(id, s); } if (!s || s.status !== 'failed') return { ok: false, error: 'session not in failed state' };
  const st = stage(s, s.failedStage); if (!st) return { ok: false, error: 'no failed stage' };
  if (st.retries >= MAX_RETRIES) return { ok: false, error: `retry limit reached for ${st.id} (max ${MAX_RETRIES})` };
  st.retries++; st.status = 'queued'; st.error = null;
  if (!s._project) { s._project = env.projects.find((p) => p.path === s.project.path); s._testCmd = s.context?.testCommand?.value || null; s._snapshot = s.context?.git?.value?.head ? { head: s.context.git.value.head, stashRef: null } : null; }
  log(s, `retrying ${st.id} (attempt ${st.retries + 1})`, 'warn');
  runFrom(s, s.stages.indexOf(st), env).catch(() => {});
  return { ok: true };
}

export async function listSessions() { const saved = (await listAll(SESSIONS_DIR)).map((s) => !live.has(s.id) && ['running', 'queued'].includes(s.status) ? { ...s, status: 'interrupted', stages: s.stages.map((st) => st.status === 'running' ? { ...st, status: 'interrupted' } : st) } : s); const map = new Map(saved.map((s) => [s.id, s])); for (const s of live.values()) map.set(s.id, s); return [...map.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicSession); }
export async function getSession(id) { return publicSession(live.get(id) || (await load(SESSIONS_DIR, id))); }
export function publicSession(s) { if (!s) return null; const { _snapshot, _testCmd, _project, ...rest } = s; return rest; }
export function markInterruptedOnShutdown() { for (const s of live.values()) if (s.status === 'running' || s.status === 'queued') { s.status = 'interrupted'; s.endedAt = new Date().toISOString(); const st = stage(s, s.currentStage); if (st && st.status === 'running') st.status = 'interrupted'; saveNow(SESSIONS_DIR, s.id, publicSession(s)).catch(() => {}); } }
