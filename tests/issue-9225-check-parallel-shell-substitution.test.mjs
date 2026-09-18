// #9225: `check:parallel` must preserve the shell semantics of each canonical
// `scripts.check` step. A step such as `"$(git rev-parse HEAD)"` has to receive
// the expanded commit SHA, never the literal `$()` text that argv tokenization
// would otherwise hand to the validator.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCheckParallel } from '../scripts/run-check-parallel.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function platformShell() {
  if (process.platform === 'win32') return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'] };
  return { command: '/bin/sh', args: ['-c'] };
}

// A canonical step that records the argv it actually receives, so the parallel
// path can be compared against the serial npm-shell path byte for byte.
function argvRecorderStep(outFile, substitution) {
  const writer = "require('fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))";
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(writer)} ${JSON.stringify(outFile)} "${substitution}"`;
}

function readRecordedArgv(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function silentSink() {
  return { write() {} };
}

test('#9225 expands command substitutions instead of passing literal $() argv', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9225-'));
  try {
    const parallelFile = path.join(tempRoot, 'parallel.json');
    const serialFile = path.join(tempRoot, 'serial.json');
    const parallelStep = argvRecorderStep(parallelFile, '$(git rev-parse HEAD)');
    const serialStep = argvRecorderStep(serialFile, '$(git rev-parse HEAD)');

    const { results } = await runCheckParallel({
      checkScript: parallelStep,
      stdout: silentSink(),
      stderr: silentSink(),
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true, 'the shell-bearing step must succeed');

    const shell = platformShell();
    const serial = spawnSync(shell.command, [...shell.args, serialStep], { cwd: root, encoding: 'utf8' });
    assert.equal(serial.status, 0, serial.stderr);

    const parallelArgv = readRecordedArgv(parallelFile);
    const serialArgv = readRecordedArgv(serialFile);
    assert.deepEqual(parallelArgv, serialArgv, 'parallel argv must match canonical shell expansion');
    assert.match(parallelArgv[0], /^[a-f0-9]{40}$/, 'the real HEAD SHA must reach the command');
    assert.notEqual(parallelArgv[0], '$(git rev-parse HEAD)', 'literal substitution text must never be passed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('#9225 keeps a quoted substitution with whitespace as one expanded argv value', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-issue-9225-split-'));
  try {
    const parallelFile = path.join(tempRoot, 'parallel.json');
    const serialFile = path.join(tempRoot, 'serial.json');
    const parallelStep = argvRecorderStep(parallelFile, "$(printf 'a b')");
    const serialStep = argvRecorderStep(serialFile, "$(printf 'a b')");

    await runCheckParallel({ checkScript: parallelStep, stdout: silentSink(), stderr: silentSink() });

    const shell = platformShell();
    const serial = spawnSync(shell.command, [...shell.args, serialStep], { cwd: root, encoding: 'utf8' });
    assert.equal(serial.status, 0, serial.stderr);

    const parallelArgv = readRecordedArgv(parallelFile);
    assert.deepEqual(parallelArgv, readRecordedArgv(serialFile));
    assert.deepEqual(parallelArgv, ['a b'], 'a quoted substitution must stay a single argv value');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('#9225 still executes plain argv-only steps through the quiet wrapper', async () => {
  const { results } = await runCheckParallel({
    checkScript: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    stdout: silentSink(),
    stderr: silentSink(),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].status, 0);
  assert.equal(results[0].logPath, null);
});
