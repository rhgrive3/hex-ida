import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { selectProbeCases } from '../../reports/investigations/codefuse-functionality/harness/manifest.mjs';
import { runProbe } from '../../reports/investigations/codefuse-functionality/harness/probe.mjs';
import { failingChild } from './helpers.mjs';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function buildCases() {
  const cases = [];
  for (const compiler of ['clang', 'gcc']) {
    for (const optimization of ['O0', 'O1', 'O2', 'O3', 'Os']) {
      for (const debug of [true, false]) {
        const id = `${compiler}_${optimization}_${debug ? 'g' : 'no_g'}`;
        const binarySha256 = sha256(`binary:${id}`);
        cases.push({
          id,
          binary: `inputs/${id}.bin`,
          binarySha256,
          reference: { path: `reference/${id}.c`, sha256: sha256(`ref:${id}`) },
          architecture: 'arm64',
          compiler,
          optimization,
          debug,
        });
      }
    }
  }
  return cases;
}

test('probe selection is deterministic and covers compilers, optimizations, and debug', () => {
  const cases = buildCases();
  const first = selectProbeCases(cases, 5);
  const shuffled = selectProbeCases([...cases].reverse(), 5);
  assert.equal(first.cases.length, 5);
  assert.deepEqual(first.cases.map((entry) => entry.id), shuffled.cases.map((entry) => entry.id));
  assert.deepEqual(first.coverage.compilers, ['clang', 'gcc']);
  assert.deepEqual(first.coverage.debugValues, [false, true]);
  assert.ok(first.coverage.optimizations.length >= 3, 'optimization coverage must not collapse to one level');
});

test('selection falls back to the requested count without hardcoded ids', () => {
  const cases = buildCases().slice(0, 2);
  const selection = selectProbeCases(cases, 5);
  assert.equal(selection.cases.length, 2);
});

function writeFixtures(root) {
  const cases = buildCases();
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    schema: 'hex-public-benchmark-manifest/v1',
    suite: 'codefuse-arm64',
    cases,
  }, null, 2));
  const artifactDirectory = path.join(root, 'artifacts');
  fs.mkdirSync(artifactDirectory, { recursive: true });
  for (const entry of cases) {
    fs.writeFileSync(path.join(artifactDirectory, `${sha256(entry.id)}.json`), JSON.stringify({
      schema: 'hex-public-benchmark-subject/v1',
      inputSha256: entry.binarySha256,
      state: 'PASS',
      functions: [
        { address: '4096', name: 'alpha', state: 'PASS', completeness: 'complete', pseudocode: 'int alpha(void)\n{\n return 1;\n}' },
      ],
    }));
  }
  return { manifestPath, artifactDirectory };
}

test('a failed compile stays in the denominator and is recorded with a bounded first error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-codefuse-probe-'));
  try {
    const { manifestPath, artifactDirectory } = writeFixtures(root);
    const outDir = path.join(root, 'out');
    const { summary, perCase } = await runProbe({
      repoRoot: root,
      manifestPath,
      artifactDirectory,
      outDir,
      count: 5,
      writeArtifacts: false,
      spawnImpl: () => failingChild({ stderr: 'source.c:7:3: error: undeclared identifier\nsource.c:9:1: error: too many errors\n', code: 1 }),
      env: { ...process.env, CODEFUSE_LLM_DISABLED: '1' },
    });

    assert.equal(summary.counts.selected, 5);
    assert.equal(summary.rawRecompilability.denominator, 5);
    assert.equal(summary.rawRecompilability.failed, 5, 'failed compiles must not be dropped');
    assert.equal(summary.rawRecompilability.passed, 0);
    assert.equal(summary.cases.length, 5);

    for (const entry of perCase) {
      assert.equal(entry.rawLane.preprocessed.status, 'compile_failed');
      assert.equal(entry.rawLane.preprocessed.compileSucceeded, false);
      assert.equal(entry.rawLane.preprocessed.diagnostics.firstError.line, 7);
      assert.match(entry.rawLane.preprocessed.diagnostics.firstError.message, /undeclared identifier/);
      assert.equal(entry.rawLane.preprocessed.diagnostics.errorCount, 2);
      assert.ok(!('stderr' in entry.rawLane.preprocessed), 'full compiler stderr must not be retained');
    }

    // LLM unavailable -> explicit unsupported state, not a silent pass.
    assert.equal(summary.repairedRecompilability.supported, false);
    assert.equal(summary.repairedRecompilability.unsupported, 5);
    assert.ok(summary.blockers.some((entry) => entry.startsWith('llm-endpoint-unavailable')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing artifact is an explicit recorded state, not a dropped case', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-codefuse-probe-missing-'));
  try {
    const { manifestPath, artifactDirectory } = writeFixtures(root);
    // Remove one artifact so its case has no input.
    const victim = fs.readdirSync(artifactDirectory)[0];
    fs.rmSync(path.join(artifactDirectory, victim));
    const { summary, perCase } = await runProbe({
      repoRoot: root,
      manifestPath,
      artifactDirectory,
      outDir: path.join(root, 'out'),
      count: 5,
      writeArtifacts: false,
      spawnImpl: () => failingChild({ code: 1 }),
      env: { ...process.env, CODEFUSE_LLM_DISABLED: '1' },
    });
    assert.equal(summary.counts.selected, 5);
    assert.equal(summary.counts.artifactMissing, 1);
    assert.equal(perCase.filter((entry) => !entry.artifact.available).length, 1);
    const missing = perCase.find((entry) => !entry.artifact.available);
    assert.equal(missing.rawLane.preprocessed.status, 'artifact_missing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
