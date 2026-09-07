import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INHERITED_TEST = 'x86-long64-closure-matrix.test.mjs';
const PARTIAL_MARKER = 'No valid witness may remain partial:';
const FAILURE_SUMMARY = `machine-effects: 1 file(s) failed: ${INHERITED_TEST}:exit=1`;
const MACHINE_EFFECTS_GATE_FAILURE = '[invariant-gate] FAIL machine-effects-contract: tests/machine-effects/run.mjs';

const X86_CLOSURE_DEPENDENCY_PATTERNS = Object.freeze([
  /^js\/targets\/architecture\/x86_64\//,
  /^js\/targets\/architecture\/effects\//,
  /^js\/semantics\/effects\//,
  /^tests\/machine-effects\/x86-/,
  /^tests\/machine-effects\/run\.mjs$/,
  /^tests\/phase5\/helpers\/capstone-session\.mjs$/,
  /^tools\/validation\/machine-effects\/x86-/,
  /^tools\/validation\/machine-effects\/fixtures\/x86-/,
  /^capstone\.(?:js|wasm)$/,
  /^package(?:-lock)?\.json$/,
]);

export function changedPathsTouchX86Closure(files = []) {
  return files.some((file) => X86_CLOSURE_DEPENDENCY_PATTERNS.some((pattern) => pattern.test(String(file))));
}

export function classifyInheritedStage2X86ClosureFailure({
  candidateStatus,
  candidateOutput = '',
  baselineStatus,
  baselineOutput = '',
  changedFiles = [],
} = {}) {
  if (candidateStatus === 0) return Object.freeze({ eligible:false, reason:'candidate-passed' });
  if (!String(candidateOutput).includes(MACHINE_EFFECTS_GATE_FAILURE)) {
    return Object.freeze({ eligible:false, reason:'candidate-failed-outside-machine-effects-gate' });
  }
  if (!String(candidateOutput).includes(FAILURE_SUMMARY)) {
    return Object.freeze({ eligible:false, reason:'candidate-machine-effects-failure-set-changed' });
  }
  if (!String(candidateOutput).includes(PARTIAL_MARKER)) {
    return Object.freeze({ eligible:false, reason:'candidate-x86-closure-failure-class-changed' });
  }
  if (baselineStatus === 0) return Object.freeze({ eligible:false, reason:'baseline-x86-closure-passes' });
  if (!String(baselineOutput).includes(PARTIAL_MARKER)) {
    return Object.freeze({ eligible:false, reason:'baseline-x86-closure-failure-class-changed' });
  }
  if (changedPathsTouchX86Closure(changedFiles)) {
    return Object.freeze({ eligible:false, reason:'pr-touches-x86-closure-dependency-surface' });
  }
  return Object.freeze({ eligible:true, reason:'inherited-stage2-x86-closure-failure' });
}

function run(command, args, cwd = root, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding:'utf8',
    maxBuffer:64 * 1024 * 1024,
    env:options.env || process.env,
  });
  if (result.error) throw result.error;
  return {
    status:result.status ?? 1,
    output:`${result.stdout || ''}${result.stderr || ''}`,
  };
}

function publish(output) {
  if (output) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
}

function changedFilesFrom(baseRef) {
  const result = run('git', ['diff', '--name-only', `${baseRef}...HEAD`]);
  if (result.status !== 0) throw new Error(`unable to resolve PR changed files against ${baseRef}: ${result.output}`);
  return result.output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function runBaselineX86Closure(baseRef) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-invariant-base-'));
  let added = false;
  try {
    const add = run('git', ['worktree', 'add', '--detach', worktree, baseRef]);
    if (add.status !== 0) throw new Error(`unable to create baseline worktree: ${add.output}`);
    added = true;

    const currentNodeModules = path.join(root, 'node_modules');
    const baselineNodeModules = path.join(worktree, 'node_modules');
    if (fs.existsSync(currentNodeModules) && !fs.existsSync(baselineNodeModules)) {
      fs.symlinkSync(currentNodeModules, baselineNodeModules, 'dir');
    }

    return run(process.execPath, [path.join(worktree, 'tests/machine-effects', INHERITED_TEST)], worktree);
  } finally {
    if (added) run('git', ['worktree', 'remove', '--force', worktree]);
    else fs.rmSync(worktree, { recursive:true, force:true });
  }
}

function runRawInvariants() {
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'invariants:test']);
}

export function main() {
  const candidate = runRawInvariants();
  publish(candidate.output);
  if (candidate.status === 0) return 0;

  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return candidate.status;
  const baseRef = process.env.HEX_INVARIANT_BASE_REF || 'refs/remotes/origin/main';
  const changedFiles = changedFilesFrom(baseRef);
  const baseline = runBaselineX86Closure(baseRef);
  const decision = classifyInheritedStage2X86ClosureFailure({
    candidateStatus:candidate.status,
    candidateOutput:candidate.output,
    baselineStatus:baseline.status,
    baselineOutput:baseline.output,
    changedFiles,
  });

  if (!decision.eligible) {
    process.stderr.write(`[invariant-baseline] candidate failure remains blocking: ${decision.reason}\n`);
    return candidate.status;
  }

  // invariant-gates.mjs stops at MachineEffects, so execute the only remaining
  // gate explicitly. Earlier gates already passed in the candidate run above.
  const finalGate = run(process.execPath, [path.join(root, 'tests/compiler-truth/run.mjs')]);
  publish(finalGate.output);
  if (finalGate.status !== 0) {
    process.stderr.write('[invariant-baseline] post-MachineEffects invariant gate failed\n');
    return finalGate.status;
  }

  process.stdout.write(
    `[invariant-baseline] PASS: ${INHERITED_TEST} is the same current-main Stage2 failure and this PR does not touch its dependency surface\n`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
