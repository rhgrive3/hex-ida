import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_OUTPUT_LIMIT = 6000;

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function tailCollector(limit) {
  let value = '';
  return {
    push(chunk) {
      value = `${value}${String(chunk)}`;
      if (value.length > limit) value = value.slice(-limit);
    },
    value() { return value; },
  };
}

function runCommand(command, cwd, outputLimit) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout = tailCollector(outputLimit);
    const stderr = tailCollector(outputLimit);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(Object.freeze({
        command: [command.bin, ...command.args].join(' '),
        durationMs: Date.now() - startedAt,
        stdoutTail: stdout.value(),
        stderrTail: stderr.value(),
        ...result,
      }));
    };
    let child;
    try {
      child = spawn(command.bin, command.args, {
        cwd,
        env: { ...process.env, CI: process.env.CI || '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ status: 'failed', exitCode: null, signal: null, stderrTail: String(error?.stack || error) });
      return;
    }
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      stderr.push(error?.stack || error?.message || String(error));
      finish({ status: 'failed', exitCode: null, signal: null });
    });
    child.once('close', (code, signal) => {
      finish({ status: code === 0 && !signal ? 'passed' : 'failed', exitCode: code, signal: signal || null });
    });
  });
}

export async function runIsolatedGateBatch({
  repositoryRoot,
  headSha,
  gates,
  concurrency = 2,
  outputLimit = DEFAULT_OUTPUT_LIMIT,
}) {
  const root = path.resolve(repositoryRoot);
  if (!Array.isArray(gates) || gates.length === 0) throw new TypeError('stage1-gates-required');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > gates.length) throw new TypeError('stage1-gate-concurrency-invalid');
  if (!/^[0-9a-f]{40}$/i.test(String(headSha || ''))) throw new TypeError('stage1-gate-head-invalid');
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 1) throw new TypeError('stage1-gate-output-limit-invalid');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ida-stage1-gates-'));
  const worktrees = [];
  const results = new Array(gates.length);
  const nodeModules = path.join(root, 'node_modules');

  try {
    // Worktree registration mutates shared git metadata, so prepare them
    // serially. The expensive proof commands run concurrently afterwards.
    for (let index = 0; index < gates.length; index += 1) {
      const gate = gates[index];
      const cwd = path.join(tempRoot, `${String(index).padStart(2, '0')}-${gate.id}`);
      git(root, ['worktree', 'add', '--detach', '--quiet', cwd, headSha]);
      worktrees.push(cwd);
      const worktreeNodeModules = path.join(cwd, 'node_modules');
      if (fs.existsSync(nodeModules)) {
        fs.rmSync(worktreeNodeModules, { recursive: true, force: true });
        fs.symlinkSync(nodeModules, worktreeNodeModules, process.platform === 'win32' ? 'junction' : 'dir');
      }
    }

    let nextIndex = 0;
    async function worker() {
      while (true) {
        const index = nextIndex++;
        if (index >= gates.length) return;
        const gate = gates[index];
        const commandResults = [];
        for (const command of gate.commands) {
          commandResults.push(await runCommand(command, worktrees[index], outputLimit));
        }
        results[index] = Object.freeze({
          id: gate.id,
          name: gate.name,
          status: commandResults.every((result) => result.status === 'passed') ? 'passed' : 'failed',
          evidence: Object.freeze([...gate.evidence]),
          commands: Object.freeze(commandResults),
        });
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, gates.length) }, () => worker()));
    return Object.freeze(results);
  } finally {
    for (const cwd of [...worktrees].reverse()) {
      spawnSync('git', ['worktree', 'remove', '--force', cwd], { cwd: root, encoding: 'utf8' });
    }
    spawnSync('git', ['worktree', 'prune'], { cwd: root, encoding: 'utf8' });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function argValue(name) {
  const prefix = `${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const headSha = argValue('--head');
    const outputPath = argValue('--output');
    const requestedConcurrency = Number(argValue('--concurrency'));
    if (!outputPath) throw new TypeError('stage1-gate-output-required');
    const { stage1GateDefinitions } = await import('./verify.mjs');
    const gates = stage1GateDefinitions();
    const concurrency = Number.isSafeInteger(requestedConcurrency) && requestedConcurrency > 0
      ? Math.min(requestedConcurrency, gates.length)
      : Math.min(2, gates.length);
    const results = await runIsolatedGateBatch({
      repositoryRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
      headSha,
      gates,
      concurrency,
    });
    fs.writeFileSync(outputPath, `${JSON.stringify(results)}\n`);
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}