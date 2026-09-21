#!/usr/bin/env node

// Parallel runner for the canonical `npm run check` step list.
//
// Contract:
// - Runs EVERY step from package.json `scripts.check`, always. No step is
//   skipped, filtered, or weakened. A failure in one step never stops the
//   others; the final exit code fails closed if ANY step failed.
// - Wall-clock only change. Each step runs exactly the same command with the
//   same quiet-output wrapper as the serial gate.
// - Canonical steps are npm script text, so they carry shell semantics. Each
//   step is executed verbatim by the platform shell (with npm's
//   node_modules/.bin PATH entry) instead of being reinterpreted as literal
//   argv. Command substitution, quoting, pipelines, and redirection therefore
//   behave exactly as they do under `npm run check`.
// - CPU-time-sensitive / explicitly exclusive steps run as canonical-position
//   barriers: prior pool work drains, the step runs alone, then later work starts.
//   `benchmark:baseline` remains an exclusive tail because it is canonically last.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runQuietCommand } from './run-quiet-command.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUSIVE_PATTERN = /^(npm run benchmark:baseline|npm run phase7:test)$/;

export function requiresSerialShellFallback(checkScript) {
  const str = String(checkScript);
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escaped = false;
  let inComment = false;
  let token = '';
  let complex = false;
  const reserved = new Set(['if', 'then', 'elif', 'else', 'fi', 'case', 'in', 'esac', 'for', 'while', 'until', 'do', 'done']);
  const flushToken = () => {
    if (reserved.has(token)) complex = true;
    token = '';
  };
  const isCommentBoundary = (index) => {
    if (index === 0) return true;
    const prev = str[index - 1];
    return /[\s;&|(){}<>]/.test(prev);
  };

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inComment) {
      if (ch === '\n') {
        inComment = false;
        flushToken();
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      if (!inSingle && !inDouble && !inBacktick && /[A-Za-z0-9_:-]/.test(ch)) token += ch;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === '`' && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      continue;
    }
    if (inSingle || inDouble || inBacktick) continue;

    if (ch === '#' && isCommentBoundary(i)) {
      flushToken();
      complex = true;
      inComment = true;
      continue;
    }
    if (ch === '$' && str[i + 1] === '{') {
      flushToken();
      complex = true;
      i++;
      continue;
    }
    if (ch === '<' && str[i + 1] === '<') {
      flushToken();
      complex = true;
      i++;
      continue;
    }
    if (ch === '!'
        && (i === 0 || /[\s;&|(){}<>]/.test(str[i - 1]))
        && (i + 1 >= str.length || /[\s;&|(){}<>]/.test(str[i + 1]))) {
      flushToken();
      complex = true;
      continue;
    }
    if ((ch === '{' || ch === '}') && (i === 0 || /[\s;|&()]/.test(str[i - 1] ?? ''))
        && (i + 1 >= str.length || /[\s;|&()]/.test(str[i + 1] ?? ''))) {
      flushToken();
      complex = true;
      continue;
    }
    if (/[A-Za-z0-9_:-]/.test(ch)) {
      token += ch;
      continue;
    }
    flushToken();
  }
  flushToken();
  return complex;
}

export function parseCheckSteps(checkScript) {
  const steps = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escaped = false;
  const commandSubstitutions = [];
  let groupDepth = 0;
  const str = String(checkScript);
  if (requiresSerialShellFallback(str)) {
    const serial = str.trim();
    return serial ? [serial] : [];
  }

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (ch === '`' && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      current += ch;
      continue;
    }
    // An unquoted command substitution is part of the surrounding canonical
    // shell step. Track its balanced parenthesis extent so an internal && is
    // never reinterpreted as a parallel-step boundary. Quoted substitutions
    // are already protected by the quote state above.
    if (!inSingle && !inDouble && !inBacktick && ch === '$' && str[i + 1] === '(') {
      commandSubstitutions.push(1);
      current += '$(';
      i++;
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick && commandSubstitutions.length > 0) {
      const last = commandSubstitutions.length - 1;
      if (ch === '(') {
        commandSubstitutions[last]++;
        current += ch;
        continue;
      }
      if (ch === ')') {
        commandSubstitutions[last]--;
        current += ch;
        if (commandSubstitutions[last] === 0) commandSubstitutions.pop();
        continue;
      }
    }
    if (!inSingle && !inDouble && !inBacktick && commandSubstitutions.length === 0) {
      if (ch === '(') {
        groupDepth++;
        current += ch;
        continue;
      }
      if (ch === ')') {
        if (groupDepth === 0) throw new Error('run-check-parallel: malformed shell syntax in check script (unmatched closing parenthesis)');
        groupDepth--;
        current += ch;
        continue;
      }
    }
    if (!inSingle && !inDouble && !inBacktick && commandSubstitutions.length === 0 && groupDepth === 0 && ch === '&' && str[i + 1] === '&') {
      const step = current.trim();
      if (step) steps.push(step);
      current = '';
      i++; // skip next '&'
      continue;
    }
    current += ch;
  }
  if (escaped || inSingle || inDouble || inBacktick) {
    throw new Error('run-check-parallel: malformed shell syntax in check script (unclosed quote or dangling escape)');
  }
  if (commandSubstitutions.length > 0) {
    throw new Error('run-check-parallel: malformed shell syntax in check script (unclosed command substitution)');
  }
  if (groupDepth > 0) {
    throw new Error('run-check-parallel: malformed shell syntax in check script (unclosed parenthesized group)');
  }
  const last = current.trim();
  if (last) steps.push(last);
  return steps;
}

export function stepLabel(command) {
  const match = /^npm (?:run -s |run )?(\S+)$/.exec(command);
  if (match) return `check:${match[1]}`;
  if (command === 'npm test') return 'check:test';
  return `check:${command.replace(/\s+/g, '-')}`;
}

export function tokenizeCommand(command) {
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let hasToken = false;
  const str = String(command).trim();

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) {
      current += ch;
      escaped = false;
      hasToken = true;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      hasToken = true;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      hasToken = true;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (hasToken || current.length > 0) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (escaped || inSingle || inDouble) {
    throw new Error(`run-check-parallel: malformed shell syntax in command "${command}" (unclosed quote or dangling escape)`);
  }
  if (hasToken || current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

export function splitCommand(command) {
  const [name = '', ...args] = tokenizeCommand(command);
  return { command: name, args };
}

// npm executes scripts with a shell, so a canonical step's semantics include
// shell expansion. Handing the original step text to that same shell preserves
// command substitution and every other shell construct the serial gate sees;
// tokenizing to argv would silently pass `$(...)` as a literal argument.
export function shellInvocation(command, { env = process.env, platform = process.platform } = {}) {
  const configured = String(env.npm_config_script_shell ?? '').trim();
  const shell = configured || (platform === 'win32' ? (env.ComSpec || 'cmd.exe') : '/bin/sh');
  if (platform === 'win32' && /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell)) {
    return { command: shell, args: ['/d', '/s', '/c', command] };
  }
  return { command: shell, args: ['-c', command] };
}

// npm prepends node_modules/.bin to PATH for scripts. Mirror that here so a
// shell-invoked step resolves local binaries exactly like the serial gate.
function shellEnvironment({ env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') return env;
  const binDirectory = path.join(root, 'node_modules', '.bin');
  const pathValue = env.PATH ?? '';
  return { ...env, PATH: pathValue ? `${binDirectory}${path.delimiter}${pathValue}` : binDirectory };
}

function poolSize(stepCount) {
  const override = Number(process.env.HEX_CHECK_PARALLEL);
  const requested = Number.isSafeInteger(override) && override >= 1 ? override : os.availableParallelism();
  return Math.max(1, Math.min(requested, stepCount));
}

async function runPool(jobs, concurrency, onSettled, runCommand = runQuietCommand) {
  const results = new Array(jobs.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= jobs.length) return;
      const job = jobs[index];
      results[index] = await runCommand({ ...job, cwd: root });
      onSettled?.(index, results[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
  return results;
}

export async function runCheckParallel({
  stdout = process.stdout,
  stderr = process.stderr,
  checkScript,
  env = process.env,
  platform = process.platform,
  runCommand = runQuietCommand,
} = {}) {
  const pkg = checkScript !== undefined
    ? null
    : JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const rawScript = checkScript !== undefined ? checkScript : (pkg?.scripts?.check ?? '');
  const steps = parseCheckSteps(rawScript);
  if (steps.length === 0) throw new Error('run-check-parallel: no steps found in scripts.check');

  const jobs = steps.map((command) => ({
    label: stepLabel(command),
    rawCommand: command,
    env: shellEnvironment({ env, platform }),
    ...shellInvocation(command, { env, platform }),
  }));
  function commandFor(job) {
    return job.rawCommand || [job.command, ...job.args].join(' ');
  }

  const results = new Array(jobs.length);
  const started = process.hrtime.bigint();
  const exclusiveCount = jobs.filter((job) => EXCLUSIVE_PATTERN.test(commandFor(job))).length;
  stdout.write(`check:parallel: ${jobs.length} steps, pool=${poolSize(jobs.length)}, exclusive barriers=${exclusiveCount}\n`);

  const reportResult = (job, result) => {
    const line = result.ok
      ? `${job.label}: PASS (${(result.durationMs / 1000).toFixed(1)}s)\n`
      : `${job.label}: FAIL (${(result.durationMs / 1000).toFixed(1)}s)\n`;
    (result.ok ? stdout : stderr).write(line);
  };

  const runPoolIndexes = async (indexes) => {
    if (indexes.length === 0) return;
    const segmentJobs = indexes.map((index) => jobs[index]);
    const settled = await runPool(segmentJobs, poolSize(segmentJobs.length), (segmentIndex, result) => {
      reportResult(segmentJobs[segmentIndex], result);
    }, runCommand);
    indexes.forEach((jobIndex, segmentIndex) => { results[jobIndex] = settled[segmentIndex]; });
  };

  let poolIndexes = [];
  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index];
    if (!EXCLUSIVE_PATTERN.test(commandFor(job))) {
      poolIndexes.push(index);
      continue;
    }
    await runPoolIndexes(poolIndexes);
    poolIndexes = [];
    stdout.write(`check:parallel: exclusive barrier ${job.label}\n`);
    results[index] = await runCommand({ ...job, cwd: root });
    reportResult(job, results[index]);
  }
  await runPoolIndexes(poolIndexes);

  const wallSeconds = (Number(process.hrtime.bigint() - started) / 1e9).toFixed(1);
  const failures = [];
  stderr.write('\n--- check:parallel summary (canonical order) ---\n');
  jobs.forEach((job, index) => {
    const result = results[index];
    const ok = result?.ok === true;
    if (!ok) failures.push({ job, result });
    stderr.write(`${ok ? 'PASS' : 'FAIL'}  ${commandFor(job)}${result ? ` (${(result.durationMs / 1000).toFixed(1)}s)` : ' (missing result)'}\n`);
  });
  stderr.write(`check:parallel: ${jobs.length - failures.length}/${jobs.length} passed, wall ${wallSeconds}s\n`);
  if (failures.length > 0) {
    for (const { job, result } of failures) {
      if (result?.logPath) stderr.write(`Full log for ${job.label}: ${result.logPath}\n`);
    }
    stderr.write('Rerun a failed step with HEX_TEST_OUTPUT=verbose for live full output.\n');
  }
  return { results, failures, wallSeconds };
}

async function main() {
  const { failures } = await runCheckParallel();
  if (failures.length > 0) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
