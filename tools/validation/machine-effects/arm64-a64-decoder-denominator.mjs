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
  ARM64_A64_SYSTEM_MNEMONIC_DENOMINATOR,
  arm64A64SystemEncodingCases,
  classifyArm64A64SystemEncoding,
  validateArm64A64SystemDenominator,
} from './arm64-a64-system-denominator.mjs';

export const ARM64_A64_DECODER_DENOMINATOR_SCHEMA = 'arm64-a64-decoder-denominator/v2';
export const ARM64_A64_DECODER_DENOMINATOR_ID = 'arm64:a64:locked-decoder-ownership:v2';
export const ARM64_A64_LOCKED_PROFILE_ID = 'arm64:a64:stage2-a2-production-effects:v2';
export const ARM64_A64_DECODER_AUDIT_SCHEMA = 'arm64-a64-decoder-ownership-audit/v1';

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

export const ARM64_A64_LOCKED_PROFILE = Object.freeze({
  profileId:ARM64_A64_LOCKED_PROFILE_ID,
  architectureProfileId:'arm64:a64',
  fullIsaCoverageIncluded:false,
  decoderProviderIdentity:ARM64_A64_DECODER_IDENTITY_LOCK.identityId,
  requiredCanonicalFamilies:ARM64_A64_CANONICAL_FAMILY_ORDER,
  resolvedIndependentFamilies:Object.freeze(['control','flags','fp','integer','system']),
  requiredDependencyFamilies:Object.freeze(['memory','simd']),
  explicitlyOutOfProfileExtensions:Object.freeze([
    'sve',
    'sme',
    'arm64e-pointer-authentication',
    'classic-a64-mnemonics-outside-locked-family-denominators',
  ]),
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
const SYSTEM_PROFILE_MNEMONICS = new Set(ARM64_A64_SYSTEM_MNEMONIC_DENOMINATOR);
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
      encodingMatches:Object.freeze([]),
    });
  }

  const matches = [];
  for (const { family, classify } of RESOLVED_CLASSIFIERS) {
    const encodingFamily = classify(value);
    if (encodingFamily) matches.push(Object.freeze({ family, encodingFamilyId:encodingFamily.id }));
  }
  const candidateFamilies = Object.freeze(matches.map(({ family }) => family));
  if (matches.length) {
    const rawOwner = matches[0].family;
    if (rawOwner === 'system') {
      const mnemonic = String(decodedMnemonic || '').trim().toLowerCase();
      if (!mnemonic) {
        return Object.freeze({
          word:value,
          scope:'decoder-mnemonic-required',
          topLevel,
          candidateFamilies,
          canonicalFamily:null,
          encodingMatches:Object.freeze(matches),
        });
      }
      if (MEMORY_CANONICAL_SYSTEM_MNEMONICS.has(mnemonic)) {
        return Object.freeze({
          word:value,
          scope:'dependency-pending',
          topLevel,
          candidateFamilies:Object.freeze([...candidateFamilies, 'memory']),
          canonicalFamily:'memory',
          encodingMatches:Object.freeze(matches),
        });
      }
      if (!SYSTEM_PROFILE_MNEMONICS.has(mnemonic)) {
        return Object.freeze({
          word:value,
          scope:'out-of-profile-unenumerated',
          topLevel,
          candidateFamilies,
          canonicalFamily:null,
          encodingMatches:Object.freeze(matches),
        });
      }
      return Object.freeze({
        word:value,
        scope:'in-profile-resolved',
        topLevel,
        candidateFamilies,
        canonicalFamily:'system',
        encodingMatches:Object.freeze(matches),
      });
    }
    return Object.freeze({
      word:value,
      scope:'in-profile-resolved',
      topLevel,
      candidateFamilies,
      canonicalFamily:rawOwner,
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
      encodingMatches:Object.freeze([]),
    });
  }
  return Object.freeze({
    word:value,
    scope:'out-of-profile-unenumerated',
    topLevel,
    candidateFamilies:Object.freeze([]),
    canonicalFamily:null,
    encodingMatches:Object.freeze([]),
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

export const ARM64_A64_CANDIDATE_CORPUS_LOCK = Object.freeze({
  candidateCaseCount:376_186,
  candidateUniqueWordCount:375_875,
  candidateSha256:'57f25255163e5194f7b53a0766444a479da2538b98dd1c84fb06104feb0f6590',
  candidateUniqueWordsSha256:'a752ffdc75e67302f32578f9c2697b586067db98b81686aa861e46b553d75e90',
  familyCaseCounts:Object.freeze({ control:21_306, flags:15_232, fp:8_417, integer:68_901, system:262_330 }),
  aliasOverlapCounts:Object.freeze({ 'flags+integer':12_992 }),
});

function candidateLine(family, item) {
  return `${family}\0${item.id}\0${item.familyId ?? '-'}\0${(item.word >>> 0).toString(16).padStart(8, '0')}\n`;
}

function hashSortedWords(words) {
  const hash = createHash('sha256');
  for (const word of [...words].sort()) hash.update(`${word}\n`);
  return hash.digest('hex');
}

export function buildArm64A64CandidateCorpusEvidence() {
  const candidateHash = createHash('sha256');
  const candidateWords = new Set();
  const familyCaseCounts = {};
  let flagsIntegerAliasOverlapCount = 0;
  let candidateCaseCount = 0;

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
      candidateHash.update(candidateLine(input.family, item));
      candidateWords.add((item.word >>> 0).toString(16).padStart(8, '0'));
      candidateCaseCount++;
      familyCount++;
    }
    if (familyCount !== input.expectedCaseCount) throw new Error(`arm64-decoder-denominator-generator-shrink:${input.family}:${familyCount}`);
    familyCaseCounts[input.family] = familyCount;
  }

  const evidence = Object.freeze({
    candidateCaseCount,
    candidateUniqueWordCount:candidateWords.size,
    candidateSha256:candidateHash.digest('hex'),
    candidateUniqueWordsSha256:hashSortedWords(candidateWords),
    familyCaseCounts:Object.freeze(familyCaseCounts),
    aliasOverlapCounts:Object.freeze({ 'flags+integer':flagsIntegerAliasOverlapCount }),
  });
  for (const key of ['candidateCaseCount','candidateUniqueWordCount','candidateSha256','candidateUniqueWordsSha256']) {
    if (evidence[key] !== ARM64_A64_CANDIDATE_CORPUS_LOCK[key]) throw new Error(`arm64-decoder-denominator-candidate-drift:${key}`);
  }
  for (const [family, count] of Object.entries(ARM64_A64_CANDIDATE_CORPUS_LOCK.familyCaseCounts)) {
    if (evidence.familyCaseCounts[family] !== count) throw new Error(`arm64-decoder-denominator-family-corpus-drift:${family}`);
  }
  for (const [overlap, count] of Object.entries(ARM64_A64_CANDIDATE_CORPUS_LOCK.aliasOverlapCounts)) {
    if (evidence.aliasOverlapCounts[overlap] !== count) throw new Error(`arm64-decoder-denominator-alias-overlap-drift:${overlap}`);
  }
  return evidence;
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

function rejectedCandidateKind(sourceFamily, item) {
  if (sourceFamily === 'integer' && item.familyId === 'abs-cssc') return 'provider-unsupported-architectural';
  if (sourceFamily === 'system') return 'invalid-or-reserved';
  return null;
}

export const ARM64_A64_DECODER_AUDIT_LOCK = Object.freeze({
  candidateCaseCount:376_186,
  decoderRecognizedCaseCount:376_139,
  decoderRejectedCaseCount:47,
  decoderRecognizedUniqueWordCount:375_828,
  decoderRecognizedUniqueWordsSha256:'204bf1935482a4c131b4a0fac6da13adf54b9e864559553b67795e0ff1e0bbb8',
  decoderAuditSha256:'de6882fa5b13b7f31480fb4089f76d537415e18262de81d5f306a62f72061d4d',
  decoderRejectedSha256:'5cdf9f730d4587ee7ec92b837a219db61ef9635dedaf99606a32ac887de86808',
  recognizedMnemonicCount:208,
  recognizedMnemonicsSha256:'dd421cadb32c76de18eae4ee444cf5a3e965a618e2330acf89eab3d98f0e01a9',
  scopeCounts:Object.freeze({
    'in-profile-resolved':343_236,
    'dependency-pending':65,
    'out-of-profile-unenumerated':32_838,
  }),
  resolvedOwnerCounts:Object.freeze({ control:21_306, flags:15_232, fp:8_417, integer:68_899, system:229_382 }),
  rejectedKindCounts:Object.freeze({ 'provider-unsupported-architectural':2, 'invalid-or-reserved':45 }),
});

function auditLine(sourceFamily, item, raw, classification) {
  const word = (item.word >>> 0).toString(16).padStart(8, '0');
  const mnemonic = String(raw.mnemonic || '').trim().toLowerCase();
  const opStr = String(raw.opStr || '');
  const matches = classification.encodingMatches.map(({ family }) => family).join('+') || '-';
  return `${sourceFamily}\0${item.id}\0${item.familyId ?? '-'}\0${word}\0${mnemonic}\0${opStr}\0${classification.scope}\0${classification.canonicalFamily ?? '-'}\0${matches}\n`;
}

function verifyResolvedOwner(item, raw, classification, effects) {
  const mnemonic = String(raw.mnemonic || '').trim().toLowerCase();
  if (effects == null) throw new Error(`arm64-valid-decoder-form-fell-through:${(item.word >>> 0).toString(16)}:${mnemonic}`);
  const allowedMetadataFamilies = OWNER_METADATA_FAMILIES[classification.canonicalFamily] || [];
  if (!allowedMetadataFamilies.includes(effects.metadata?.family)) {
    throw new Error(`arm64-decoder-owner-mismatch:${mnemonic}:${classification.canonicalFamily}:${effects.metadata?.family || 'none'}`);
  }
  if (!['exact','exact-with-intrinsic'].includes(effects.completeness)) {
    throw new Error(`arm64-decoder-owner-not-exact:${mnemonic}:${classification.canonicalFamily}:${effects.completeness}:${effects.unknownEffects?.reason || 'none'}`);
  }
}

function verifyDependencyDoesNotFallThrough(item, raw, classification, effects) {
  if (classification.canonicalFamily == null) return;
  const mnemonic = String(raw.mnemonic || '').trim().toLowerCase();
  if (effects == null) throw new Error(`arm64-dependency-decoder-form-fell-through:${(item.word >>> 0).toString(16)}:${mnemonic}:${classification.canonicalFamily}`);
  const allowedMetadataFamilies = OWNER_METADATA_FAMILIES[classification.canonicalFamily] || [];
  if (!allowedMetadataFamilies.includes(effects.metadata?.family)) {
    throw new Error(`arm64-dependency-owner-mismatch:${mnemonic}:${classification.canonicalFamily}:${effects.metadata?.family || 'none'}`);
  }
}

export function auditArm64A64DecoderOwnership({ decoderIdentity, decodeWord, liftDecoded }) {
  verifyArm64A64DecoderIdentity(decoderIdentity);
  if (typeof decodeWord !== 'function') throw new TypeError('arm64-decoder-audit-decode-word-required');
  if (typeof liftDecoded !== 'function') throw new TypeError('arm64-decoder-audit-lift-decoded-required');

  buildArm64A64CandidateCorpusEvidence();
  const auditHash = createHash('sha256');
  const rejectedHash = createHash('sha256');
  const recognizedWords = new Set();
  const recognizedMnemonics = new Set();
  const scopeCounts = {};
  const resolvedOwnerCounts = {};
  const rejectedKindCounts = {};
  let candidateCaseCount = 0;
  let decoderRecognizedCaseCount = 0;
  let decoderRejectedCaseCount = 0;

  for (const input of FAMILY_INPUTS) {
    for (const item of input.cases()) {
      candidateCaseCount++;
      const raw = decodeWord(item.word, Object.freeze({
        sourceFamily:input.family,
        caseId:item.id,
        familyId:item.familyId,
        caseIndex:candidateCaseCount,
      })) ?? null;
      const wordHex = (item.word >>> 0).toString(16).padStart(8, '0');
      if (raw == null) {
        decoderRejectedCaseCount++;
        const kind = rejectedCandidateKind(input.family, item);
        if (!kind) throw new Error(`arm64-decoder-unexpected-rejection:${input.family}:${item.id}:${wordHex}`);
        rejectedKindCounts[kind] = (rejectedKindCounts[kind] || 0) + 1;
        const line = `${input.family}\0${item.id}\0${item.familyId ?? '-'}\0${wordHex}\0${kind}\n`;
        auditHash.update(line);
        rejectedHash.update(line);
        continue;
      }
      if (raw.size != null && Number(raw.size) !== ARM64_A64_DECODER_IDENTITY_LOCK.instructionWidthBytes) {
        throw new Error(`arm64-decoder-width-drift:${input.family}:${item.id}:${raw.size}`);
      }
      const mnemonic = String(raw.mnemonic || '').trim().toLowerCase();
      if (!mnemonic) throw new Error(`arm64-decoder-empty-mnemonic:${input.family}:${item.id}`);
      decoderRecognizedCaseCount++;
      recognizedWords.add(wordHex);
      recognizedMnemonics.add(mnemonic);
      const classification = classifyArm64A64LockedScope(item.word, mnemonic);
      if (classification.scope === 'decoder-mnemonic-required') throw new Error(`arm64-decoder-mnemonic-classification-failed:${item.id}`);
      scopeCounts[classification.scope] = (scopeCounts[classification.scope] || 0) + 1;
      const effects = liftDecoded(raw, Object.freeze({
        sourceFamily:input.family,
        item,
        classification,
        caseIndex:candidateCaseCount,
      })) ?? null;
      if (classification.scope === 'in-profile-resolved') {
        resolvedOwnerCounts[classification.canonicalFamily] = (resolvedOwnerCounts[classification.canonicalFamily] || 0) + 1;
        verifyResolvedOwner(item, raw, classification, effects);
      } else if (classification.scope === 'dependency-pending') {
        verifyDependencyDoesNotFallThrough(item, raw, classification, effects);
      } else if (classification.scope === 'out-of-profile-unenumerated') {
        if (effects != null) {
          throw new Error(`arm64-out-of-profile-form-unexpectedly-owned:${wordHex}:${mnemonic}:${effects.metadata?.family || 'none'}`);
        }
      } else {
        throw new Error(`arm64-decoder-recognized-form-invalid-scope:${wordHex}:${mnemonic}:${classification.scope}`);
      }
      auditHash.update(auditLine(input.family, item, raw, classification));
    }
  }

  const mnemonicHash = createHash('sha256');
  for (const mnemonic of [...recognizedMnemonics].sort()) mnemonicHash.update(`${mnemonic}\n`);
  const evidence = Object.freeze({
    valid:true,
    schemaVersion:ARM64_A64_DECODER_AUDIT_SCHEMA,
    decoderIdentityId:ARM64_A64_DECODER_IDENTITY_LOCK.identityId,
    profileId:ARM64_A64_LOCKED_PROFILE.profileId,
    candidateCaseCount,
    decoderRecognizedCaseCount,
    decoderRejectedCaseCount,
    decoderRecognizedUniqueWordCount:recognizedWords.size,
    decoderRecognizedUniqueWordsSha256:hashSortedWords(recognizedWords),
    decoderAuditSha256:auditHash.digest('hex'),
    decoderRejectedSha256:rejectedHash.digest('hex'),
    recognizedMnemonicCount:recognizedMnemonics.size,
    recognizedMnemonicsSha256:mnemonicHash.digest('hex'),
    scopeCounts:Object.freeze(scopeCounts),
    resolvedOwnerCounts:Object.freeze(resolvedOwnerCounts),
    rejectedKindCounts:Object.freeze(rejectedKindCounts),
    resolvedOwnershipProof:true,
    negativeBoundaryProof:true,
    dependencyPendingNoNullProof:true,
    scopeShrinkGuard:true,
    corpusShrinkGuard:true,
  });
  assertArm64A64DecoderAuditLock(evidence);
  return evidence;
}

function sameCounts(observed, expected) {
  const observedKeys = Object.keys(observed || {}).sort();
  const expectedKeys = Object.keys(expected || {}).sort();
  return observedKeys.length === expectedKeys.length
    && observedKeys.every((key, index) => key === expectedKeys[index] && observed[key] === expected[key]);
}

export function assertArm64A64DecoderAuditLock(evidence) {
  if (!evidence || evidence.valid !== true || evidence.schemaVersion !== ARM64_A64_DECODER_AUDIT_SCHEMA) {
    throw new Error('arm64-decoder-audit-missing-or-invalid');
  }
  if (evidence.decoderIdentityId !== ARM64_A64_DECODER_IDENTITY_LOCK.identityId) throw new Error('arm64-decoder-audit-identity-drift');
  if (evidence.profileId !== ARM64_A64_LOCKED_PROFILE.profileId) throw new Error('arm64-decoder-audit-profile-drift');
  for (const key of [
    'candidateCaseCount','decoderRecognizedCaseCount','decoderRejectedCaseCount',
    'decoderRecognizedUniqueWordCount','decoderRecognizedUniqueWordsSha256','decoderAuditSha256',
    'decoderRejectedSha256','recognizedMnemonicCount','recognizedMnemonicsSha256',
  ]) {
    if (evidence[key] !== ARM64_A64_DECODER_AUDIT_LOCK[key]) throw new Error(`arm64-decoder-audit-drift:${key}`);
  }
  for (const [key, expected] of [
    ['scopeCounts', ARM64_A64_DECODER_AUDIT_LOCK.scopeCounts],
    ['resolvedOwnerCounts', ARM64_A64_DECODER_AUDIT_LOCK.resolvedOwnerCounts],
    ['rejectedKindCounts', ARM64_A64_DECODER_AUDIT_LOCK.rejectedKindCounts],
  ]) {
    if (!sameCounts(evidence[key], expected)) throw new Error(`arm64-decoder-audit-drift:${key}`);
  }
  for (const key of ['resolvedOwnershipProof','negativeBoundaryProof','dependencyPendingNoNullProof','scopeShrinkGuard','corpusShrinkGuard']) {
    if (evidence[key] !== true) throw new Error(`arm64-decoder-audit-proof-missing:${key}`);
  }
  return true;
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
  if (observed.machineEffectsSemanticVersion !== lock.machineEffectsSemanticVersion) throw new Error('arm64-machine-effects-semantic-version-drift');
  return true;
}

export const ARM64_A64_DECODER_DEPENDENCY_PROOF_SCHEMA = 'arm64-a64-decoder-family-proof/v2';

export function validateArm64A64DecoderDependencyProof(family, proof) {
  if (!ARM64_A64_LOCKED_PROFILE.requiredDependencyFamilies.includes(family) || !proof) return false;
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
    independentAuthority:true,
  };
  for (const [key, expected] of Object.entries(required)) if (proof[key] !== expected) return false;
  if (typeof proof.denominatorId !== 'string' || !proof.denominatorId.length || proof.denominatorId === ARM64_A64_DECODER_DENOMINATOR_ID) return false;
  if (typeof proof.denominatorAuthority !== 'string' || !proof.denominatorAuthority.startsWith('independent-')) return false;
  if (!Array.isArray(proof.oracleIds) || proof.oracleIds.length < 2 || new Set(proof.oracleIds).size !== proof.oracleIds.length) return false;
  if (proof.oracleIds.some((id) => String(id).includes('production-effect-registry'))) return false;
  if (typeof proof.lockedScopeId !== 'string' || !proof.lockedScopeId.length) return false;
  if (!Number.isSafeInteger(proof.encodingCaseCount) || proof.encodingCaseCount <= 0 || proof.encodingCaseCount !== proof.lockedEncodingCaseCount) return false;
  if (!/^[0-9a-f]{64}$/.test(proof.lockedCorpusSha256 || '') || proof.observedCorpusSha256 !== proof.lockedCorpusSha256) return false;
  return true;
}

function decoderAuditExact(audit) {
  try { return assertArm64A64DecoderAuditLock(audit); } catch { return false; }
}

export function validateArm64A64DecoderDenominator({ decoderAudit = null, dependencyProofs = {} } = {}) {
  const candidateCorpus = buildArm64A64CandidateCorpusEvidence();
  const decoderAuditObserved = decoderAuditExact(decoderAudit);
  const missingDependencies = ARM64_A64_LOCKED_PROFILE.requiredDependencyFamilies.filter(
    (family) => !validateArm64A64DecoderDependencyProof(family, dependencyProofs[family]),
  );
  const terminalEligible = decoderAuditObserved && missingDependencies.length === 0;
  return Object.freeze({
    valid:true,
    schemaVersion:ARM64_A64_DECODER_DENOMINATOR_SCHEMA,
    denominatorId:ARM64_A64_DECODER_DENOMINATOR_ID,
    profileId:ARM64_A64_LOCKED_PROFILE.profileId,
    architectureProfileId:ARM64_A64_LOCKED_PROFILE.architectureProfileId,
    denominatorAuthority:'independent-arm-encoding-family-union-plus-fixed-decoder-audit',
    decoderProvider:ARM64_A64_DECODER_IDENTITY_LOCK.provider,
    decoderIdentityId:ARM64_A64_DECODER_IDENTITY_LOCK.identityId,
    decoderIdentityLocked:true,
    architectureSemanticVersion:ARM64_A64_DECODER_IDENTITY_LOCK.machineEffectsSemanticVersion,
    canonicalFamilyOrder:ARM64_A64_CANONICAL_FAMILY_ORDER,
    candidateCorpus,
    requiredCanonicalFamilies:ARM64_A64_LOCKED_PROFILE.requiredCanonicalFamilies,
    decoderAuditObserved,
    missingDependencies:Object.freeze(missingDependencies),
    terminalEligible,
    validEncodingOwnershipProof:terminalEligible,
    fallbackNegativeProof:terminalEligible,
    scopeShrinkGuard:true,
    corpusShrinkGuard:true,
  });
}

export function assertArm64A64DecodedOwnership({ word, mnemonic, effects }) {
  const classification = classifyArm64A64LockedScope(word, mnemonic);
  if (classification.scope !== 'in-profile-resolved') return classification;
  verifyResolvedOwner({ word:Number(word) >>> 0 }, { mnemonic }, classification, effects);
  return classification;
}
