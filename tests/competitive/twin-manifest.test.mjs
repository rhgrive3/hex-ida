import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import * as twinApi from '../../tools/validation/competitive/twin-manifest.mjs';
import { buildTwinFixture, removeTwinFixture } from './twin-fixture.mjs';

const generateTwinManifest = twinApi.generateTwinManifest;
const verifyTwinManifest = twinApi.validateTwinManifest;

if (typeof generateTwinManifest !== 'function') {
  throw new Error('same-binary-twin generator export is missing');
}
if (typeof verifyTwinManifest !== 'function') {
  throw new Error('same-binary-twin verifier export is missing');
}

let fixture;
test.before(() => {
  fixture = buildTwinFixture();
});
test.after(() => {
  removeTwinFixture(fixture);
});

function outputDirectory(name) {
  const directory = path.join(fixture.root, 'generated', name);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function generationRequest({ artifact = fixture.debug.path, outputDir = outputDirectory('default'), ...overrides } = {}) {
  const strippedArtifactPath = path.join(outputDir, 'stripped.elf');
  return {
    debugArtifactPath: artifact,
    strippedArtifactPath,
    ...fixture.context,
    ...overrides,
  };
}

function generate(request = generationRequest()) {
  const result = generateTwinManifest(request);
  const manifest = result?.manifest ?? result;
  assert.ok(manifest && typeof manifest === 'object', 'generator must return a manifest object');
  assert.equal(typeof manifest.manifestDigest, 'string', 'manifest must carry a deterministic digest');
  assert.ok(manifest.manifestDigest.length > 0, 'manifest digest must not be empty');
  return { result, manifest, request };
}

function verifierRequest(manifest, overrides = {}) {
  return {
    manifest,
    debugArtifactPath: fixture.debug.path,
    strippedArtifactPath: manifest.__strippedArtifactPath ?? fixture.stripped.path,
    expected: fixture.context,
    ...overrides,
  };
}

function accepted(value) {
  if (value === true) return true;
  if (value == null) return false;
  if (value.accepted === true || value.valid === true || value.verified === true) return true;
  return ['ACCEPTED', 'PASS', 'VALID', 'verified'].includes(value.status ?? value.verdict);
}

function rejected(value) {
  if (value === false) return true;
  if (value == null) return false;
  if (value.accepted === false || value.valid === false || value.verified === false) return true;
  return ['REJECTED', 'FAIL', 'INVALID', 'identity-mismatch', 'stale'].includes(value.status ?? value.verdict);
}

function assertVerificationAccepted(manifest, message = 'same-artifact twin must be accepted', overrides = {}) {
  let result;
  try {
    const options = verifierRequest(manifest, overrides);
    delete options.manifest;
    result = verifyTwinManifest(manifest, options);
  } catch (error) {
    assert.fail(`${message}: ${error?.message || error}`);
  }
  assert.ok(accepted(result), `${message}: verifier must report an explicit accepted result`);
  return result;
}

function assertVerificationRejected(manifest, overrides, message) {
  let result;
  try {
    const options = verifierRequest(manifest, overrides);
    delete options.manifest;
    result = verifyTwinManifest(manifest, options);
  } catch {
    return;
  }
  assert.ok(rejected(result), `${message}: verifier must reject explicitly, not return a truthy result`);
}

function generatedFiles(directory) {
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  visit(directory);
  return files.sort();
}

test('one real debug artifact is copied and accepted after the recognized strip-only operation', () => {
  const generated = generate();
  const files = generatedFiles(outputDirectory('default'));
  assert.deepEqual(files, [generated.request.strippedArtifactPath],
    'generator must materialize exactly the requested stripped twin output');
  assertVerificationAccepted(generated.manifest, 'same-artifact twin must be accepted', {
    strippedArtifactPath: generated.request.strippedArtifactPath,
  });
});

test('regenerating the same fixture is deterministic and path/time independent', () => {
  const first = generate(generationRequest({ outputDir: outputDirectory('deterministic-a') }));
  const second = generate(generationRequest({ outputDir: outputDirectory('deterministic-b') }));
  assert.equal(first.manifest.manifestDigest, second.manifest.manifestDigest,
    'output paths must not enter manifestDigest');

  const generated = generatedFiles(outputDirectory('deterministic-b'));
  const timestamp = new Date('2001-02-03T04:05:06.000Z');
  for (const file of generated) fs.utimesSync(file, timestamp, timestamp);
  const third = generate(generationRequest({ outputDir: outputDirectory('deterministic-c') }));
  assert.equal(first.manifest.manifestDigest, third.manifest.manifestDigest,
    'artifact timestamps must not enter manifestDigest');
});

test('same source rebuilt into a distinct artifact is rejected as wrong lineage', () => {
  const generated = generate();
  assertVerificationRejected(generated.manifest, {
    debugArtifactPath: fixture.rebuilt.path,
    strippedArtifactPath: fixture.rebuiltStripped.path,
  }, 'same-source rebuild must not become the expected twin');
});

test('compiler, optimization, target, source, and build identity drift are rejected', () => {
  const generated = generate();
  const drifts = [
    ['compiler version', { expected: { ...fixture.context, compiler: { ...fixture.context.compiler, version: 'compiler-version-drift' } } }],
    ['optimization flags', { expected: { ...fixture.context, compileArgs: ['-g', '-O2'], compileOptions: { ...fixture.context.compileOptions, optimization: 'O2' } } }],
    ['target', { expected: { ...fixture.context, targetTriple: 'aarch64-unknown-linux-gnu' } }],
    ['source', { expected: { ...fixture.context, sourceIdentity: { ...fixture.context.sourceIdentity, sha256: '0'.repeat(64) } } }],
    ['build identity', { expected: { ...fixture.context, buildIdentity: 'deadbeef' } }],
  ];
  for (const [label, overrides] of drifts) {
    assertVerificationRejected(generated.manifest, overrides, `${label} drift`);
  }
});

test('one-byte patches to either twin are rejected', () => {
  const generated = generate();
  assertVerificationRejected(generated.manifest, {
    debugArtifactPath: fixture.patchedDebug.path,
    strippedArtifactPath: fixture.stripped.path,
  }, 'patched debug artifact');
  assertVerificationRejected(generated.manifest, {
    strippedArtifactPath: fixture.patchedStripped.path,
  }, 'patched stripped twin');
});

test('a stripped twin from the wrong artifact is rejected', () => {
  const generated = generate();
  assertVerificationRejected(generated.manifest, {
    strippedArtifactPath: fixture.rebuiltStripped.path,
  }, 'wrong stripped twin');
});

test('stale manifests and missing required fields fail closed', () => {
  const generated = generate();
  const stale = { ...generated.manifest, manifestDigest: 'stale-manifest-digest' };
  assertVerificationRejected(stale, {}, 'stale manifest');

  for (const field of ['schemaVersion', 'manifestDigest', 'sourceIdentity', 'stripArgv']) {
    const missing = { ...generated.manifest };
    delete missing[field];
    assertVerificationRejected(missing, {}, `missing required field ${field}`);
  }
});

test('artifact replay requires complete context and a distinct debug-bearing input', () => {
  const generated = generate();
  assertVerificationRejected(generated.manifest, { expected: undefined }, 'artifact paths without expected identity context');
  assert.throws(
    () => generate(generationRequest({ artifact: fixture.stripped.path, outputDir: outputDirectory('already-stripped') })),
    /identical|debug-bearing|strip/i,
    'an already-stripped input must not mint a twin'
  );
});

test('unknown strip operations are rejected instead of accepted as truth', () => {
  assert.throws(() => generate(generationRequest({ stripArgv: ['--strip-all'] })),
    /strip|operation|unsupported|unknown/i,
    'an unrecognized operation must fail closed');
  assert.throws(() => generate(generationRequest({ stripTool: { id: 'objcopy', version: '2.42' } })),
    /strip|tool|recognized|unsupported|unknown/i,
    'an unrecognized strip executable must fail closed');
});

test('competitor output cannot alter the expected truth input', () => {
  const clean = generate(generationRequest({ outputDir: outputDirectory('truth-clean') }));
  const injected = generate(generationRequest({
    outputDir: outputDirectory('truth-injected'),
    competitorOutput: {
      verdict: 'WIN',
      symbols: ['forged-symbol'],
      expectedTruth: 'forged',
    },
  }));
  assert.equal(injected.manifest.manifestDigest, clean.manifest.manifestDigest,
    'competitor output must not participate in expected truth or manifest identity');
  assertVerificationAccepted(clean.manifest);
  assertVerificationAccepted(injected.manifest);
});
