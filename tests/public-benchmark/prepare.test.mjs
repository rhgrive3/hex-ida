import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const preparePath = fileURLToPath(
  new URL('../../tools/validation/public-benchmark/prepare.mjs', import.meta.url),
);

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-pb-prepare-'));
  const repository = path.join(root, 'repo');
  const publicRoot = path.join(repository, 'benchmarks', 'public');
  const source = path.join(root, 'CodeFuse-DeBench');
  const binaryPath = path.join(source, 'build', 'arm64', 'fixture_clang_O1_g');
  const referencePath = path.join(
    source,
    'decompiled',
    'ida_out',
    'arm64',
    'fixture_clang_O1_g.c',
  );
  fs.mkdirSync(publicRoot, { recursive: true });
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.mkdirSync(path.dirname(referencePath), { recursive: true });
  fs.writeFileSync(binaryPath, Buffer.from([0x42, 0x49, 0x4e, 0x31]));
  fs.writeFileSync(
    referencePath,
    '// Decompiled by IDA Pro 9.1 with Hex-Rays\nint f(void) { return 1; }\n',
  );
  return {
    root,
    repository,
    source,
    publicRoot,
    outputDirectory: path.join(publicRoot, 'codefuse-arm64'),
    manifestPath: path.join(publicRoot, 'codefuse-arm64', 'manifest.json'),
  };
}

function runPrepare(fixture, extraArguments = []) {
  return spawnSync(
    process.execPath,
    [preparePath, '--source', fixture.source, ...extraArguments],
    {
      cwd: fixture.repository,
      env: process.env,
      encoding: 'utf8',
      timeout: 15000,
    },
  );
}

test('prepare accepts documented --out manifest path and freezes matched inputs', { timeout: 20000 }, () => {
  const fixture = createFixture();
  try {
    const result = runPrepare(fixture, ['--out', 'benchmarks/public/codefuse-arm64/manifest.json']);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
    assert.equal(manifest.suite, 'codefuse-arm64');
    assert.equal(manifest.denominatorFrozen, true);
    assert.equal(manifest.cases.length, 1);
    assert.equal(manifest.cases[0].compiler, 'clang');
    assert.equal(manifest.cases[0].optimization, 'O1');
    assert.equal(fs.readFileSync(path.join(fixture.outputDirectory, manifest.cases[0].binary)).length, 4);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('prepare rejects an output escape and preserves existing user data', { timeout: 20000 }, () => {
  const fixture = createFixture();
  try {
    const outside = path.join(fixture.root, 'outside-output');
    fs.mkdirSync(outside);
    const sentinel = path.join(outside, 'keep.txt');
    fs.writeFileSync(sentinel, 'user data\n');

    const result = runPrepare(fixture, ['--output', outside]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must target benchmarks\/public\/codefuse-arm64\/manifest\.json/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'user data\n');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('prepare refuses to overwrite an existing suite directory', { timeout: 20000 }, () => {
  const fixture = createFixture();
  try {
    fs.mkdirSync(fixture.outputDirectory);
    const sentinel = path.join(fixture.outputDirectory, 'keep.txt');
    fs.writeFileSync(sentinel, 'existing generated data\n');

    const result = runPrepare(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to overwrite existing output/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'existing generated data\n');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
