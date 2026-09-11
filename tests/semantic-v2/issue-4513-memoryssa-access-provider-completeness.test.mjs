import assert from 'node:assert/strict';
import { canonicalAccessProof } from '../../js/semantics/memoryssa/proof.js';

const identity = { functionId:'function_issue_4513_completeness', memorySsaBuildVersion:'1.0.1' };
const origin = { instructionIds:['instruction_load_0'] };

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

function proofFor(bundleCompleteness, memoryOverrides = {}) {
  return canonicalAccessProof({
    descriptor:descriptor(bundleCompleteness, memoryOverrides),
    identity,
    functionId:identity.functionId,
  });
}

for (const completeness of ['partial', 'unknown', 'exact-with-intrinsic']) {
  assert.equal(
    proofFor(completeness),
    null,
    `${completeness} machine-effects must not close unknown atomic/volatility`,
  );
}

const exact = proofFor('exact');
assert.ok(exact, 'exact canonical ARM64 memory effects may close ordinary qualifiers');
assert.equal(exact.atomic, false);
assert.equal(exact.volatility, false);
assert.equal(exact.architectureId, 'arm64');
assert.equal(exact.family, 'arm64-memory');

const providerFree = proofFor('partial', { atomic:false, volatility:false });
assert.ok(providerFree, 'already-proven source qualifiers remain provider-free even when bundle is partial');
assert.equal(providerFree.atomic, false);
assert.equal(providerFree.volatility, false);
assert.equal(providerFree.architectureId, 'canonical-semantic');

console.log('issue #4513 MemorySSA access provider completeness: PASS');
