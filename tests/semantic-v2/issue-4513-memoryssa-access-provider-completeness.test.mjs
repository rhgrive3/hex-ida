import assert from 'node:assert/strict';
import { canonicalAccessProof as facadeCanonicalAccessProof } from '../../js/semantics/memoryssa/proof.js';
import { canonicalAccessProof as coreCanonicalAccessProof } from '../../js/semantics/memoryssa/proof-core.js';
import * as accessProviders from '../../js/semantics/memory-access-provider.js';

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

  for (const architectureId of ['arm64', 'arm64e', 'x86_64', 'riscv64', 'unknown', null]) {
    const current = descriptor('exact');
    current.node.attributes.machineEffects.architectureId = architectureId;
    const proof = canonicalAccessProof({ descriptor:current, identity, functionId:identity.functionId });
    if (architectureId === 'arm64' || architectureId === 'arm64e') {
      assert.ok(proof, `${entrypoint}: the built-in adapter retains ${architectureId}`);
      assert.equal(proof.architectureId, architectureId);
    } else {
      assert.equal(proof, null, `${entrypoint}: a foreign target cannot borrow this memory family`);
    }
  }

  for (const memoryOverrides of [
    { widthBits:0 }, { widthBits:7 }, { widthBits:'64' }, { widthBits:Infinity },
    { endian:'' }, { endian:null }, { atomic:true }, { volatility:true }, { ordering:'acquire' },
  ]) {
    assert.equal(proofFor(canonicalAccessProof, 'exact', memoryOverrides), null,
      `${entrypoint}: target adaptation must preserve qualifier and shape refusals: ${JSON.stringify(memoryOverrides)}`);
  }

  const foreignFamily = descriptor('exact');
  foreignFamily.node.attributes.machineEffects.bundleMetadata.family = 'arm64-atomic';
  assert.equal(canonicalAccessProof({ descriptor:foreignFamily, identity, functionId:identity.functionId }), null,
    `${entrypoint}: exact completeness alone cannot grant ordinary-memory authority`);

  const providerFree = proofFor(canonicalAccessProof, 'partial', { atomic:false, volatility:false });
  assert.ok(providerFree, `${entrypoint}: already-proven source qualifiers remain provider-free even when bundle is partial`);
  assert.equal(providerFree.atomic, false);
  assert.equal(providerFree.volatility, false);
  assert.equal(providerFree.architectureId, 'canonical-semantic');
}

assert.deepEqual(Object.keys(accessProviders), ['canonicalMemoryAccessQualifiers'],
  'the composition boundary exposes no registration or replacement API');
const targetFacts = accessProviders.canonicalMemoryAccessQualifiers(descriptor('exact'));
assert.ok(Object.isFrozen(targetFacts));
assert.ok(Object.isFrozen(targetFacts.evidence));
assert.equal(Object.hasOwn(targetFacts, 'issuer'), false, 'target facts do not mint proof authority');
assert.equal(Object.hasOwn(targetFacts, 'proofDigest'), false, 'only the canonical producer seals a proof');
const foreignDescriptor = descriptor('exact');
foreignDescriptor.node.attributes.machineEffects.architectureId = 'x86_64';
assert.equal(coreCanonicalAccessProof({
  descriptor:foreignDescriptor, identity, functionId:identity.functionId,
  raw:targetFacts, providerCallback:accessProviders.canonicalMemoryAccessQualifiers,
}), null, 'exported target facts and resolver cannot authorize a different descriptor');

assert.strictEqual(facadeCanonicalAccessProof, coreCanonicalAccessProof,
  'facade and direct core imports must share one canonical access-proof producer');

console.log('issue #4513 MemorySSA access provider completeness: PASS');
