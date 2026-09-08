import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildVerificationCorpus, probeToolchain } from '../../../tools/validation/phase5/build-verification-corpus.mjs';

const sourceCategories = Object.freeze([
  'scalar-integer-arithmetic',
  'signed-and-unsigned-comparison',
  'conditional-branch',
  'loops',
  'switch-like-control-flow',
  'stack-locals-and-spills',
  'pointer-load-and-store',
  'array-indexing',
  'structure-field-access',
  'direct-calls',
  'indirect-calls',
  'multiple-arguments',
  'return-values',
  'partial-width-integer-operations',
  'zero-and-sign-extension',
  'shifts',
  'multiplication-and-division',
  'rip-relative-globals-and-pic-addressing',
  'scalar-floating-point',
  'baseline-compiler-emitted-simd',
  'atomic-read-modify-write',
  'sysv-amd64-abi',
  'microsoft-x64-abi',
  'variadic-abi-edge',
]);

test('P5-6 toolchain resolution prefers configured LLVM18 over an older system installation', () => {
  const binDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-p56-llvm18-'));
  const versions = Object.freeze({
    'clang-18': 'Ubuntu clang version 18.1.3 (fixture)',
    'ld.lld-18': 'Ubuntu LLD 18.1.3 (fixture)',
    'lld-link-18': 'Ubuntu LLD 18.1.3 (fixture)',
    'llvm-objdump-18': 'Ubuntu LLVM version 18.1.3 (fixture)',
    'llvm-readobj-18': 'Ubuntu LLVM version 18.1.3 (fixture)',
  });
  try {
    for (const [name, version] of Object.entries(versions)) {
      const file = path.join(binDirectory, name);
      fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
      fs.chmodSync(file, 0o755);
    }
    const probe = probeToolchain({ binDirectory });
    assert.equal(probe.exact, true, JSON.stringify(probe));
    const selectedNames = Object.freeze({ clang:'clang-18', lld:'ld.lld-18', lldLink:'lld-link-18', objdump:'llvm-objdump-18', readobj:'llvm-readobj-18' });
    for (const [key, name] of Object.entries(selectedNames)) {
      assert.equal(probe[key], path.join(binDirectory, name));
    }
  } finally {
    fs.rmSync(binDirectory, { recursive: true, force: true });
  }
});

test('P5-6 frozen Clang/LLD provenance is available exactly', () => {
  const probe = probeToolchain();
  console.log(`P5_6_TOOLCHAIN=${JSON.stringify(probe)}`);
  assert.equal(probe.exactCompiler, true, `compiler mismatch: ${probe.compilerVersion}`);
  assert.equal(probe.exactLinker, true, `linker mismatch: ${probe.linkerVersion} / ${probe.lldLinkVersion}`);
  assert.equal(probe.exactHost, true, `host mismatch: ${probe.host}`);
  assert.ok(probe.objdump, 'llvm-objdump is required as independent decode oracle');
  assert.ok(probe.readobj, 'llvm-readobj is required for format/symbol provenance');
});

test('P5-6 independently instantiates all six target/optimization binaries', () => {
  assert.equal(sourceCategories.length, 24);
  const result = buildVerificationCorpus();
  assert.equal(result.fixtures.length, 6);
  const keys = new Set(result.fixtures.map((fixture) => `${fixture.target}|${fixture.optimization}`));
  assert.equal(keys.size, 6);
  for (const target of ['sysv-amd64-elf','microsoft-x64-pe']) {
    const hashes = result.fixtures.filter((fixture) => fixture.target === target).map((fixture) => fixture.sha256);
    assert.equal(new Set(hashes).size, 3, `${target} O0/O2/Os must be independently compiled artifacts`);
  }
  const publicResult = {
    schemaVersion: result.schemaVersion,
    toolchain: result.toolchain,
    source: result.source,
    fixtures: result.fixtures.map(({ bytes, disassembly, objectMetadata, path, ...fixture }) => ({ ...fixture, file:path.split(/[\\/]/).at(-1) })),
  };
  console.log(`P5_6_CORPUS_PROVENANCE=${JSON.stringify(publicResult)}`);
  for (const fixture of result.fixtures) {
    console.log(`P5_6_FIXTURE_B64:${fixture.id}:${fixture.bytes.toString('base64')}`);
    console.log(`P5_6_OBJDUMP_B64:${fixture.id}:${Buffer.from(fixture.disassembly).toString('base64')}`);
    console.log(`P5_6_READOBJ_B64:${fixture.id}:${Buffer.from(fixture.objectMetadata).toString('base64')}`);
  }
});
