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
  ARM64_A64_DECODER_DENOMINATOR_ID,
  ARM64_A64_DECODER_DEPENDENCY_PROOF_SCHEMA,
  ARM64_A64_DECODER_IDENTITY_LOCK,
  ARM64_A64_LOCKED_PROFILE,
  ARM64_A64_RESOLVED_CORPUS_LOCK,
  assertArm64A64DecodedOwnership,
  buildArm64A64ResolvedCorpusEvidence,
  buildArm64CapstoneRegistryEvidence,
  classifyArm64A64LockedScope,
  classifyArm64A64TopLevel,
  validateArm64A64DecoderDenominator,
  verifyArm64A64DecoderIdentity,
} from '../../tools/validation/machine-effects/arm64-a64-decoder-denominator.mjs';
import { createCapstoneArm64Session } from './helpers/arm64-capstone-session.mjs';

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

const denominator = validateArm64A64DecoderDenominator();
assert.equal(denominator.denominatorId, ARM64_A64_DECODER_DENOMINATOR_ID);
assert.equal(denominator.denominatorAuthority, 'independent-arm-encoding-family-union');
assert.equal(denominator.decoderProvider, 'capstone/backend');
assert.equal(denominator.architectureSemanticVersion, '7');
assert.equal(denominator.scopeShrinkGuard, true);
assert.equal(denominator.corpusShrinkGuard, true);
assert.equal(denominator.terminalEligible, false, 'memory/SIMD are intentionally separate component dependencies');
assert.equal(denominator.validEncodingOwnershipProof, false);
assert.equal(denominator.fallbackNegativeProof, false);
assert.deepEqual(denominator.missingDependencies, ['memory','simd']);
assert.deepEqual(denominator.requiredCanonicalFamilies, ARM64_A64_CANONICAL_FAMILY_ORDER);
assert.deepEqual(arm64MachineEffectFamilies(), ARM64_A64_CANONICAL_FAMILY_ORDER, 'production owner precedence drifted');
assert.equal(ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, ARM64_A64_DECODER_IDENTITY_LOCK.machineEffectsSemanticVersion);

// The corpus is an independent union of the spec-derived family encoding
// discriminators, not an enumeration of the production effect registry.
const corpus = buildArm64A64ResolvedCorpusEvidence();
for (const key of [
  'architecturalCaseCount','architecturalUniqueWordCount','architecturalSha256','architecturalUniqueWordsSha256',
  'decoderRecognizedCaseCount','decoderRecognizedUniqueWordCount','decoderRecognizedSha256','decoderRecognizedUniqueWordsSha256',
]) assert.equal(corpus[key], ARM64_A64_RESOLVED_CORPUS_LOCK[key], key);
assert.deepEqual(corpus.familyCaseCounts, ARM64_A64_RESOLVED_CORPUS_LOCK.familyCaseCounts);
assert.deepEqual(corpus.aliasOverlapCounts, ARM64_A64_RESOLVED_CORPUS_LOCK.aliasOverlapCounts);
assert.equal(corpus.aliasOverlapCounts['flags+integer'], 12_992, 'CMP/CMN/TST aliases must remain precedence-sensitive');
assert.equal(corpus.architecturalCaseCount, 376_186);
assert.equal(corpus.decoderRecognizedCaseCount, 376_184);
assert.equal(corpus.architecturalCaseCount - corpus.decoderRecognizedCaseCount, 2, 'only Capstone-5 CSSC rows may be absent');

// Every bit31/op1 top-level cell must be classified.  This is the finite A64
// decoder-space partition that prevents an unmentioned region from becoming a
// hidden fallback bucket.
const topLevelCells = new Set();
const topLevelClasses = new Set();
for (const bit31 of [0,1]) {
  for (let op1 = 0; op1 < 16; op1++) {
    const word = ((bit31 << 31) | (op1 << 25)) >>> 0;
    const cell = classifyArm64A64TopLevel(word);
    assert.equal(cell.bit31, bit31);
    assert.equal(cell.op1, op1);
    assert.ok(cell.classId);
    assert.ok(['invalid-or-reserved','out-of-profile-extension','classic-a64-region'].includes(cell.disposition));
    topLevelCells.add(`${cell.bit31}:${cell.op1}`);
    topLevelClasses.add(cell.classId);
  }
}
assert.equal(topLevelCells.size, 32);
assert.deepEqual([...topLevelClasses].sort(), [
  'branch-exception-system','data-processing-immediate','data-processing-register','load-store',
  'reserved','scalar-fp-advanced-simd','sme','sve','unallocated',
].sort());

const session = await createCapstoneArm64Session();
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

  function decodeAndLift(word, label) {
    const raw = session.decode(bytes32(word), 0x400000n)[0] ?? null;
    if (!raw) return { raw:null, effects:null };
    return { raw, effects:liftArm64MachineEffects(decodedInstruction(raw, `arm64-decoder-denominator:${label}`)) };
  }

  // Alias-sensitive resolved witnesses.  The raw encoding, not mnemonic text,
  // chooses the independent family; production precedence then chooses the one
  // canonical owner.  CMP overlaps integer ADD/SUB encoding space but belongs
  // to flags.  DMB is decoded from system space but is canonically memory/atomic.
  const resolvedWitnesses = [
    [0xeb01001f, 'cmp', 'flags'],
    [0xd65f03c0, 'ret', 'control'],
    [0x1e222820, 'fadd', 'fp'],
    [0x8b020020, 'add', 'integer'],
    [0xd503201f, 'nop', 'system'],
    [0xd5033fbf, 'dmb', 'memory'],
    [0xd5033f9f, 'dsb', 'memory'],
    [0xd5033fdf, 'isb', 'memory'],
    [0xd5033f5f, 'clrex', 'memory'],
  ];
  for (const [word, expectedMnemonic, expectedOwner] of resolvedWitnesses) {
    const { raw, effects } = decodeAndLift(word, expectedMnemonic);
    assert.ok(raw, `${expectedMnemonic}:decoder-recognized`);
    assert.equal(raw.mnemonic, expectedMnemonic);
    const classification = assertArm64A64DecodedOwnership({ word, mnemonic:raw.mnemonic, effects });
    assert.equal(classification.scope, 'in-profile-resolved');
    assert.equal(classification.canonicalFamily, expectedOwner);
    assert.ok(effects, `${expectedMnemonic}:must not fall through`);
    assert.ok(['exact','exact-with-intrinsic'].includes(effects.completeness), `${expectedMnemonic}:${effects.unknownEffects?.reason}`);
  }
  const cmpOverlap = classifyArm64A64LockedScope(0xeb01001f, 'cmp');
  assert.deepEqual(cmpOverlap.candidateFamilies, ['flags','integer']);
  assert.equal(cmpOverlap.canonicalFamily, 'flags');

  // A valid, resolved in-profile decoder form reaching null is a hard failure.
  assert.throws(
    () => assertArm64A64DecodedOwnership({ word:0x8b020020, mnemonic:'add', effects:null }),
    /valid-decoder-form-fell-through/,
  );

  // Memory and SIMD are not laundered into "out of profile" while their exact
  // component denominators are pending.  Their regions remain explicit blockers.
  for (const [word, mnemonic] of [[0xf9400020,'ldr'],[0x4e22d420,'fadd']]) {
    const { raw, effects } = decodeAndLift(word, `dependency:${mnemonic}`);
    assert.ok(raw);
    assert.equal(raw.mnemonic, mnemonic);
    assert.equal(classifyArm64A64LockedScope(word, raw.mnemonic).scope, 'dependency-pending');
    assert.ok(effects, `${mnemonic}:current production path exists but is not promoted to terminal proof here`);
  }

  // Negative boundary: invalid/reserved or explicitly excluded decoder space may
  // fall through; a valid recognized classic instruction not enumerated by the
  // locked profile is labelled out-of-profile rather than hidden in fallback.
  const unallocated = decodeAndLift(0x02000000, 'unallocated');
  assert.equal(unallocated.raw, null);
  assert.equal(classifyArm64A64LockedScope(0x02000000).scope, 'invalid-or-reserved');

  const udf = decodeAndLift(0x00000000, 'udf');
  assert.equal(udf.raw?.mnemonic, 'udf');
  assert.equal(udf.effects, null);
  assert.equal(classifyArm64A64LockedScope(0x00000000, 'udf').scope, 'invalid-or-reserved');

  for (const [word, mnemonic, expectedScope] of [
    [0x65bbf753, 'fnmsb', 'out-of-profile-extension'],
    [0xa0e3d8a4, 'sumopa', 'out-of-profile-extension'],
    [0xdac01420, 'cls', 'out-of-profile-unenumerated'],
    [0x1ac04020, 'crc32b', 'out-of-profile-unenumerated'],
  ]) {
    const { raw, effects } = decodeAndLift(word, `excluded:${mnemonic}`);
    assert.ok(raw, `${mnemonic}:must be a decoder-recognized negative witness`);
    assert.equal(raw.mnemonic, mnemonic);
    assert.equal(classifyArm64A64LockedScope(word, raw.mnemonic).scope, expectedScope);
    if (expectedScope === 'out-of-profile-unenumerated') assert.equal(effects, null, `${mnemonic}:expected current top-level fallback witness`);
  }
} finally {
  session.close();
}

// Composition contract for the separate memory/SIMD lanes.  Synthetic objects
// exercise only the adapter shape; they are not repository proof evidence.
const dependencyContract = (canonicalFamily) => Object.freeze({
  schemaVersion:ARM64_A64_DECODER_DEPENDENCY_PROOF_SCHEMA,
  canonicalFamily,
  profileId:'arm64:a64',
  coverageState:'exact',
  decoderProvider:'capstone/backend',
  decoderIdentityId:ARM64_A64_DECODER_IDENTITY_LOCK.identityId,
  denominatorId:`synthetic-contract:${canonicalFamily}`,
  denominatorAuthority:'synthetic-independent-contract-test',
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
const memoryContract = dependencyContract('memory');
assert.deepEqual(
  validateArm64A64DecoderDenominator({ dependencyProofs:{ memory:memoryContract } }).missingDependencies,
  ['simd'],
);
for (const damaged of [
  { ...memoryContract, observedCorpusSha256:'b'.repeat(64) },
  { ...memoryContract, encodingCaseCount:16 },
  { ...memoryContract, denominatorAuthority:'production-effect-registry' },
  { ...memoryContract, decoderIdentityId:'other-decoder' },
]) {
  assert.deepEqual(
    validateArm64A64DecoderDenominator({ dependencyProofs:{ memory:damaged } }).missingDependencies,
    ['memory','simd'],
    'dependency scope/corpus/decoder drift must remain blocking',
  );
}
const contractComplete = validateArm64A64DecoderDenominator({
  dependencyProofs:{ memory:memoryContract, simd:dependencyContract('simd') },
});
assert.equal(contractComplete.terminalEligible, true);
assert.equal(contractComplete.validEncodingOwnershipProof, true);
assert.equal(contractComplete.fallbackNegativeProof, true);
assert.equal(ARM64_A64_LOCKED_PROFILE.requiredDependencyFamilies.length, 2);

console.log('ARM64 A64 decoder denominator (locked provider/profile/corpus + fallback boundary): PASS');
