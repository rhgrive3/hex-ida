import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOperands } from '../../js/arm64.js';
import {
  ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION,
  arm64MachineEffectFamilies,
  liftArm64MachineEffects,
} from '../../js/targets/architecture/arm64/effects/index.js';
import {
  ARM64_A64_CANONICAL_FAMILY_ORDER,
  ARM64_A64_CANDIDATE_CORPUS_LOCK,
  ARM64_A64_DECODER_AUDIT_LOCK,
  ARM64_A64_DECODER_DEPENDENCY_PROOF_SCHEMA,
  ARM64_A64_DECODER_DENOMINATOR_ID,
  ARM64_A64_DECODER_IDENTITY_LOCK,
  ARM64_A64_LOCKED_PROFILE,
  assertArm64A64DecodedOwnership,
  auditArm64A64DecoderOwnership,
  buildArm64A64CandidateCorpusEvidence,
  buildArm64CapstoneRegistryEvidence,
  classifyArm64A64LockedScope,
  classifyArm64A64TopLevel,
  arm64A64DecoderDenominatorFromLockedAudit,
  arm64A64LockedDecoderAuditEvidence,
  validateArm64A64DecoderDenominator,
  validateArm64A64DecoderDependencyProof,
  verifyArm64A64DecoderIdentity,
} from '../../tools/validation/machine-effects/arm64-a64-decoder-denominator.mjs';
import { createCapstoneArm64Session } from './helpers/arm64-capstone-session.mjs';
import { arm64A64SimdDecoderDependencyProof } from '../../tools/validation/machine-effects/arm64-a64-simd-denominator.mjs';
import { arm64A64MemoryDecoderDependencyProof } from '../../tools/validation/machine-effects/arm64-a64-memory-denominator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function bytes32(word) {
  const value = Number(word) >>> 0;
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
}
function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function decodedInstruction(raw, id) {
  return {
    instructionId:id,
    address:raw.address,
    mnemonic:raw.mnemonic,
    operands:raw.opStr,
    opStr:raw.opStr,
    ops:parseOperands(raw.opStr),
    mode:'a64',
    origin:{ instructionIds:[id] },
  };
}

const structural = validateArm64A64DecoderDenominator();
assert.equal(structural.denominatorId, ARM64_A64_DECODER_DENOMINATOR_ID);
assert.equal(structural.denominatorAuthority, 'independent-arm-encoding-family-union-plus-fixed-decoder-audit');
assert.equal(structural.decoderProvider, 'capstone/backend');
assert.equal(structural.architectureSemanticVersion, '7');
assert.equal(structural.scopeShrinkGuard, true);
assert.equal(structural.corpusShrinkGuard, true);
assert.equal(structural.decoderAuditObserved, false, 'static flags cannot substitute for an observed decoder audit');
assert.equal(structural.terminalEligible, false);
assert.equal(structural.validEncodingOwnershipProof, false);
assert.equal(structural.fallbackNegativeProof, false);
assert.deepEqual(structural.missingDependencies, ['memory','simd']);
assert.deepEqual(structural.requiredCanonicalFamilies, ARM64_A64_CANONICAL_FAMILY_ORDER);
assert.deepEqual(arm64MachineEffectFamilies(), ARM64_A64_CANONICAL_FAMILY_ORDER, 'production owner precedence drifted');
assert.equal(ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, ARM64_A64_DECODER_IDENTITY_LOCK.machineEffectsSemanticVersion);

const corpus = buildArm64A64CandidateCorpusEvidence();
for (const key of ['candidateCaseCount','candidateUniqueWordCount','candidateSha256','candidateUniqueWordsSha256']) {
  assert.equal(corpus[key], ARM64_A64_CANDIDATE_CORPUS_LOCK[key], key);
}
assert.deepEqual(corpus.familyCaseCounts, ARM64_A64_CANDIDATE_CORPUS_LOCK.familyCaseCounts);
assert.deepEqual(corpus.aliasOverlapCounts, ARM64_A64_CANDIDATE_CORPUS_LOCK.aliasOverlapCounts);
assert.equal(corpus.candidateCaseCount, 376_186);
assert.equal(corpus.aliasOverlapCounts['flags+integer'], 12_992, 'CMP/CMN/TST alias overlap must remain precedence-sensitive');

// All bit31/op1 cells are explicit. Nothing outside the locked classic-A64
// regions can become a hidden denominator bucket.
const topLevelCells = new Set();
const topLevelClasses = new Set();
for (const bit31 of [0,1]) {
  for (let op1 = 0; op1 < 16; op1++) {
    const word = ((bit31 << 31) | (op1 << 25)) >>> 0;
    const cell = classifyArm64A64TopLevel(word);
    assert.equal(cell.bit31, bit31);
    assert.equal(cell.op1, op1);
    assert.ok(['invalid-or-reserved','out-of-profile-extension','classic-a64-region'].includes(cell.disposition));
    topLevelCells.add(`${bit31}:${op1}`);
    topLevelClasses.add(cell.classId);
  }
}
assert.equal(topLevelCells.size, 32);
assert.deepEqual([...topLevelClasses].sort(), [
  'branch-exception-system','data-processing-immediate','data-processing-register','load-store',
  'reserved','scalar-fp-advanced-simd','sme','sve','unallocated',
].sort());

const session = await createCapstoneArm64Session();
let decoderAudit;
try {
  const registry = buildArm64CapstoneRegistryEvidence(session.instructionName);
  const identity = Object.freeze({
    provider:'capstone/backend',
    architecture:'arm64',
    mode:'a64',
    capstoneApi:session.version,
    artifacts:Object.freeze({
      'capstone.js':sha256File(path.join(ROOT, 'capstone.js')),
      'capstone.wasm':sha256File(path.join(ROOT, 'capstone.wasm')),
    }),
    instructionRegistry:registry,
    machineEffectsSemanticVersion:ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION,
  });
  assert.equal(verifyArm64A64DecoderIdentity(identity), true);
  assert.deepEqual(session.version, { packed:1280, major:5, minor:0 });
  assert.deepEqual(registry, ARM64_A64_DECODER_IDENTITY_LOCK.instructionRegistry);
  for (const mutation of [
    { ...identity, capstoneApi:{ ...identity.capstoneApi, minor:1 } },
    { ...identity, artifacts:{ ...identity.artifacts, 'capstone.wasm':'0'.repeat(64) } },
    { ...identity, instructionRegistry:{ ...identity.instructionRegistry, count:identity.instructionRegistry.count - 1 } },
    { ...identity, machineEffectsSemanticVersion:'8' },
  ]) assert.throws(() => verifyArm64A64DecoderIdentity(mutation), /drift/);

  decoderAudit = auditArm64A64DecoderOwnership({
    decoderIdentity:identity,
    decodeWord(word) {
      return session.decode(bytes32(word), 0x400000n)[0] ?? null;
    },
    liftDecoded(raw, { sourceFamily, item }) {
      const id = `arm64-decoder-denominator:${sourceFamily}:${item.id}`;
      // BTI's exactness depends on runtime mapped-page state. Bind that external
      // state explicitly so this decoder-family proof tests owner semantics,
      // rather than laundering a missing runtime observation into partial.
      return liftArm64MachineEffects(decodedInstruction(raw, id), { btiGuardedPage:false });
    },
  });

  assert.equal(decoderAudit.candidateCaseCount, 376_186);
  assert.equal(decoderAudit.decoderRecognizedCaseCount, 376_139);
  assert.equal(decoderAudit.decoderRejectedCaseCount, 47);
  assert.equal(decoderAudit.decoderRecognizedUniqueWordCount, 375_828);
  assert.equal(decoderAudit.decoderAuditSha256, ARM64_A64_DECODER_AUDIT_LOCK.decoderAuditSha256);
  assert.equal(decoderAudit.decoderRejectedSha256, ARM64_A64_DECODER_AUDIT_LOCK.decoderRejectedSha256);
  assert.deepEqual(decoderAudit.scopeCounts, {
    'in-profile-resolved':343_236,
    'dependency-pending':68,
    'out-of-profile-unenumerated':32_835,
  });
  assert.deepEqual(decoderAudit.resolvedOwnerCounts, {
    control:21_306,
    flags:15_232,
    fp:8_417,
    integer:68_899,
    system:229_382,
  });
  assert.deepEqual(decoderAudit.rejectedKindCounts, {
    'provider-unsupported-architectural':2,
    'invalid-or-reserved':45,
  });
  assert.equal(decoderAudit.resolvedOwnershipProof, true);
  assert.equal(decoderAudit.negativeBoundaryProof, true);
  assert.equal(decoderAudit.dependencyPendingNoNullProof, true);

  const observed = validateArm64A64DecoderDenominator({ decoderAudit });
  assert.equal(observed.decoderAuditObserved, true);
  assert.deepEqual(observed.missingDependencies, ['memory','simd']);
  assert.equal(observed.terminalEligible, false, 'memory/SIMD exact proofs remain separate dependencies');

  function decodeAndLift(word, label) {
    const raw = session.decode(bytes32(word), 0x400000n)[0] ?? null;
    const effects = raw
      ? liftArm64MachineEffects(decodedInstruction(raw, `arm64-decoder-witness:${label}`), { btiGuardedPage:false })
      : null;
    return { raw, effects };
  }

  // Raw alias overlap is resolved by the production family precedence contract.
  const cmp = decodeAndLift(0xeb01001f, 'cmp');
  assert.equal(cmp.raw?.mnemonic, 'cmp');
  assert.equal(classifyArm64A64LockedScope(0xeb01001f, 'cmp').canonicalFamily, 'flags');
  assert.equal(assertArm64A64DecodedOwnership({ word:0xeb01001f, mnemonic:'cmp', effects:cmp.effects }).canonicalFamily, 'flags');
  assert.throws(
    () => assertArm64A64DecodedOwnership({ word:0x8b020020, mnemonic:'add', effects:null }),
    /valid-decoder-form-fell-through/,
  );

  // Barrier aliases live in raw system encoding space but canonical memory
  // ownership. They are explicit dependencies, never promoted to system exact.
  for (const [word, mnemonic] of [
    [0xd5033fbf,'dmb'], [0xd5033f9f,'dsb'], [0xd5033fdf,'isb'], [0xd5033f5f,'clrex'],
  ]) {
    const { raw, effects } = decodeAndLift(word, mnemonic);
    assert.equal(raw?.mnemonic, mnemonic);
    const classification = classifyArm64A64LockedScope(word, mnemonic);
    assert.equal(classification.scope, 'dependency-pending');
    assert.equal(classification.canonicalFamily, 'memory');
    assert.ok(effects, `${mnemonic}:must not fall through while dependency is pending`);
    assert.ok(['arm64-memory','arm64-atomic'].includes(effects.metadata?.family));
  }

  // A raw system mask is not self-authorizing. Decoded aliases outside the
  // locked system mnemonic denominator stay explicit out-of-profile negatives.
  for (const [word, mnemonic] of [
    [0xd500401f,'cfinv'],
    [0xd503101f,'wfet'],
    [0xd503233f,'paciasp'],
  ]) {
    const { raw, effects } = decodeAndLift(word, mnemonic);
    assert.equal(raw?.mnemonic, mnemonic);
    assert.equal(classifyArm64A64LockedScope(word, mnemonic).scope, 'out-of-profile-unenumerated');
    assert.equal(effects, null);
  }

  // Recognized decoder forms outside the locked classic profile and explicit
  // SVE/SME extension cells are negative witnesses, not hidden fallback.
  for (const [word, mnemonic, expectedScope] of [
    [0xdac01420, 'cls', 'out-of-profile-unenumerated'],
    [0x1ac04020, 'crc32b', 'out-of-profile-unenumerated'],
    [0x65bbf753, 'fnmsb', 'out-of-profile-extension'],
    [0xa0e3d8a4, 'sumopa', 'out-of-profile-extension'],
  ]) {
    const { raw } = decodeAndLift(word, `excluded:${mnemonic}`);
    assert.equal(raw?.mnemonic, mnemonic);
    assert.equal(classifyArm64A64LockedScope(word, mnemonic).scope, expectedScope);
  }

  const reserved = decodeAndLift(0x02000000, 'reserved');
  assert.equal(reserved.raw, null);
  assert.equal(classifyArm64A64LockedScope(0x02000000).scope, 'invalid-or-reserved');
  const udf = decodeAndLift(0x00000000, 'udf');
  assert.equal(udf.raw?.mnemonic, 'udf');
  assert.equal(udf.effects, null);
  assert.equal(classifyArm64A64LockedScope(0x00000000, 'udf').scope, 'invalid-or-reserved');

  // Separate memory/SIMD regions remain blockers instead of being relabelled as
  // negative decoder space.
  for (const [word, mnemonic] of [[0xf9400020,'ldr'],[0x4e22d420,'fadd']]) {
    const { raw, effects } = decodeAndLift(word, `dependency:${mnemonic}`);
    assert.equal(raw?.mnemonic, mnemonic);
    assert.equal(classifyArm64A64LockedScope(word, mnemonic).scope, 'dependency-pending');
    assert.ok(effects, `${mnemonic}:current production route must remain visible`);
  }
} finally {
  session.close();
}

assert.ok(decoderAudit, 'actual fixed-provider audit must run');

// Dependency contract adapter: these synthetic objects exercise only the shape.
// They are not repository proof evidence and do not alter central Stage2 truth.
function dependencyContract(canonicalFamily) {
  return Object.freeze({
    schemaVersion:ARM64_A64_DECODER_DEPENDENCY_PROOF_SCHEMA,
    canonicalFamily,
    profileId:'arm64:a64',
    coverageState:'exact',
    decoderProvider:'capstone/backend',
    decoderIdentityId:ARM64_A64_DECODER_IDENTITY_LOCK.identityId,
    denominatorId:`synthetic-contract:${canonicalFamily}`,
    denominatorAuthority:`independent-synthetic-${canonicalFamily}-contract`,
    independentAuthority:true,
    oracleIds:Object.freeze([`synthetic-${canonicalFamily}-spec`,`synthetic-${canonicalFamily}-decoder`]),
    lockedScopeId:`synthetic-scope:${canonicalFamily}`,
    encodingCaseCount:17,
    lockedEncodingCaseCount:17,
    lockedCorpusSha256:'a'.repeat(64),
    observedCorpusSha256:'a'.repeat(64),
    validEncodingOwnershipProof:true,
    fallbackNegativeProof:true,
    scopeShrinkGuard:true,
    corpusShrinkGuard:true,
  });
}
const memoryContract = dependencyContract('memory');
assert.equal(validateArm64A64DecoderDependencyProof('memory', memoryContract), true);
for (const damaged of [
  { ...memoryContract, observedCorpusSha256:'b'.repeat(64) },
  { ...memoryContract, encodingCaseCount:16 },
  { ...memoryContract, denominatorAuthority:'production-effect-registry' },
  { ...memoryContract, independentAuthority:false },
  { ...memoryContract, decoderIdentityId:'other-decoder' },
  { ...memoryContract, oracleIds:['production-effect-registry','synthetic-decoder'] },
]) assert.equal(validateArm64A64DecoderDependencyProof('memory', damaged), false);

const memoryOnly = validateArm64A64DecoderDenominator({ decoderAudit, dependencyProofs:{ memory:memoryContract } });
assert.deepEqual(memoryOnly.missingDependencies, ['simd']);
assert.equal(memoryOnly.terminalEligible, false);
// The repository's real SIMD dependency proof, unlike the synthetic shapes
// above, is central truth: it must satisfy the contract on its own and it must
// leave memory as the single remaining dependency.
const realSimd = arm64A64SimdDecoderDependencyProof();
const realMemory = arm64A64MemoryDecoderDependencyProof();
assert.equal(validateArm64A64DecoderDependencyProof('simd', realSimd), true);
assert.equal(validateArm64A64DecoderDependencyProof('memory', realMemory), true);
const simdResolved = validateArm64A64DecoderDenominator({ decoderAudit, dependencyProofs:{ simd:realSimd } });
assert.deepEqual(simdResolved.missingDependencies, ['memory'], 'one resolved family must not resolve the other');
assert.equal(simdResolved.terminalEligible, false);

const realTerminal = validateArm64A64DecoderDenominator({ decoderAudit, dependencyProofs:{ memory:realMemory, simd:realSimd } });
assert.deepEqual(realTerminal.missingDependencies, []);
assert.equal(realTerminal.terminalEligible, true, 'the observed audit plus both real family contracts are terminal');
assert.equal(realTerminal.validEncodingOwnershipProof, true);
assert.equal(realTerminal.fallbackNegativeProof, true);

// Downstream consumers replay the locked audit instead of re-running the sweep.
// The replay has to agree with the audit that actually ran here, or the lock is
// no longer evidence of anything.
const replayed = arm64A64DecoderDenominatorFromLockedAudit({ memory:realMemory, simd:realSimd });
assert.equal(replayed.terminalEligible, true);
assert.equal(replayed.decoderAuditObserved, true);
for (const field of ['denominatorId','profileId','decoderIdentityId','architectureSemanticVersion','validEncodingOwnershipProof','fallbackNegativeProof']) {
  assert.equal(replayed[field], realTerminal[field], `locked-audit replay drifted from the observed audit: ${field}`);
}
assert.deepEqual(arm64A64LockedDecoderAuditEvidence().scopeCounts, decoderAudit.scopeCounts);
assert.equal(arm64A64LockedDecoderAuditEvidence().decoderAuditSha256, decoderAudit.decoderAuditSha256);
assert.equal(arm64A64DecoderDenominatorFromLockedAudit({ simd:realSimd }).terminalEligible, false);

const contractComplete = validateArm64A64DecoderDenominator({
  decoderAudit,
  dependencyProofs:{ memory:memoryContract, simd:dependencyContract('simd') },
});
assert.equal(contractComplete.terminalEligible, true, 'composition path is terminal only with observed decoder audit plus exact dependency contracts');
assert.equal(contractComplete.validEncodingOwnershipProof, true);
assert.equal(contractComplete.fallbackNegativeProof, true);
assert.equal(ARM64_A64_LOCKED_PROFILE.requiredDependencyFamilies.length, 2);

console.log('ARM64 A64 decoder denominator (fixed provider + exhaustive candidate audit + dependency boundary): PASS');
