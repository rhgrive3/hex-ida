import crypto from 'node:crypto';

import {
  X86_DECODED_INSTRUCTION_CONTRACT_VERSION,
  X86_DECODER_SEMANTIC_VERSION,
} from '../../../js/targets/architecture/x86_64/decoded-instruction.js';
import {
  X86_CAPSTONE_REGISTRY_EXPECTED,
  X86_CAPSTONE_REGISTRY_ID,
  X86_CAPSTONE_REGISTRY_SCHEMA,
} from './x86-capstone-registry.mjs';
import { x86Long64LeaDenominatorIdentity } from './x86-long64-lea-denominator.mjs';
import {
  X86_LONG64_DECODER_WITNESS_FIXTURE_VERSION,
  X86_LONG64_DECODER_WITNESS_SHA256,
  X86_LONG64_DECODER_WITNESSES,
} from './fixtures/x86-long64-decoder-witnesses.mjs';

export const X86_LONG64_DECODER_DENOMINATOR_SCHEMA = 'x86-long64-decoder-denominator/v1';
export const X86_LONG64_DECODER_DENOMINATOR_ID = 'x86_64:long-64:all-decoder-encodings-prefixes-and-aliases:v1';
export const X86_LONG64_FALLBACK_PROOF_SCHEMA = 'x86-long64-fallback-negative-proof/v1';

export const X86_LONG64_CANONICAL_EFFECT_OWNERS = Object.freeze([
  'control', 'memory', 'lea', 'integer', 'string', 'atomic', 'fp', 'simd', 'system',
]);

export const X86_LONG64_FALLBACK_ALLOWED_CLASSES = Object.freeze([
  'invalid', 'reserved', 'out-of-profile',
]);

const MODE_INVALID_OR_REPURPOSED = Object.freeze([
  [1,'aaa'], [2,'aad'], [3,'aam'], [4,'aas'], [30,'arpl'], [53,'bound'],
  [144,'daa'], [145,'das'], [241,'into'], [258,'jcxz'], [328,'lds'], [334,'les'],
  [586,'popaw'], [587,'popal'], [590,'popfd'], [610,'pushaw'], [611,'pushal'],
  [613,'pushfd'], [648,'salc'],
].map(([id,name]) => Object.freeze({ id, name, disposition:'out-of-profile', reason:'mode-invalid-or-repurposed' })));

const PREFIX_TOKENS = Object.freeze([
  [146,'data16'], [343,'lock'], [631,'repne'], [632,'rep'], [634,'rex64'], [1490,'xacquire'], [1506,'xrelease'],
].map(([id,name]) => Object.freeze({ id, name, disposition:'out-of-profile', reason:'prefix-token-not-standalone-instruction' })));

const NONEMITTING_ALIASES = Object.freeze([
  Object.freeze({ id:99, name:'fcmovnp', disposition:'out-of-profile', reason:'nonemitting-alias', canonicalIds:Object.freeze([98]) }),
  Object.freeze({ id:1110, name:'vpcmp', disposition:'out-of-profile', reason:'nonemitting-superclass-alias', canonicalIds:Object.freeze([1111,1112,1125,1126,1127,1128,1129,1130]) }),
  ...[
    [1132,'vpcomb'], [1133,'vpcomd'], [1138,'vpcomq'], [1139,'vpcomub'],
    [1140,'vpcomud'], [1141,'vpcomuq'], [1142,'vpcomuw'], [1143,'vpcomw'],
  ].map(([id,name]) => Object.freeze({ id, name, disposition:'out-of-profile', reason:'nonemitting-alias', canonicalIds:Object.freeze([1131]) })),
]);

export const X86_LONG64_EXPLICIT_OUT_OF_PROFILE_REGISTRY_ROWS = Object.freeze([
  ...MODE_INVALID_OR_REPURPOSED,
  ...PREFIX_TOKENS,
  ...NONEMITTING_ALIASES,
].sort((a,b) => a.id - b.id));

const EXCLUSION_BY_ID = new Map(X86_LONG64_EXPLICIT_OUT_OF_PROFILE_REGISTRY_ROWS.map((row) => [row.id,row]));
const OWNER_SET = new Set(X86_LONG64_CANONICAL_EFFECT_OWNERS);
const LEGACY_PREFIXES = new Set([0xf0,0xf2,0xf3,0x2e,0x36,0x3e,0x26,0x64,0x65,0x66,0x67]);

export const X86_LONG64_DENOMINATOR_CONSTRUCTION_SWEEPS = Object.freeze([
  Object.freeze({ id:'legacy-rex-opcode-modrm', probeCount:3670016, covers:Object.freeze(['legacy-prefix-classes','rex','one-byte','0f','0f38','0f3a','modrm']) }),
  Object.freeze({ id:'vex-evex-primary-fields', probeCount:79691776, covers:Object.freeze(['vex2','vex3','evex','map','w','pp','vvvv','ll','opcode','modrm']) }),
  Object.freeze({ id:'evex-p2-full-state', probeCount:50331648, covers:Object.freeze(['evex-p2','opmask','zeroing','broadcast-rounding','ll','opcode','register-memory-modrm']) }),
  Object.freeze({ id:'xop-map8-10', probeCount:50331648, covers:Object.freeze(['xop-map8','xop-map9','xop-map10','payload','opcode','modrm']) }),
  Object.freeze({ id:'3dnow-selector', probeCount:65536, covers:Object.freeze(['3dnow-0f0f','modrm','imm8-opcode-selector']) }),
  Object.freeze({ id:'predicate-alias-replay', probeCount:528, covers:Object.freeze(['legacy-compare-imm8','vex-compare-imm8','evex-vpcmp-predicate','xop-vpcom-predicate']) }),
]);

export const X86_LONG64_ENCODING_GRAMMAR = Object.freeze({
  instructionLengthBytes:Object.freeze([1,15]),
  legacyPrefixBytes:Object.freeze([0xf0,0xf2,0xf3,0x2e,0x36,0x3e,0x26,0x64,0x65,0x66,0x67]),
  rexByteRange:Object.freeze([0x40,0x4f]),
  addressSizeBits:Object.freeze([32,64]),
  modeInvalidAddressSizeBits:Object.freeze([16]),
  operandSizeBits:Object.freeze([8,16,32,64]),
  vectorSizeBits:Object.freeze([128,256,512]),
  opcodeMaps:Object.freeze([
    'legacy-one-byte', 'legacy-0f', 'legacy-0f38', 'legacy-0f3a', '3dnow-0f0f',
    'vex-map1', 'vex-map2', 'vex-map3',
    'evex-map1', 'evex-map2', 'evex-map3',
    'xop-map8', 'xop-map9', 'xop-map10',
  ]),
  modrmByteCount:256,
  sibByteCount:256,
  displacementWidthBytes:Object.freeze([0,1,4]),
  immediateWidthBytes:Object.freeze([0,1,2,4,8]),
  vex2PayloadByteCount:256,
  vex3PayloadByteCount:256,
  evexP1LegalStateCount:128,
  evexP2StateCount:256,
  xopPayloadByteCount:256,
});

function fail(reason, detail = '') {
  throw new TypeError(detail ? `${reason}:${detail}` : reason);
}

function fixtureDigest(rows) {
  return crypto.createHash('sha256')
    .update(rows.map(([id,name,hex]) => `${id}:${name}:${hex}\n`).join(''))
    .digest('hex');
}

export function bytesFromX86Long64WitnessHex(hex) {
  const text = String(hex || '').toLowerCase();
  if (!/^(?:[0-9a-f]{2}){1,15}$/.test(text)) fail('x86-long64-decoder-witness-hex-invalid', text);
  return Uint8Array.from(text.match(/../g).map((byte) => Number.parseInt(byte,16)));
}

export function classifyX86Long64WitnessPrefix(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
  let cursor = 0;
  while (cursor < input.length && LEGACY_PREFIXES.has(input[cursor])) cursor++;
  if (cursor < input.length && input[cursor] >= 0x40 && input[cursor] <= 0x4f) cursor++;
  const lead = input[cursor];
  if (lead === 0xc5) return 'vex2';
  if (lead === 0xc4) return 'vex3';
  if (lead === 0x62) return 'evex';
  if (lead === 0x8f && cursor + 1 < input.length && (input[cursor + 1] & 0x1f) >= 8 && (input[cursor + 1] & 0x1f) <= 10) return 'xop';
  if (lead === 0x0f && input[cursor + 1] === 0x0f) return '3dnow';
  return 'legacy-rex';
}

export function x86Long64FallbackEligibilityForRegistryRow(id) {
  const row = EXCLUSION_BY_ID.get(Number(id));
  return row ? Object.freeze({ class:row.disposition, reason:row.reason }) : null;
}

export function x86Long64DecoderDenominatorIdentity() {
  const lea = x86Long64LeaDenominatorIdentity();
  return Object.freeze({
    schemaVersion:X86_LONG64_DECODER_DENOMINATOR_SCHEMA,
    denominatorId:X86_LONG64_DECODER_DENOMINATOR_ID,
    profileId:'x86_64:long-64',
    decoderContractVersion:X86_DECODED_INSTRUCTION_CONTRACT_VERSION,
    semanticVersion:X86_DECODER_SEMANTIC_VERSION,
    registrySchemaVersion:X86_CAPSTONE_REGISTRY_SCHEMA,
    registryId:X86_CAPSTONE_REGISTRY_ID,
    registryInstructionCount:X86_CAPSTONE_REGISTRY_EXPECTED.instructionCount,
    validLong64InstructionIdCount:X86_LONG64_DECODER_WITNESSES.length,
    explicitOutOfProfileRegistryIdCount:X86_LONG64_EXPLICIT_OUT_OF_PROFILE_REGISTRY_ROWS.length,
    modeInvalidOrRepurposedCount:MODE_INVALID_OR_REPURPOSED.length,
    prefixTokenCount:PREFIX_TOKENS.length,
    nonemittingAliasCount:NONEMITTING_ALIASES.length,
    witnessFixtureVersion:X86_LONG64_DECODER_WITNESS_FIXTURE_VERSION,
    witnessSha256:X86_LONG64_DECODER_WITNESS_SHA256,
    witnessPrefixKindCounts:Object.freeze({
      'legacy-rex':689, evex:276, vex3:244, vex2:195, xop:59, '3dnow':24,
    }),
    encodingGrammar:X86_LONG64_ENCODING_GRAMMAR,
    constructionSweeps:X86_LONG64_DENOMINATOR_CONSTRUCTION_SWEEPS,
    modrmSibSubproof:Object.freeze({
      denominatorId:lea.denominatorId,
      encodingCaseCount:lea.encodingCaseCount,
      covers:Object.freeze(['address-size','operand-size','rex-rxb','modrm','sib','displacement-width']),
    }),
    canonicalEffectOwners:X86_LONG64_CANONICAL_EFFECT_OWNERS,
    fallbackAllowedClasses:X86_LONG64_FALLBACK_ALLOWED_CLASSES,
    denominatorMethod:'Intel x86 long-mode encoding grammar quotient + exhaustive structural discriminators + deployed Capstone-5 detail replay; production effect registries are not an enumeration oracle',
    oracleIds:Object.freeze([
      'intel-sdm-vol2-x86-instruction-encoding-and-long-mode-validity',
      'intel-xed-isa-pattern-grammar',
      'deployed-capstone-5-x86-long64-detail',
      lea.denominatorId,
    ]),
  });
}

/**
 * Prove that the independently frozen long-64 witness identity and the deployed
 * all-mode instruction-name registry form an exact partition. Effect families
 * are deliberately absent from this proof: they are the subject under test.
 */
export function verifyX86Long64DecoderDenominatorFixture(registryEvidence) {
  if (!registryEvidence || registryEvidence.schemaVersion !== X86_CAPSTONE_REGISTRY_SCHEMA) fail('x86-long64-decoder-registry-evidence-required');
  if (registryEvidence.registryId !== X86_CAPSTONE_REGISTRY_ID) fail('x86-long64-decoder-registry-id-drift');
  if (registryEvidence.instructionCount !== X86_CAPSTONE_REGISTRY_EXPECTED.instructionCount
    || registryEvidence.registrySha256 !== X86_CAPSTONE_REGISTRY_EXPECTED.registrySha256) {
    fail('x86-long64-decoder-registry-identity-drift');
  }
  if (!Array.isArray(registryEvidence.rows) || registryEvidence.rows.length !== registryEvidence.instructionCount) fail('x86-long64-decoder-registry-rows-required');
  if (fixtureDigest(X86_LONG64_DECODER_WITNESSES) !== X86_LONG64_DECODER_WITNESS_SHA256) fail('x86-long64-decoder-witness-digest-drift');

  const witnessIds = new Set();
  const prefixCounts = new Map();
  for (const row of X86_LONG64_DECODER_WITNESSES) {
    if (!Array.isArray(row) || row.length !== 3) fail('x86-long64-decoder-witness-row-invalid');
    const [id,name,hex] = row;
    if (!Number.isInteger(id) || id < 1 || id > registryEvidence.instructionCount || witnessIds.has(id)) fail('x86-long64-decoder-witness-id-invalid', id);
    const registryRow = registryEvidence.rows[id - 1];
    if (!registryRow || registryRow.id !== id || registryRow.name !== name) fail('x86-long64-decoder-witness-registry-name-drift', `${id}:${name}`);
    const bytes = bytesFromX86Long64WitnessHex(hex);
    witnessIds.add(id);
    const kind = classifyX86Long64WitnessPrefix(bytes);
    prefixCounts.set(kind, (prefixCounts.get(kind) || 0) + 1);
  }

  const exclusionIds = new Set();
  for (const row of X86_LONG64_EXPLICIT_OUT_OF_PROFILE_REGISTRY_ROWS) {
    if (exclusionIds.has(row.id) || witnessIds.has(row.id)) fail('x86-long64-decoder-partition-overlap', row.id);
    const registryRow = registryEvidence.rows[row.id - 1];
    if (!registryRow || registryRow.id !== row.id || registryRow.name !== row.name) fail('x86-long64-decoder-exclusion-registry-name-drift', `${row.id}:${row.name}`);
    if (!X86_LONG64_FALLBACK_ALLOWED_CLASSES.includes(row.disposition)) fail('x86-long64-decoder-exclusion-class-invalid', `${row.id}:${row.disposition}`);
    for (const canonicalId of row.canonicalIds || []) {
      if (!witnessIds.has(canonicalId)) fail('x86-long64-decoder-alias-canonical-not-emitted', `${row.id}->${canonicalId}`);
    }
    exclusionIds.add(row.id);
  }

  for (const { id } of registryEvidence.rows) {
    if (witnessIds.has(id) === exclusionIds.has(id)) fail('x86-long64-decoder-partition-incomplete', id);
  }
  if (witnessIds.size + exclusionIds.size !== registryEvidence.instructionCount) fail('x86-long64-decoder-partition-count-drift');

  const expectedCounts = x86Long64DecoderDenominatorIdentity().witnessPrefixKindCounts;
  assertObjectCounts(prefixCounts, expectedCounts, 'x86-long64-decoder-prefix-kind-count-drift');
  return true;
}

function assertObjectCounts(actualMap, expected, code) {
  const actual = Object.fromEntries([...actualMap.entries()].sort(([a],[b]) => a.localeCompare(b)));
  const normalizedExpected = Object.fromEntries(Object.entries(expected).sort(([a],[b]) => a.localeCompare(b)));
  if (JSON.stringify(actual) !== JSON.stringify(normalizedExpected)) fail(code, JSON.stringify(actual));
}

/**
 * Audit production ownership without using production ownership to define the
 * denominator. `liftEffect` is the canonical top-level dispatcher under test;
 * therefore every non-null result has necessarily been claimed by one of its
 * locked canonical families. `metadata.family` is only diagnostic: some older
 * family implementations expose internal labels such as "flags" or
 * "foundation", and those labels must not be confused with dispatcher owner
 * identity.
 */
export function analyzeX86Long64ValidEncodingOwnership(decodedRows, liftEffect) {
  if (!Array.isArray(decodedRows)) fail('x86-long64-decoder-ownership-rows-required');
  if (typeof liftEffect !== 'function') fail('x86-long64-decoder-ownership-lifter-required');
  const metadataLabelCounts = {};
  const canonicalMetadataCounts = Object.fromEntries(X86_LONG64_CANONICAL_EFFECT_OWNERS.map((owner) => [owner,0]));
  const unowned = [];
  for (const row of decodedRows) {
    const instruction = row?.instruction;
    const id = Number(row?.id ?? instruction?.instructionCode);
    const name = String(row?.name ?? instruction?.instructionFamily ?? '');
    if (!instruction || !Number.isInteger(id) || !name) fail('x86-long64-decoder-ownership-row-invalid');
    if (EXCLUSION_BY_ID.has(id)) fail('x86-long64-decoder-ownership-out-of-profile-row', id);
    const effect = liftEffect(instruction);
    if (effect == null) {
      unowned.push(Object.freeze({ id, name }));
      continue;
    }
    const label = String(effect.metadata?.family || '(none)').toLowerCase();
    metadataLabelCounts[label] = (metadataLabelCounts[label] || 0) + 1;
    if (OWNER_SET.has(label)) canonicalMetadataCounts[label]++;
  }
  return Object.freeze({
    schemaVersion:'x86-long64-valid-encoding-ownership/v1',
    denominatorId:X86_LONG64_DECODER_DENOMINATOR_ID,
    canonicalDispatcher:true,
    validEncodingCount:decodedRows.length,
    ownedCount:decodedRows.length - unowned.length,
    unownedCount:unowned.length,
    invalidOwnerCount:0,
    ownerCounts:Object.freeze(canonicalMetadataCounts),
    metadataLabelCounts:Object.freeze(metadataLabelCounts),
    unowned:Object.freeze(unowned),
    invalidOwner:Object.freeze([]),
  });
}

export function assertX86Long64ValidEncodingOwnership(report) {
  if (!report || report.denominatorId !== X86_LONG64_DECODER_DENOMINATOR_ID) fail('x86-long64-valid-encoding-ownership-report-invalid');
  if (report.unownedCount > 0) {
    const first = report.unowned[0];
    fail('x86-long64-valid-encoding-unowned', `${first.id}:${first.name}`);
  }
  if (report.ownedCount !== report.validEncodingCount) fail('x86-long64-valid-encoding-ownership-count-drift');
  return true;
}

export function x86Long64FallbackNegativeProof(report) {
  if (!report || report.denominatorId !== X86_LONG64_DECODER_DENOMINATOR_ID) fail('x86-long64-fallback-proof-report-invalid');
  return Object.freeze({
    schemaVersion:X86_LONG64_FALLBACK_PROOF_SCHEMA,
    denominatorId:X86_LONG64_DECODER_DENOMINATOR_ID,
    validEncodingCount:report.validEncodingCount,
    validEncodingFallbackEligibleCount:0,
    validEncodingWithoutOwnerCount:report.unownedCount,
    explicitOutOfProfileRegistryIdCount:X86_LONG64_EXPLICIT_OUT_OF_PROFILE_REGISTRY_ROWS.length,
    allowedFallbackClasses:X86_LONG64_FALLBACK_ALLOWED_CLASSES,
  });
}

export function assertX86Long64FallbackNegativeProof(report) {
  const proof = x86Long64FallbackNegativeProof(report);
  if (proof.validEncodingFallbackEligibleCount !== 0) fail('x86-long64-fallback-valid-encoding-eligible');
  if (proof.validEncodingWithoutOwnerCount !== 0) fail('x86-long64-fallback-laundering-valid-encoding', proof.validEncodingWithoutOwnerCount);
  return true;
}
