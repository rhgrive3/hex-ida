import assert from 'node:assert/strict';
import { canonicalAccessProof as facadeCanonicalAccessProof } from '../../js/semantics/memoryssa/proof.js';
import { canonicalAccessProof as coreCanonicalAccessProof } from '../../js/semantics/memoryssa/proof-core.js';

const identity = { functionId:'function_issue_4513_completeness', memorySsaBuildVersion:'1.0.1' };
const origin = { instructionIds:['instruction_load_0'] };
const proofEntrypoints = Object.freeze([
  ['facade', facadeCanonicalAccessProof],
  ['core', coreCanonicalAccessProof],
]);

function descriptor(bundleCompleteness, memoryOverrides = {}) {
  const memory = {
    addressSpace:'memory',
    addressValueId:'address_0',
    widthBits:64,
    endian:'little',
    volatility:'unknown',
    atomic:'unknown',
    ordering:'unknown',
    ...memoryOverrides,
  };
  return {
    node:{
      id:'load_0',
      origin,
      attributes:{
        machineEffects:{
          instructionId:'instruction_load_0',
          architectureId:'arm64',
          mode:'a64',
          bundleCompleteness,
          operationKind:'memory-read',
          bundleMetadata:{ family:'arm64-memory', mnemonic:'ldr' },
        },
      },
    },
    memory,
  };
}

function proofFor(canonicalAccessProof, bundleCompleteness, memoryOverrides = {}) {
  return canonicalAccessProof({
    descriptor:descriptor(bundleCompleteness, memoryOverrides),
    identity,
    functionId:identity.functionId,
  });
}

for (const [entrypoint, canonicalAccessProof] of proofEntrypoints) {
  for (const completeness of ['partial', 'unknown', 'exact-with-intrinsic']) {
    assert.equal(
      proofFor(canonicalAccessProof, completeness),
      null,
      `${entrypoint}: ${completeness} machine-effects must not close unknown atomic/volatility`,
    );
  }

  const exact = proofFor(canonicalAccessProof, 'exact');
  assert.ok(exact, `${entrypoint}: exact canonical ARM64 memory effects may close ordinary qualifiers`);
  assert.equal(exact.atomic, false);
  assert.equal(exact.volatility, false);
  assert.equal(exact.architectureId, 'arm64');
  assert.equal(exact.family, 'arm64-memory');

  const providerFree = proofFor(canonicalAccessProof, 'partial', { atomic:false, volatility:false });
  assert.ok(providerFree, `${entrypoint}: already-proven source qualifiers remain provider-free even when bundle is partial`);
  assert.equal(providerFree.atomic, false);
  assert.equal(providerFree.volatility, false);
  assert.equal(providerFree.architectureId, 'canonical-semantic');
}

assert.strictEqual(facadeCanonicalAccessProof, coreCanonicalAccessProof,
  'facade and direct core imports must share one canonical access-proof producer');

console.log('issue #4513 MemorySSA access provider completeness: PASS');
