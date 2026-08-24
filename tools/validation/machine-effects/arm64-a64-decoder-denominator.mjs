import { createHash } from 'node:crypto';

import {
  ARM64_A64_CONTROL_DENOMINATOR_ID,
  arm64A64ControlEncodingCases,
  classifyArm64A64ControlEncoding,
  validateArm64A64ControlDenominator,
} from './arm64-a64-control-denominator.mjs';
import {
  ARM64_A64_FLAGS_DENOMINATOR_ID,
  arm64A64FlagEncodingCases,
  classifyArm64A64FlagEncoding,
  validateArm64A64FlagsDenominator,
} from './arm64-a64-flags-denominator.mjs';
import {
  ARM64_A64_FP_DENOMINATOR_ID,
  arm64A64FpEncodingCases,
  classifyArm64A64FpEncoding,
  validateArm64A64FpDenominator,
} from './arm64-a64-fp-denominator.mjs';
import {
  ARM64_A64_INTEGER_DENOMINATOR_ID,
  arm64A64IntegerEncodingCases,
  classifyArm64A64IntegerEncoding,
  validateArm64A64IntegerDenominator,
} from './arm64-a64-integer-denominator.mjs';
import {
  ARM64_A64_SYSTEM_DENOMINATOR_ID,
  arm64A64SystemEncodingCases,
  classifyArm64A64SystemEncoding,
  validateArm64A64SystemDenominator,
} from './arm64-a64-system-denominator.mjs';

export const ARM64_A64_DECODER_DENOMINATOR_SCHEMA = 'arm64-a64-decoder-denominator/v1';
export const ARM64_A64_DECODER_DENOMINATOR_ID = 'arm64:a64:locked-decoder-ownership:v1';
export const ARM64_A64_LOCKED_PROFILE_ID = 'arm64:a64:stage2-a2-production-effects:v1';

export const ARM64_A64_CANONICAL_FAMILY_ORDER = Object.freeze([
  'flags', 'control', 'memory', 'simd', 'fp', 'integer', 'system',
]);

export const ARM64_A64_DECODER_IDENTITY_LOCK = Object.freeze({
  identityId:'capstone/backend:arm64:a64:5.0:cb88f8a5:2e71bc20:6b108b95',
  provider:'capstone/backend',
  architecture:'arm64',
  mode:'a64',
  instructionWidthBytes:4,
  byteOrder:'little-endian',
  capstoneApi:Object.freeze({ major:5, minor:0, packed:1280 }),
  artifacts:Object.freeze({
    'capstone.js':'cb88f8a55326cc19493db560a1d14809dc84fbe36e126d50b8acb84df2299ca8',
    'capstone.wasm':'2e71bc203418c273c10c9f21fece3a000a616c96810839dc83eda4c5ca86bf2e',
  }),
  instructionRegistry:Object.freeze({
    firstId:1,
    lastId:1288,
    count:1288,
    firstName:'abs',
    lastName:'tlbi',
    sha256:'6b108b95bda1750cfbcde30a684dc8a8154e1fbd9e6aaa9dfeb3f87cd033be58',
  }),
  machineEffectsSemanticVersion:'7',
});

// This profile is deliberately narrower than the complete Arm A64 ISA.  It is
// the locked Stage2 A2 production-effect profile: exact independent encoding
// denominators plus the separately-owned memory/SIMD denominators.  SVE, SME,
// Arm64e pointer-authentication and unenumerated classic A64 extensions are not
// silently treated as covered.  A decoder upgrade cannot expand this profile
// because provider artifacts/API/registry and every included corpus are locked.
export const ARM64_A64_LOCKED_PROFILE = Object.freeze({
  profileId:ARM64_A64_LOCKED_PROFILE_ID,
  architectureProfileId:'arm64:a64',
  fullIsaCoverageIncluded:false,
  requiredCanonicalFamilies:ARM64_A64_CANONICAL_FAMILY_ORDER,
  resolvedIndependentFamilies:Object.freeze(['control','flags','fp','integer','system']),
  requiredDependencyFamilies:Object.freeze(['memory','simd']),
  explicitlyOutOfProfileExtensions:Object.freeze(['sve','sme','arm64e-pointer-authentication']),
});

const TOP_LEVEL_CLASS_BY_OP1 = Object.freeze([
  'special-0000',
  'unallocated',
  'sve',
  'unallocated',
  'load-store',
  'data-processing-register',
  'load-store',
  'scalar-fp-advanced-simd',
  'data-processing-immediate',
  'data-processing-immediate',
  'branch-exception-system',
  'branch-exception-system',
  'load-store',
  'data-processing-register',
  'load-store',
  'scalar-fp-advanced-simd',
]);

const TOP_LEVEL_ALLOWED_FAMILIES = Object.freeze({
  'data-processing-immediate':Object.freeze(['flags','integer']),
  'branch-exception-system':Object.freeze(['control','memory','system']),
  'load-store':Object.freeze(['memory','simd']),
  'data-processing-register':Object.freeze(['flags','integer']),
  'scalar-fp-advanced-simd':Object.freeze(['fp','simd']),
});

export function classifyArm64A64TopLevel(word) {
  const value = Number(word) >>> 0;
  const op1 = (value >>> 25) & 0xf;
  const bit31 = value >>> 31;
  const rawClass = TOP_LEVEL_CLASS_BY_OP1[op1];
  if (rawClass === 'special-0000') {
    return Object.freeze({
      bit31,
      op1,
      classId:bit31 ? 'sme' : 'reserved',
      disposition:bit31 ? 'out-of-profile-extension' : 'invalid-or-reserved',
      allowedFamilies:Object.freeze([]),
    });
  }
  if (rawClass === 'unallocated') {
    return Object.freeze({ bit31, op1, classId:rawClass, disposition:'invalid-or-reserved', allowedFamilies:Object.freeze([]) });
  }
  if (rawClass === 'sve') {
    return Object.freeze({ bit31, op1, classId:rawClass, disposition:'out-of-profile-extension', allowedFamilies:Object.freeze([]) });
  }
  return Object.freeze({
    bit31,
    op1,
    classId:rawClass,
    disposition:'classic-a64-region',
    allowedFamilies:TOP_LEVEL_ALLOWED_FAMILIES[rawClass],
  });
}

const RESOLVED_CLASSIFIERS = Object.freeze([
  Object.freeze({ family:'flags', classify:classifyArm64A64FlagEncoding }),
  Object.freeze({ family:'control', classify:classifyArm64A64ControlEncoding }),
  Object.freeze({ family:'fp', classify:classifyArm64A64FpEncoding }),
  Object.freeze({ family:'integer', classify:classifyArm64A64IntegerEncoding }),
  Object.freeze({ family:'system', classify:classifyArm64A64SystemEncoding }),
]);
const MEMORY_CANONICAL_SYSTEM_MNEMONICS = new Set(['dmb','dsb','isb','clrex']);

export function classifyArm64A64LockedScope(word, decodedMnemonic = null) {
  const value = Number(word) >>> 0;
  const topLevel = classifyArm64A64TopLevel(value);
  if (topLevel.disposition !== 'classic-a64-region') {
    return Object.freeze({
      word:value,
      scope:topLevel.disposition,
      topLevel,
      candidateFamilies:Object.freeze([]),
      canonicalFamily:null,
    });
  }

  const matches = [];
  for (const { family, classify } of RESOLVED_CLASSIFIERS) {
    const encodingFamily = classify(value);
    if (encodingFamily) matches.push(Object.freeze({ family, encodingFamilyId:encodingFamily.id }));
  }
  const candidateFamilies = Object.freeze(matches.map(({ family }) => family));
  if (matches.length) {
    let canonicalFamily = matches[0].family;
    if (canonicalFamily === 'system' && MEMORY_CANONICAL_SYSTEM_MNEMONICS.has(String(decodedMnemonic || '').toLowerCase())) {
      canonicalFamily = 'memory';
    }
    return Object.freeze({
      word:value,
      scope:'in-profile-resolved',
      topLevel,
      candidateFamilies,
      canonicalFamily,
      encodingMatches:Object.freeze(matches),
    });
  }

  const unresolved = topLevel.allowedFamilies.filter((family) => ARM64_A64_LOCKED_PROFILE.requiredDependencyFamilies.includes(family));
  if (unresolved.length) {
    return Object.freeze({
      word:value,
      scope:'dependency-pending',
      topLevel,
      candidateFamilies:Object.freeze(unresolved),
      canonicalFamily:null,
    });
  }
  return Object.freeze({
    word:value,
    scope:'out-of-profile-unenumerated',
    topLevel,
    candidateFamilies:Object.freeze([]),
    canonicalFamily:null,
  });
}

const FAMILY_INPUTS = Object.freeze([
  Object.freeze({
    family:'control', denominatorId:ARM64_A64_CONTROL_DENOMINATOR_ID,
    validate:validateArm64A64ControlDenominator, cases:arm64A64ControlEncodingCases,
    expectedCaseCount:21_306,
  }),
  Object.freeze({
    family:'flags', denominatorId:ARM64_A64_FLAGS_DENOMINATOR_ID,
    validate:validateArm64A64FlagsDenominator, cases:arm64A64FlagEncodingCases,
    expectedCaseCount:15_232,
  }),
  Object.freeze({
    family:'fp', denominatorId:ARM64_A64_FP_DENOMINATOR_ID,
    validate:validateArm64A64FpDenominator, cases:arm64A64FpEncodingCases,
    expectedCaseCount:8_417,
  }),
  Object.freeze({
    family:'integer', denominatorId:ARM64_A64_INTEGER_DENOMINATOR_ID,
    validate:validateArm64A64IntegerDenominator, cases:arm64A64IntegerEncodingCases,
    expectedCaseCount:68_901,
  }),
  Object.freeze({
    family:'system', denominatorId:ARM64_A64_SYSTEM_DENOMINATOR_ID,
    validate:validateArm64A64SystemDenominator, cases:arm64A64SystemEncodingCases,
    expectedCaseCount:262_330,
  }),
]);

export const ARM64_A64_RESOLVED_CORPUS_LOCK = Object.freeze({
  architecturalCaseCount:376_186,
  architecturalUniqueWordCount:375_875,
  architecturalSha256:'57f25255163e5194f7b53a0766444a479da2538b98dd1c84fb06104feb0f6590',
  architecturalUniqueWordsSha256:'a752ffdc75e67302f32578f9c2697b586067db98b81686aa861e46b553d75e90',
  decoderRecognizedCaseCount:376_184,
  decoderRecognizedUniqueWordCount:375_873,
  decoderRecognizedSha256:'faee164db1f2ef75b9a7979658b635925cdc6501e1fef504ebed64f44a28f860',
  decoderRecognizedUniqueWordsSha256:'25bfa6979828b8e1c0f9c8a7fce7caa08e301e1eaa41288ea85b4229efb1f5c0',
  familyCaseCounts:Object.freeze({ control:21_306, flags:15_232, fp:8_417, integer:68_901, system:262_330 }),
  aliasOverlapCounts:Object.freeze({ 'flags+integer':12_992 }),
  // CSSC ABS belongs to the independent architectural integer denominator but
  // Capstone 5.0 does not recognize these two forms.  Keeping them in the
  // architectural hash while excluding them from the decoder-recognized hash
  // prevents a decoder upgrade from silently changing the proof population.
  providerUnsupportedArchitecturalRows:Object.freeze(['integer:abs-cssc:0','integer:abs-cssc:1']),
});

function corpusLine(family, item) {
  return `${family}\0${item.id}\0${item.familyId ?? '-'}\0${(item.word >>> 0).toString(16).padStart(8, '0')}\n`;
}
function providerUnsupportedRow(family, item) {
  return family === 'integer' && item.familyId === 'abs-cssc';
}

export function buildArm64A64ResolvedCorpusEvidence() {
  const architecturalHash = createHash('sha256');
  const decoderHash = createHash('sha256');
  const architecturalWords = new Set();
  const decoderWords = new Set();
  const familyCaseCounts = {};
  let flagsIntegerAliasOverlapCount = 0;
  let architecturalCaseCount = 0;
  let decoderRecognizedCaseCount = 0;

  for (const input of FAMILY_INPUTS) {
    const proof = input.validate();
    if (!proof?.valid || proof.denominatorId !== input.denominatorId || proof.profileId !== 'arm64:a64') {
      throw new Error(`arm64-decoder-denominator-invalid-family-proof:${input.family}`);
    }
    if (proof.encodingCaseCount !== input.expectedCaseCount) {
      throw new Error(`arm64-decoder-denominator-family-corpus-shrink:${input.family}:${proof.encodingCaseCount}:${input.expectedCaseCount}`);
    }
    let familyCount = 0;
    for (const item of input.cases()) {
      const topLevel = classifyArm64A64TopLevel(item.word);
      if (topLevel.disposition !== 'classic-a64-region' || !topLevel.allowedFamilies.includes(input.family)) {
        throw new Error(`arm64-decoder-denominator-top-level-scope-drift:${input.family}:${item.id}:${topLevel.classId}`);
      }
      if (input.family === 'flags' && classifyArm64A64IntegerEncoding(item.word)) flagsIntegerAliasOverlapCount++;
      const line = corpusLine(input.family, item);
      const wordHex = (item.word >>> 0).toString(16).padStart(8, '0');
      architecturalHash.update(line);
      architecturalWords.add(wordHex);
      architecturalCaseCount++;
      familyCount++;
      if (!providerUnsupportedRow(input.family, item)) {
        decoderHash.update(line);
        decoderWords.add(wordHex);
        decoderRecognizedCaseCount++;
      }
    }
    if (familyCount !== input.expectedCaseCount) throw new Error(`arm64-decoder-denominator-generator-shrink:${input.family}:${familyCount}`);
    familyCaseCounts[input.family] = familyCount;
  }

  const uniqueHash = (words) => {
    const hash = createHash('sha256');
    for (const word of [...words].sort()) hash.update(`${word}\n`);
    return hash.digest('hex');
  };
  const evidence = Object.freeze({
    architecturalCaseCount,
    architecturalUniqueWordCount:architecturalWords.size,
    architecturalSha256:architecturalHash.digest('hex'),
    architecturalUniqueWordsSha256:uniqueHash(architecturalWords),
    decoderRecognizedCaseCount,
    decoderRecognizedUniqueWordCount:decoderWords.size,
    decoderRecognizedSha256:decoderHash.digest('hex'),
    decoderRecognizedUniqueWordsSha256:uniqueHash(decoderWords),
    familyCaseCounts:Object.freeze(familyCaseCounts),
    aliasOverlapCounts:Object.freeze({ 'flags+integer':flagsIntegerAliasOverlapCount }),
  });
  for (const key of [
    'architecturalCaseCount','architecturalUniqueWordCount','architecturalSha256','architecturalUniqueWordsSha256',
    'decoderRecognizedCaseCount','decoderRecognizedUniqueWordCount','decoderRecognizedSha256','decoderRecognizedUniqueWordsSha256',
  ]) if (evidence[key] !== ARM64_A64_RESOLVED_CORPUS_LOCK[key]) throw new Error(`arm64-decoder-denominator-corpus-drift:${key}`);
  for (const [family, count] of Object.entries(ARM64_A64_RESOLVED_CORPUS_LOCK.familyCaseCounts)) {
    if (evidence.familyCaseCounts[family] !== count) throw new Error(`arm64-decoder-denominator-family-corpus-drift:${family}`);
  }
  for (const [overlap, count] of Object.entries(ARM64_A64_RESOLVED_CORPUS_LOCK.aliasOverlapCounts)) {
    if (evidence.aliasOverlapCounts[overlap] !== count) throw new Error(`arm64-decoder-denominator-alias-overlap-drift:${overlap}`);
  }
  return evidence;
}

export function buildArm64CapstoneRegistryEvidence(instructionName, maxInstructionId = 4096) {
  if (typeof instructionName !== 'function') throw new TypeError('arm64-capstone-instruction-name-function-required');
  const hash = createHash('sha256');
  const names = [];
  let terminator = null;
  for (let id = 1; id <= maxInstructionId; id++) {
    const name = instructionName(id);
    if (!name) { terminator = id; break; }
    const normalized = String(name).toLowerCase();
    names.push(normalized);
    hash.update(`${id}:${normalized}\n`);
  }
  if (terminator == null) throw new Error('arm64-capstone-registry-unterminated');
  for (let id = terminator + 1; id < terminator + 16; id++) {
    if (instructionName(id)) throw new Error(`arm64-capstone-registry-hole:${terminator}:${id}`);
  }
  return Object.freeze({
    firstId:names.length ? 1 : null,
    lastId:names.length,
    count:names.length,
    firstName:names[0] ?? null,
    lastName:names.at(-1) ?? null,
    sha256:hash.digest('hex'),
  });
}

export function verifyArm64A64DecoderIdentity(observed) {
  const lock = ARM64_A64_DECODER_IDENTITY_LOCK;
  if (!observed || observed.provider !== lock.provider || observed.architecture !== lock.architecture || observed.mode !== lock.mode) {
    throw new Error('arm64-decoder-provider-identity-drift');
  }
  for (const key of ['major','minor','packed']) {
    if (observed.capstoneApi?.[key] !== lock.capstoneApi[key]) throw new Error(`arm64-decoder-api-version-drift:${key}`);
  }
  for (const [name, digest] of Object.entries(lock.artifacts)) {
    if (observed.artifacts?.[name] !== digest) throw new Error(`arm64-decoder-artifact-drift:${name}`);
  }
  for (const [key, expected] of Object.entries(lock.instructionRegistry)) {
    if (observed.instructionRegistry?.[key] !== expected) throw new Error(`arm64-decoder-registry-drift:${key}`);
  }
  if (observed.machineEffectsSemanticVersion !== lock.machineEffectsSemanticVersion) {
    throw new Error('arm64-machine-effects-semantic-version-drift');
  }
  return true;
}

export const ARM64_A64_DECODER_DEPENDENCY_PROOF_SCHEMA = 'arm64-a64-decoder-family-proof/v1';

function dependencyExact(family, proof) {
  if (!proof) return false;
  const required = {
    schemaVersion:ARM64_A64_DECODER_DEPENDENCY_PROOF_SCHEMA,
    canonicalFamily:family,
    profileId:'arm64:a64',
    coverageState:'exact',
    decoderProvider:'capstone/backend',
    decoderIdentityId:ARM64_A64_DECODER_IDENTITY_LOCK.identityId,
    validEncodingOwnershipProof:true,
    fallbackNegativeProof:true,
    scopeShrinkGuard:true,
    corpusShrinkGuard:true,
  };
  for (const [key, expected] of Object.entries(required)) if (proof[key] !== expected) return false;
  if (typeof proof.denominatorId !== 'string' || !proof.denominatorId.length) return false;
  if (typeof proof.denominatorAuthority !== 'string' || !proof.denominatorAuthority.length
    || proof.denominatorAuthority === 'production-effect-registry') return false;
  if (typeof proof.lockedScopeId !== 'string' || !proof.lockedScopeId.length) return false;
  if (!Number.isSafeInteger(proof.encodingCaseCount) || proof.encodingCaseCount <= 0
    || proof.encodingCaseCount !== proof.lockedEncodingCaseCount) return false;
  if (!/^[0-9a-f]{64}$/.test(proof.lockedCorpusSha256 || '')
    || proof.observedCorpusSha256 !== proof.lockedCorpusSha256) return false;
  return true;
}

export function validateArm64A64DecoderDenominator({ dependencyProofs = {} } = {}) {
  const corpus = buildArm64A64ResolvedCorpusEvidence();
  const missingDependencies = ARM64_A64_LOCKED_PROFILE.requiredDependencyFamilies.filter(
    (family) => !dependencyExact(family, dependencyProofs[family]),
  );
  return Object.freeze({
    valid:true,
    schemaVersion:ARM64_A64_DECODER_DENOMINATOR_SCHEMA,
    denominatorId:ARM64_A64_DECODER_DENOMINATOR_ID,
    profileId:ARM64_A64_LOCKED_PROFILE.profileId,
    architectureProfileId:ARM64_A64_LOCKED_PROFILE.architectureProfileId,
    denominatorAuthority:'independent-arm-encoding-family-union',
    decoderProvider:ARM64_A64_DECODER_IDENTITY_LOCK.provider,
    decoderIdentityLocked:true,
    architectureSemanticVersion:ARM64_A64_DECODER_IDENTITY_LOCK.machineEffectsSemanticVersion,
    canonicalFamilyOrder:ARM64_A64_CANONICAL_FAMILY_ORDER,
    resolvedCorpus:corpus,
    requiredCanonicalFamilies:ARM64_A64_LOCKED_PROFILE.requiredCanonicalFamilies,
    missingDependencies:Object.freeze(missingDependencies),
    terminalEligible:missingDependencies.length === 0,
    validEncodingOwnershipProof:missingDependencies.length === 0,
    fallbackNegativeProof:missingDependencies.length === 0,
    scopeShrinkGuard:true,
    corpusShrinkGuard:true,
  });
}

const OWNER_METADATA_FAMILIES = Object.freeze({
  flags:Object.freeze(['flags']),
  control:Object.freeze(['control']),
  memory:Object.freeze(['arm64-memory','arm64-atomic']),
  simd:Object.freeze(['arm64-simd']),
  fp:Object.freeze(['arm64-fp']),
  integer:Object.freeze(['integer']),
  system:Object.freeze(['arm64-system']),
});

export function assertArm64A64DecodedOwnership({ word, mnemonic, effects }) {
  const classification = classifyArm64A64LockedScope(word, mnemonic);
  if (classification.scope !== 'in-profile-resolved') return classification;
  if (effects == null) throw new Error(`arm64-valid-decoder-form-fell-through:${(Number(word) >>> 0).toString(16)}:${mnemonic}`);
  const allowedMetadataFamilies = OWNER_METADATA_FAMILIES[classification.canonicalFamily] || [];
  if (!allowedMetadataFamilies.includes(effects.metadata?.family)) {
    throw new Error(`arm64-decoder-owner-mismatch:${mnemonic}:${classification.canonicalFamily}:${effects.metadata?.family || 'none'}`);
  }
  return classification;
}
