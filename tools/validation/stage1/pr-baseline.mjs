import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { changedPathsTouchX86Closure } from '../invariant-pr-baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const VERIFY = path.join(ROOT, 'tools/validation/stage1/verify.mjs');
const REPORT = path.join(ROOT, 'reports/stage1/stage1-verdict.json');
const INHERITED_TEST = 'x86-long64-closure-matrix.test.mjs';
const PARTIAL_MARKER = 'No valid witness may remain partial:';
const FAILURE_SUMMARY = `machine-effects: 1 file(s) failed: ${INHERITED_TEST}:exit=1`;
const COVERAGE_TEST = 'tests/stage1/a2-machine-effects-coverage.test.mjs';

function parseExpectedSha(argv) {
  const direct = argv.find((arg) => arg.startsWith('--expect-sha='));
  if (direct) return direct.slice('--expect-sha='.length);
  const index = argv.indexOf('--expect-sha');
  return index >= 0 ? argv[index + 1] : null;
}

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding:'utf8',
    maxBuffer:64 * 1024 * 1024,
    env:process.env,
  });
  if (result.error) throw result.error;
  return Object.freeze({
    status:result.status ?? 1,
    output:`${result.stdout || ''}${result.stderr || ''}`,
  });
}

function publish(output) {
  if (output) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
}

function commandOutput(command) {
  return `${command?.stdoutTail || ''}${command?.stderrTail || ''}`;
}

export function classifyInheritedStage1A2Failure({
  strictStatus,
  report,
  candidateClosureStatus,
  candidateClosureOutput = '',
  baselineClosureStatus,
  baselineClosureOutput = '',
  changedFiles = [],
} = {}) {
  if (strictStatus === 0) return Object.freeze({ eligible:false, reason:'candidate-passed' });
  if (!report || report.verdict !== 'BLOCKED' || !Array.isArray(report.gates)) {
    return Object.freeze({ eligible:false, reason:'stage1-report-missing-or-invalid' });
  }

  const failed = report.gates.filter((gate) => gate?.status !== 'passed');
  if (failed.length !== 1 || failed[0]?.id !== 'A2') {
    return Object.freeze({ eligible:false, reason:'stage1-failure-set-changed' });
  }

  const commands = Array.isArray(failed[0].commands) ? failed[0].commands : [];
  if (commands.length !== 2) return Object.freeze({ eligible:false, reason:'a2-command-set-changed' });
  const effects = commands.find((item) => String(item?.command || '').includes('npm run effects:test'));
  const coverage = commands.find((item) => String(item?.command || '').includes(COVERAGE_TEST));
  if (!effects || !coverage) return Object.freeze({ eligible:false, reason:'a2-command-identity-changed' });
  if (effects.status !== 'failed' || coverage.status !== 'passed') {
    return Object.freeze({ eligible:false, reason:'a2-failure-is-not-effects-only' });
  }

  // Stage1 stores only a bounded tail for each subcommand. Require that bounded
  // evidence to prove the MachineEffects failure set is exactly one file, then
  // prove the precise assertion class independently from exact candidate/base
  // executions below instead of depending on whether that assertion survived
  // tail truncation.
  const effectsOutput = commandOutput(effects);
  if (!effectsOutput.includes(FAILURE_SUMMARY)) {
    return Object.freeze({ eligible:false, reason:'a2-machine-effects-failure-set-changed' });
  }
  if (candidateClosureStatus === 0 || !String(candidateClosureOutput).includes(PARTIAL_MARKER)) {
    return Object.freeze({ eligible:false, reason:'candidate-x86-closure-no-longer-matches' });
  }
  if (baselineClosureStatus === 0 || !String(baselineClosureOutput).includes(PARTIAL_MARKER)) {
    return Object.freeze({ eligible:false, reason:'baseline-x86-closure-no-longer-matches' });
  }
  if (changedPathsTouchX86Closure(changedFiles)) {
    return Object.freeze({ eligible:false, reason:'pr-touches-x86-closure-dependency-surface' });
  }
  return Object.freeze({ eligible:true, reason:'inherited-stage2-a2-x86-closure-failure' });
}

function changedFilesFrom(baseSha) {
  const result = run('git', ['diff', '--name-only', `${baseSha}...HEAD`]);
  if (result.status !== 0) throw new Error(`stage1-baseline-diff-failed:${result.output}`);
  return result.output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function runCurrentX86Closure() {
  return run(process.execPath, [path.join(ROOT, 'tests/machine-effects', INHERITED_TEST)]);
}

function runBaselineX86Closure(baseSha) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-stage1-base-'));
  let added = false;
  try {
    const add = run('git', ['worktree', 'add', '--detach', worktree, baseSha]);
    if (add.status !== 0) throw new Error(`stage1-baseline-worktree-add-failed:${add.output}`);
    added = true;
    const currentNodeModules = path.join(ROOT, 'node_modules');
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

export function main(argv = process.argv.slice(2)) {
  const expectedSha = parseExpectedSha(argv);
  if (!/^[0-9a-f]{40}$/i.test(String(expectedSha || ''))) throw new TypeError('stage1-baseline-expected-sha-invalid');

  const strict = run(process.execPath, [VERIFY, '--expect-sha', expectedSha]);
  publish(strict.output);
  if (strict.status === 0) return 0;
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return strict.status;

  const baseSha = String(process.env.HEX_STAGE1_BASE_SHA || '');
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) throw new TypeError('stage1-baseline-base-sha-invalid');
  if (!fs.existsSync(REPORT)) throw new Error('stage1-baseline-report-missing');
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  if (String(report.gitSha || '').toLowerCase() !== String(expectedSha).toLowerCase()) {
    throw new Error(`stage1-baseline-report-head-mismatch:${report.gitSha || '<missing>'}:${expectedSha}`);
  }

  const candidateClosure = runCurrentX86Closure();
  const baselineClosure = runBaselineX86Closure(baseSha);
  const changedFiles = changedFilesFrom(baseSha);
  const decision = classifyInheritedStage1A2Failure({
    strictStatus:strict.status,
    report,
    candidateClosureStatus:candidateClosure.status,
    candidateClosureOutput:candidateClosure.output,
    baselineClosureStatus:baselineClosure.status,
    baselineClosureOutput:baselineClosure.output,
    changedFiles,
  });

  if (!decision.eligible) {
    process.stderr.write(`[stage1-baseline] candidate failure remains blocking: ${decision.reason}\n`);
    return strict.status;
  }
  process.stdout.write(
    `[stage1-baseline] PASS: A2 is blocked only by the same current-main ${INHERITED_TEST} Stage2 closure gap; this PR does not touch its dependency surface\n`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
