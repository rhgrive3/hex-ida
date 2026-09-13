import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifySubjectResult, SUBJECT_RESULT_SCHEMA } from '../../tools/validation/public-benchmark/outcome.mjs';
import { runCase } from '../../tools/validation/public-benchmark/run-case.mjs';
import { captureRunProvenance, runBenchmark } from '../../tools/validation/public-benchmark/run.mjs';
import { formatReport } from '../../tools/validation/public-benchmark/report.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function fakeChild({ stdout = '', stderr = '', code = 0, signal = null, error = null, neverClose = false }) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    if (!neverClose) queueMicrotask(() => {
      if (error) child.emit('error', error);
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit('close', code, signal);
    });
    return child;
  };
}

function git(repo, args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createGitManifestFixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-public-benchmark-runner-'));
  const repo = path.join(parent, 'repo');
  const suiteRoot = path.join(repo, 'benchmarks', 'public', 'runner-fixture');
  fs.mkdirSync(suiteRoot, { recursive: true });
  git(repo, ['init', '--quiet']);

  const binary = Buffer.from('fixture binary');
  const reference = '/* Function: ref @ 0x10 */\nint ref(){return 1;}\n';
  fs.writeFileSync(path.join(suiteRoot, 'sample.bin'), binary);
  fs.writeFileSync(path.join(suiteRoot, 'reference.c'), reference);
  const manifest = {
    schema: 'hex-public-benchmark-manifest/v1',
    suite: 'runner-fixture',
    denominatorFrozen: true,
    reference: { product: 'fixture', version: '1' },
    cases: [{
      id: 'sample',
      binary: 'sample.bin',
      binarySha256: sha256(binary),
      reference: { path: 'reference.c', sha256: sha256(reference) },
    }],
  };
  const manifestFile = path.join(suiteRoot, 'manifest.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(repo, 'source.txt'), 'committed source\n');
  fs.mkdirSync(path.join(repo, 'js'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'js', 'module.js'), 'committed module\n');
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=Benchmark Fixture', '-c', 'user.email=benchmark-fixture@example.invalid', 'commit', '-m', 'fixture']);
  return { parent, repo, manifestFile, suiteRoot, commit: git(repo, ['rev-parse', 'HEAD']) };
}

function payload(state, functions = []) {
  return JSON.stringify({ schema: SUBJECT_RESULT_SCHEMA, state, functions });
}

test('empty subject output replaces stale success with explicit ERROR', { timeout: 5000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-public-run-case-empty-'));
  try {
    for (const [index, stdout, reason] of [[0, '', 'subject-output-empty'], [1, '{}\n', 'subject-result-invalid']]) {
      const out = path.join(dir, `case-${index}.json`);
      fs.writeFileSync(out, payload('PASS', [{ address: '16', state: 'PASS' }]));
      const result = await runCase({ binary: 'unused', out, timeout: 1000, spawnChild: fakeChild({ stdout, code: 0 }) });
      assert.equal(result.row.state, 'ERROR');
      assert.equal(result.row.reason, reason);
      assert.equal(result.exitCode, 1);
      assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).state, 'ERROR');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('abnormal subject exit cannot be hidden by a PASS JSON line', { timeout: 5000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-public-run-case-exit-'));
  const out = path.join(dir, 'case.json');
  try {
    const result = await runCase({
      binary: 'unused',
      out,
      timeout: 1000,
      spawnChild: fakeChild({ stdout: `${payload('PASS')}\n`, code: 17, stderr: 'abnormal exit' }),
    });
    assert.equal(result.row.state, 'ERROR');
    assert.equal(result.row.subjectReportedState, 'PASS');
    assert.equal(result.row.reason, 'subject-exit-status-mismatch:17');
    assert.equal(result.exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('UNSUPPORTED stays explicit and function crashes/timeouts are counted as case failures', { timeout: 5000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-public-run-case-states-'));
  try {
    const unsupported = await runCase({
      binary: 'unused',
      out: path.join(dir, 'unsupported.json'),
      timeout: 1000,
      spawnChild: fakeChild({ stdout: `${payload('UNSUPPORTED')}\n`, code: 2 }),
    });
    assert.equal(unsupported.row.state, 'UNSUPPORTED');
    assert.equal(unsupported.row.subjectExitCode, 2);
    assert.equal(unsupported.exitCode, 0);

    const functions = [{ address: '16', state: 'CRASH' }, { address: '32', state: 'TIMEOUT' }, { address: '48', state: 'UNSUPPORTED' }];
    const classified = classifySubjectResult({ schema: SUBJECT_RESULT_SCHEMA, state: 'PASS', functions });
    assert.equal(classified.state, 'CRASH');
    assert.deepEqual(classified.functionStateCounts, { CRASH: 1, TIMEOUT: 1, UNSUPPORTED: 1 });

    const caseResult = await runCase({
      binary: 'unused',
      out: path.join(dir, 'functions.json'),
      timeout: 1000,
      spawnChild: fakeChild({ stdout: `${payload('PASS', functions)}\n`, code: 0 }),
    });
    assert.equal(caseResult.row.state, 'CRASH');
    assert.equal(caseResult.row.reason, 'function-crash');
    assert.deepEqual(caseResult.row.functionStateCounts, { CRASH: 1, TIMEOUT: 1, UNSUPPORTED: 1 });
    assert.equal(caseResult.exitCode, 1);

    const timeoutOnly = await runCase({
      binary: 'unused',
      out: path.join(dir, 'timeout.json'),
      timeout: 1000,
      spawnChild: fakeChild({ stdout: `${payload('PASS', [{ address: '64', state: 'TIMEOUT' }])}\n`, code: 0 }),
    });
    assert.equal(timeoutOnly.row.state, 'TIMEOUT');
    assert.equal(timeoutOnly.exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner discards stale case output, honors runner failure, and binds JSON/Markdown to source and manifest', () => {
  const fixture = createGitManifestFixture();
  const outputDir = path.join(fixture.repo, 'reports', 'runner-output');
  const resultPath = path.join(outputDir, Buffer.from('sample').toString('hex') + '.json');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(resultPath, payload('PASS', [{ address: '16', state: 'PASS' }]));
  fs.writeFileSync(path.join(fixture.repo, 'source.txt'), 'uncommitted candidate edit\n');

  try {
    const provenance = captureRunProvenance({ repoRoot: fixture.repo, manifestFile: fixture.manifestFile, outputDir });
    assert.equal(provenance.git.sha, fixture.commit);
    assert.equal(provenance.git.dirty, true);
    assert.ok(provenance.git.dirtyEntries.some(entry => entry.includes('source.txt')));
    assert.equal(provenance.manifest.sha256, sha256(fs.readFileSync(fixture.manifestFile)));

    let spawnCount = 0;
    const run = runBenchmark({
      args: ['--manifest', fixture.manifestFile, '--output', outputDir, '--timeout-ms', '1000'],
      cwd: fixture.repo,
      repoRoot: fixture.repo,
      log: () => {},
      spawnRunner: (_command, args) => {
        spawnCount++;
        assert.equal(args[2], resultPath);
        assert.equal(fs.existsSync(resultPath), false, 'old result must be removed before launching a case runner');
        return { status: 7, signal: null, error: null, stderr: 'simulated case-runner failure' };
      },
    });

    assert.equal(spawnCount, 1);
    assert.equal(run.exitCode, 1);
    assert.equal(run.summary.states.ERROR, 1);
    assert.equal(run.summary.results[0].state, 'ERROR');
    assert.equal(run.summary.results[0].runnerExitCode, 7);
    assert.equal(run.summary.provenance.git.sha, fixture.commit);
    assert.equal(run.summary.provenance.git.dirty, true);
    assert.ok(run.summary.provenance.git.dirtyEntries.some(entry => entry.includes('source.txt')));
    assert.ok(!run.summary.provenance.git.dirtyEntries.some(entry => entry.includes('reports/runner-output')));
    assert.equal(run.summary.provenance.manifest.sha256, sha256(fs.readFileSync(fixture.manifestFile)));
    assert.notEqual(run.summary.results[0].state, 'PASS');

    const report = formatReport(run.summary);
    assert.ok(report.includes(`Source commit: ${fixture.commit}`));
    assert.ok(report.includes('Working tree: DIRTY'));
    assert.ok(report.includes(`Manifest SHA-256: ${run.summary.provenance.manifest.sha256}`));
    assert.ok(report.includes('Function states: {}'));

    const nonzeroPassOutput = path.join(fixture.parent, 'nonzero-pass-report');
    const nonzeroPassRun = runBenchmark({
      args: ['--manifest', fixture.manifestFile, '--output', nonzeroPassOutput, '--timeout-ms', '1000'],
      cwd: fixture.repo,
      repoRoot: fixture.repo,
      log: () => {},
      spawnRunner: (_command, args) => {
        fs.mkdirSync(path.dirname(args[2]), { recursive: true });
        fs.writeFileSync(args[2], `${payload('PASS')}\n`);
        return { status: 7, signal: null, error: null, stderr: 'nonzero despite pass row' };
      },
    });
    assert.equal(nonzeroPassRun.summary.results[0].state, 'ERROR');
    assert.equal(nonzeroPassRun.summary.results[0].reason, 'case-runner-nonzero-exit:7');
    assert.equal(nonzeroPassRun.exitCode, 1, 'a PASS artifact cannot mask a failed runner exit');

    const functionFailureOutput = path.join(fixture.parent, 'function-failure-report');
    const functionFailures = [{ address: '16', state: 'CRASH' }, { address: '32', state: 'TIMEOUT' }];
    const functionFailureRun = runBenchmark({
      args: ['--manifest', fixture.manifestFile, '--output', functionFailureOutput, '--timeout-ms', '1000'],
      cwd: fixture.repo,
      repoRoot: fixture.repo,
      log: () => {},
      spawnRunner: (_command, args) => {
        fs.mkdirSync(path.dirname(args[2]), { recursive: true });
        fs.writeFileSync(args[2], `${payload('PASS', functionFailures)}\n`);
        return { status: 1, signal: null, error: null, stderr: 'function-level failures' };
      },
    });
    assert.equal(functionFailureRun.summary.states.CRASH, 1);
    assert.deepEqual(functionFailureRun.summary.functionStates, { CRASH: 1, TIMEOUT: 1 });
    assert.equal(functionFailureRun.summary.results[0].state, 'CRASH');
    assert.equal(functionFailureRun.exitCode, 1, 'function-level crashes and timeouts cannot produce a green suite exit');
    assert.ok(formatReport(functionFailureRun.summary).includes('Function states: {"CRASH":1,"TIMEOUT":1}'));

    const unsupportedOutput = path.join(fixture.parent, 'unsupported-report');
    const unsupportedRun = runBenchmark({
      args: ['--manifest', fixture.manifestFile, '--output', unsupportedOutput, '--timeout-ms', '1000'],
      cwd: fixture.repo,
      repoRoot: fixture.repo,
      log: () => {},
      spawnRunner: (_command, args) => {
        fs.writeFileSync(args[2], `${payload('UNSUPPORTED')}\n`);
        return { status: 0, signal: null, error: null, stderr: '' };
      },
    });
    assert.equal(unsupportedRun.summary.states.UNSUPPORTED, 1);
    assert.equal(unsupportedRun.summary.results[0].state, 'UNSUPPORTED');
    assert.equal(unsupportedRun.exitCode, 1, 'unsupported must remain explicit and cannot produce a green suite exit');
  } finally {
    fs.rmSync(fixture.parent, { recursive: true, force: true });
  }
});

test('report provenance excludes generated output without hiding tracked source beneath output directory', () => {
  const fixture = createGitManifestFixture();
  const outputDir = path.join(fixture.repo, 'js');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'summary.json'), '{}\n');
  fs.writeFileSync(path.join(outputDir, 'module.js'), 'uncommitted source edit\n');
  fs.writeFileSync(path.join(outputDir, 'local-notes.txt'), 'untracked source beside report output\n');
  try {
    const provenance = captureRunProvenance({ repoRoot: fixture.repo, manifestFile: fixture.manifestFile, outputDir });
    assert.equal(provenance.git.sha, fixture.commit);
    assert.equal(provenance.git.dirty, true);
    assert.ok(provenance.git.dirtyEntries.some(entry => entry.endsWith('js/module.js')));
    assert.ok(provenance.git.dirtyEntries.some(entry => entry.endsWith('js/local-notes.txt')));
    assert.ok(!provenance.git.dirtyEntries.some(entry => entry.endsWith('js/summary.json')));
  } finally {
    fs.rmSync(fixture.parent, { recursive: true, force: true });
  }
});
