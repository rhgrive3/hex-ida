import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scanArchitectureNeutrality } from '../../tools/validation/semantic-v2/architecture-neutrality.mjs';
import * as memorySsaProof from '../../js/semantics/memoryssa/proof.js';
import {
  CANONICAL_ACCESS_ISSUER,
  MEMORY_SSA_PROOF_VERSION,
  canonicalAccessProof,
} from '../../js/semantics/memoryssa/proof.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function accessDescriptor({ architectureId, family, bundleCompleteness, memory = {} }) {
  return {
    node: {
      id: 'load_0',
      origin: { instructionIds: ['instruction_load_0'] },
      attributes: {
        machineEffects: {
          instructionId: 'instruction_load_0',
          architectureId,
          mode: 'a64',
          bundleCompleteness,
          operationKind: 'memory-read',
          bundleMetadata: { family, mnemonic: 'ldr' },
        },
      },
    },
    memory: {
      addressSpace: 'memory',
      addressValueId: 'address_0',
      widthBits: 64,
      endian: 'little',
      volatility: 'unknown',
      atomic: 'unknown',
      ordering: 'unknown',
      ...memory,
    },
  };
}

const identity = { functionId: 'function_8740', memorySsaBuildVersion: '1.0.1' };

function proofFor(descriptor) {
  return canonicalAccessProof({ descriptor, identity, functionId: identity.functionId });
}

// (1) The generic MemorySSA proof layer must not branch on architecture data.
const neutrality = scanArchitectureNeutrality({ root });
assert.equal(neutrality.architectureLeakCount, 0,
  `generic SSA/MemorySSA architecture leak count must be zero: ${JSON.stringify(neutrality.violations)}`);
assert.ok(!(neutrality.violations || []).some((v) => String(v.file).includes('memoryssa/proof-core.js')),
  'proof-core.js must not carry any target-specific branch');

// (2) The generic provider stays module-private (#4513 capability invariant).
assert.equal(Object.hasOwn(memorySsaProof, 'canonicalSemanticAccessProvider'), false,
  'canonical access provider implementation must remain module-private');

// (3) ARM64 ordinary exact memory access still closes an ordinary proof, with the
//     concrete target identity carried through unchanged (byte-for-byte parity).
const arm64 = proofFor(accessDescriptor({
  architectureId: 'arm64', family: 'arm64-memory', bundleCompleteness: 'exact',
}));
assert.ok(arm64, 'ARM64 exact ordinary memory access must still produce a canonical access proof');
assert.equal(arm64.kind, 'canonical-memory-access-qualifiers');
assert.equal(arm64.issuer.id, CANONICAL_ACCESS_ISSUER);
assert.equal(arm64.version, MEMORY_SSA_PROOF_VERSION);
assert.equal(arm64.architectureId, 'arm64');
assert.equal(arm64.family, 'arm64-memory');
assert.equal(arm64.atomic, false);
assert.equal(arm64.volatility, false);

// (4) A non-ARM64 target with an equivalent exact ordinary-memory bundle reaches the
//     SAME generic contract with no change to the generic layer (#8740 acceptance).
const x64 = proofFor(accessDescriptor({
  architectureId: 'x86_64', family: 'x86-memory', bundleCompleteness: 'exact',
}));
assert.ok(x64, 'non-ARM64 exact ordinary memory access must reach the generic proof contract');
assert.equal(x64.kind, 'canonical-memory-access-qualifiers');
assert.equal(x64.issuer.id, CANONICAL_ACCESS_ISSUER);
assert.equal(x64.architectureId, 'x86_64');
assert.equal(x64.family, 'x86-memory');
assert.equal(x64.atomic, false);
assert.equal(x64.volatility, false);

// (5) Fail-closed: a non-exact bundle with unknown source qualifiers never closes,
//     for any architecture.
for (const completeness of ['partial', 'unknown', 'exact-with-intrinsic']) {
  assert.equal(proofFor(accessDescriptor({ architectureId: 'arm64', family: 'arm64-memory', bundleCompleteness: completeness })), null,
    `ARM64 ${completeness} must not close unknown ordinary qualifiers`);
  assert.equal(proofFor(accessDescriptor({ architectureId: 'x86_64', family: 'x86-memory', bundleCompleteness: completeness })), null,
    `x86_64 ${completeness} must not close unknown ordinary qualifiers`);
}

// (6) Fail-closed: atomic / volatile / ordered exact bundles are not laundered into
//     an ordinary-access proof, for any architecture.
assert.equal(proofFor(accessDescriptor({
  architectureId: 'arm64', family: 'arm64-memory', bundleCompleteness: 'exact', memory: { atomic: true },
})), null, 'atomic exact bundle must not be promoted to ordinary access proof');
assert.equal(proofFor(accessDescriptor({
  architectureId: 'x86_64', family: 'x86-memory', bundleCompleteness: 'exact', memory: { volatility: true },
})), null, 'volatile exact bundle must not be promoted to ordinary access proof');

console.log('issue #8740 MemorySSA access provider architecture neutrality: PASS');
