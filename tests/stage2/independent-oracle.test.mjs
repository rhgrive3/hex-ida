import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableDigest } from '../../js/core/identity/index.js';
import {
  LLVM_READOBJ_EXPECTED_VERSION,
  LLVM_READOBJ_IDENTITY,
  REBUILD_ORACLE_MAX_INPUT_BYTES,
  createLlvmReadobjOracle,
  inspectLlvmReadobj,
} from '../../tools/validation/rebuild-independent-oracle.mjs';
import {
  INDEPENDENT_ORACLE_RESULT_SCHEMA,
  createRebuildTransaction,
  materializeRebuildTransaction,
  validateRebuildTransaction,
} from '../../js/rebuild/transaction-v2.js';
import { buildSampleBinary } from '../../js/sample.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digest = (bytes) => `bytes:${stableDigest(Array.from(bytes))}`;
const tool = inspectLlvmReadobj();
assert.equal(tool.available, true, `pinned independent reader must be available: ${tool.reason || 'unknown'}`);
assert.equal(tool.identity, LLVM_READOBJ_IDENTITY);
assert.ok(tool.version.includes(LLVM_READOBJ_EXPECTED_VERSION));

const fixtures = [
  { id: 'macho:sample-arm64', format: 'macho', architecture: 'arm64', bytes: buildSampleBinary(), real: false },
  { id: 'elf:phase5-vertical', format: 'elf', architecture: 'x86_64', bytes: fs.readFileSync(path.join(root, 'tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf')), real: false },
  { id: 'pe:phase5-vertical', format: 'pe', architecture: 'x86_64', bytes: fs.readFileSync(path.join(root, 'tests/phase5/corpus/fixtures/vertical-microsoft-x64.exe')), real: false },
];
const oracle = createLlvmReadobjOracle();
for (const fixture of fixtures) {
  const result = await oracle({
    transaction: { transactionId: `test:${fixture.id}`, format: fixture.format, architecture: fixture.architecture },
    original: fixture.bytes,
    output: fixture.bytes,
  });
  assert.equal(result.ok, true, `${fixture.id}: ${result.reason || result.detail || 'oracle rejected fixture'}`);
  assert.equal(result.status, 'passed');
  assert.equal(result.schemaVersion, INDEPENDENT_ORACLE_RESULT_SCHEMA);
  assert.equal(result.oracleIdentity, LLVM_READOBJ_IDENTITY);
  assert.ok(result.oracleVersion.includes(LLVM_READOBJ_EXPECTED_VERSION));
  assert.ok(result.oracleSource.includes('llvm-readobj'));
  assert.equal(result.sourceDigest, digest(fixture.bytes));
  assert.equal(result.outputDigest, digest(fixture.bytes));
  assert.match(result.oracleOutputDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.format, fixture.format);
  assert.equal(result.architecture, fixture.architecture);
  assert.equal(fixture.real, false, 'these are deterministic development fixtures, not release real binaries');
}

const elfFixture = fixtures.find((fixture) => fixture.format === 'elf');
const transaction = createRebuildTransaction({
  binaryId: 'binary:elf:oracle-test',
  sourceHash: digest(elfFixture.bytes),
  format: 'elf',
  architecture: 'x86_64',
  loaderVersion: 'hex-loader:elf:test',
  operations: [{ id: 'stable-tail', offset: elfFixture.bytes.length - 1, before: [elfFixture.bytes.at(-1)], after: [elfFixture.bytes.at(-1)], provenance: { source: 'test' } }],
  requireIndependentOracle: true,
});
const materialized = await materializeRebuildTransaction(transaction, elfFixture.bytes, { maxOutputBytes: elfFixture.bytes.length });
const validation = await validateRebuildTransaction(transaction, materialized, {
  original: elfFixture.bytes,
  loaderReparse: () => ({ ok: true, format: 'elf', architecture: 'x86_64', loaderVersion: transaction.loaderVersion, sourceHash: transaction.sourceHash, outputHash: materialized.outputHash }),
  independentOracle: oracle,
});
assert.equal(validation.status, 'valid', JSON.stringify(validation.validators));
assert.equal(validation.independentDifferential, 'executed');

const malformed = Uint8Array.from(fixtures[0].bytes);
malformed[0] = 0;
const malformedResult = await oracle({
  transaction: { transactionId: 'test:malformed', format: 'macho', architecture: 'arm64' },
  original: fixtures[0].bytes,
  output: malformed,
});
assert.equal(malformedResult.ok, false);
assert.equal(malformedResult.reason, 'independent-oracle-rejected-output');

const bounded = createLlvmReadobjOracle({ maxInputBytes: 1 });
const boundedResult = await bounded({
  transaction: { transactionId: 'test:budget', format: 'macho', architecture: 'arm64' },
  original: fixtures[0].bytes,
  output: fixtures[0].bytes,
});
assert.equal(boundedResult.ok, false);
assert.equal(boundedResult.reason, 'independent-oracle-input-budget-exceeded');
assert.equal(REBUILD_ORACLE_MAX_INPUT_BYTES, 128 * 1024 * 1024);

const unavailable = inspectLlvmReadobj({ command: '/definitely/missing/llvm-readobj', expectedVersion: null });
assert.equal(unavailable.available, false);
assert.equal(unavailable.reason, 'independent-oracle-tool-unavailable');
console.log('[stage2] independent Mach-O/ELF/PE llvm-readobj oracle tests passed');
