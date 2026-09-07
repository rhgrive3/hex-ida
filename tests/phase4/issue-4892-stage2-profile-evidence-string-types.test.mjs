import assert from 'node:assert/strict';
import { stableDigest } from '../../js/core/identity/index.js';
import {
  STAGE2_PROFILE_EVIDENCE_IDS,
  createStage2CapabilityProofs,
  createStage2DenominatorLock,
  createStage2ProfileEvidence,
  validateStage2DenominatorLock,
  validateStage2ProfileEvidence,
} from '../../js/platform/stage2-profile-evidence.js';

const COMMIT_SHA = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);
const GENERATED_AT = '2026-09-02T00:00:00.000Z';
const SCOPE = Object.freeze({ scopeVersion: '1', repository: 'rhgrive3/hex-ida', corpusId: 'issue-4892' });
const PROFILES = Object.freeze({
  'S1-A2-NATIVE': ['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc'],
  'S2-A7-NATIVE': ['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc'],
  'S2-M6-WASM': ['managed:wasm:m6'],
  'S2-M6-DEX': ['managed:dex:m6'],
  'S2-M6-CIL': ['managed:cil:m6'],
  'S2-M6-JVM': ['managed:jvm:m6'],
  'S2-F6-MACHO': ['macho:64'],
  'S2-F6-ELF': ['elf:64'],
  'S2-F6-PE': ['pe:pe32', 'pe:pe32+'],
  'S2-P12-KNOWLEDGE': ['knowledge-packages:v1'],
  'S2-P12-RULES': ['capability-rules:v1'],
  'S2-P12-PATTERNS': ['patterns:read-only-v1'],
  'S2-P12-COLLAB-REMOTE': ['collaboration:remote-security-v1'],
});

function unitIdsFor(id) {
  return PROFILES[id].map((profile) => `${profile}:unit`);
}

function inventoryIdentity(ref, id) {
  return `inventory-identity:${id}:${ref}`;
}

function denominatorUnits(id) {
  return unitIdsFor(id);
}

function makeDenominatorInput() {
  const items = {};
  for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
    items[id] = {
      profiles: [...PROFILES[id]],
      unitIds: unitIdsFor(id),
      inventoryRefs: [`inventory:${id}`],
    };
  }
  return { items };
}

function providerProfiles(id) {
  if (id === 'S2-A7-NATIVE') return ['native:lldb-compatible-v1:host', 'native:remote-debug-v1:qemu-lldb'];
  if (id.startsWith('S2-M6-')) {
    const frontend = id.slice('S2-M6-'.length).toLowerCase();
    return [`managed:${frontend}:provider-bound-runtime-v1:test`];
  }
  return [];
}

function needsIndependentOracle(id) {
  return id === 'S1-A2-NATIVE' || id.startsWith('S2-F6-') || id === 'S2-P12-COLLAB-REMOTE';
}

function makeEvidenceInput(lock) {
  const items = {};
  for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
    const denominator = lock.items[id];
    items[id] = {
      profileIds: [...PROFILES[id]],
      candidateCommitSha: COMMIT_SHA,
      candidateTreeSha: TREE_SHA,
      denominatorId: denominator.id,
      denominatorLockHash: denominator.lockHash,
      coveredUnitIds: [...denominator.unitIds],
      unitEvidence: Object.fromEntries(denominator.unitIds.map((unitId, index) => [unitId, `evidence:${id}:${index}`])),
      realFixtureIdentities: [`fixture:${id}`],
      negativeTestIdentities: [`negative:${id}`],
      evidenceIdentities: [`evidence-summary:${id}`],
      providerProfileIds: providerProfiles(id),
      implementationIdentity: `implementation:${id}`,
      independentOracleIdentities: needsIndependentOracle(id) ? [`oracle:${id}`] : [],
    };
  }
  return { commitSha: COMMIT_SHA, treeSha: TREE_SHA, generatedAt: GENERATED_AT, items };
}

function clone(value) {
  return structuredClone(value);
}

function rawEvidenceId(value) {
  return `stage2-profile-evidence:${stableDigest({
    schemaVersion: value.schemaVersion,
    commitSha: value.commitSha,
    treeSha: value.treeSha,
    generatedAt: value.generatedAt,
    items: value.items,
  })}`;
}

const denominatorInput = makeDenominatorInput();
const denominatorLock = createStage2DenominatorLock(denominatorInput, {
  scope: SCOPE,
  resolveInventoryIdentity: inventoryIdentity,
  resolveDenominatorUnitIds: denominatorUnits,
});
assert.equal(denominatorLock.lockHash, 'stage2-denominator-lock:b25e1b648c95f2b4d3ea18531fa80b2f');
assert.equal(validateStage2DenominatorLock(denominatorLock, {
  scope: SCOPE,
  resolveInventoryIdentity: inventoryIdentity,
  resolveDenominatorUnitIds: denominatorUnits,
}).ok, true);

const validInput = makeEvidenceInput(denominatorLock);
const record = createStage2ProfileEvidence(validInput);
assert.equal(record.evidenceId, 'stage2-profile-evidence:ad73d5ac8342070f025f8fcd399b2666');
const validation = validateStage2ProfileEvidence(record, {
  commitSha: COMMIT_SHA,
  treeSha: TREE_SHA,
  denominatorLock,
  scope: SCOPE,
  resolveInventoryIdentity: inventoryIdentity,
  resolveDenominatorUnitIds: denominatorUnits,
  resolveEvidenceIdentity: (identity) => identity,
});
assert.equal(validation.ok, true, validation.failures?.join('\n'));
const proofs = createStage2CapabilityProofs(validation);
assert.equal(proofs['S1-A2-NATIVE'].authority, 'validated-stage2-profile-evidence');

const structuredExpectedCommitValidation = validateStage2ProfileEvidence(record, {
  commitSha: [COMMIT_SHA],
  treeSha: TREE_SHA,
  denominatorLock,
  scope: SCOPE,
  resolveInventoryIdentity: inventoryIdentity,
  resolveDenominatorUnitIds: denominatorUnits,
  resolveEvidenceIdentity: (identity) => identity,
});
assert.equal(structuredExpectedCommitValidation.ok, false);
assert.equal(structuredExpectedCommitValidation.reason, 'stage2-profile-evidence-expected-commit-invalid');
assert.throws(
  () => createStage2CapabilityProofs(structuredExpectedCommitValidation),
  /stage2-profile-validation-authority-required/,
  'structured expected commitSha cannot mint capability proof',
);

const structuredExpectedTreeValidation = validateStage2ProfileEvidence(record, {
  commitSha: COMMIT_SHA,
  treeSha: [TREE_SHA],
  denominatorLock,
  scope: SCOPE,
  resolveInventoryIdentity: inventoryIdentity,
  resolveDenominatorUnitIds: denominatorUnits,
  resolveEvidenceIdentity: (identity) => identity,
});
assert.equal(structuredExpectedTreeValidation.ok, false);
assert.equal(structuredExpectedTreeValidation.reason, 'stage2-profile-evidence-expected-tree-invalid');
assert.throws(
  () => createStage2CapabilityProofs(structuredExpectedTreeValidation),
  /stage2-profile-validation-authority-required/,
  'structured expected treeSha cannot mint capability proof',
);

const rawValidationOptions = {
  denominatorLock,
  scope: SCOPE,
  resolveInventoryIdentity: inventoryIdentity,
  resolveDenominatorUnitIds: denominatorUnits,
  resolveEvidenceIdentity: (identity) => identity,
};

const rawStructuredShaRecord = clone(record);
const rawCommitSha = [COMMIT_SHA];
const rawTreeSha = [TREE_SHA];
rawStructuredShaRecord.commitSha = rawCommitSha;
rawStructuredShaRecord.treeSha = rawTreeSha;
for (const item of Object.values(rawStructuredShaRecord.items)) {
  item.candidateCommitSha = rawCommitSha;
  item.candidateTreeSha = rawTreeSha;
}
rawStructuredShaRecord.evidenceId = rawEvidenceId(rawStructuredShaRecord);
const rawStructuredShaValidation = validateStage2ProfileEvidence(rawStructuredShaRecord, rawValidationOptions);
assert.equal(rawStructuredShaValidation.ok, false);
assert.equal(rawStructuredShaValidation.reason, 'stage2-profile-evidence-commit-invalid');
assert.throws(
  () => createStage2CapabilityProofs(rawStructuredShaValidation),
  /stage2-profile-validation-authority-required/,
  'direct raw structured SHA evidence cannot mint capability proof',
);

const rawStructuredTimeRecord = clone(record);
rawStructuredTimeRecord.generatedAt = [GENERATED_AT];
rawStructuredTimeRecord.evidenceId = rawEvidenceId(rawStructuredTimeRecord);
const rawStructuredTimeValidation = validateStage2ProfileEvidence(rawStructuredTimeRecord, rawValidationOptions);
assert.equal(rawStructuredTimeValidation.ok, false);
assert.equal(rawStructuredTimeValidation.reason, 'stage2-profile-evidence-time-invalid');
assert.throws(
  () => createStage2CapabilityProofs(rawStructuredTimeValidation),
  /stage2-profile-validation-authority-required/,
  'direct raw structured generatedAt cannot mint capability proof',
);

const targetId = 'S1-A2-NATIVE';
const rawStructuredItem = clone(record);
rawStructuredItem.items[targetId].denominatorId = [rawStructuredItem.items[targetId].denominatorId];
rawStructuredItem.evidenceId = rawEvidenceId(rawStructuredItem);
const rawStructuredItemValidation = validateStage2ProfileEvidence(rawStructuredItem, rawValidationOptions);
assert.equal(rawStructuredItemValidation.ok, false);
assert.ok(rawStructuredItemValidation.failures?.includes(`${targetId}:denominator-id-invalid`));
assert.throws(
  () => createStage2CapabilityProofs(rawStructuredItemValidation),
  /stage2-profile-validation-authority-required/,
  'direct raw structured item identity cannot mint capability proof',
);

const structuredCases = [
  ['commitSha', (input) => { input.commitSha = [COMMIT_SHA]; }],
  ['treeSha', (input) => { input.treeSha = [TREE_SHA]; }],
  ['generatedAt', (input) => { input.generatedAt = { toString: () => GENERATED_AT }; }],
  ['profileIds', (input) => { input.items[targetId].profileIds = input.items[targetId].profileIds.map((value) => [value]); }],
  ['candidateCommitSha', (input) => { input.items[targetId].candidateCommitSha = [COMMIT_SHA]; }],
  ['candidateTreeSha', (input) => { input.items[targetId].candidateTreeSha = [TREE_SHA]; }],
  ['denominatorId', (input) => { input.items[targetId].denominatorId = [input.items[targetId].denominatorId]; }],
  ['denominatorLockHash', (input) => { input.items[targetId].denominatorLockHash = [input.items[targetId].denominatorLockHash]; }],
  ['coveredUnitIds', (input) => { input.items[targetId].coveredUnitIds = input.items[targetId].coveredUnitIds.map((value) => [value]); }],
  ['unitEvidence', (input) => {
    const key = Object.keys(input.items[targetId].unitEvidence)[0];
    input.items[targetId].unitEvidence[key] = [input.items[targetId].unitEvidence[key]];
  }],
  ['realFixtureIdentities', (input) => { input.items[targetId].realFixtureIdentities = [[input.items[targetId].realFixtureIdentities[0]]]; }],
  ['negativeTestIdentities', (input) => { input.items[targetId].negativeTestIdentities = [[input.items[targetId].negativeTestIdentities[0]]]; }],
  ['evidenceIdentities', (input) => { input.items[targetId].evidenceIdentities = [[input.items[targetId].evidenceIdentities[0]]]; }],
  ['implementationIdentity', (input) => { input.items[targetId].implementationIdentity = { toString: () => `implementation:${targetId}` }; }],
  ['independentOracleIdentities', (input) => { input.items[targetId].independentOracleIdentities = [[input.items[targetId].independentOracleIdentities[0]]]; }],
];

for (const [name, mutate] of structuredCases) {
  const malformed = clone(validInput);
  mutate(malformed);
  assert.throws(() => createStage2ProfileEvidence(malformed), TypeError, name);
}

const emptyProfileId = clone(validInput);
emptyProfileId.items[targetId].profileIds = ['', ...emptyProfileId.items[targetId].profileIds];
assert.throws(() => createStage2ProfileEvidence(emptyProfileId), TypeError, 'empty profileIds element');

const providerMalformed = clone(validInput);
providerMalformed.items['S2-A7-NATIVE'].providerProfileIds = providerMalformed.items['S2-A7-NATIVE'].providerProfileIds.map((value) => [value]);
assert.throws(() => createStage2ProfileEvidence(providerMalformed), TypeError, 'providerProfileIds');

const malformedDenominator = clone(denominatorInput);
malformedDenominator.items[targetId].profiles = malformedDenominator.items[targetId].profiles.map((value) => [value]);
assert.throws(() => createStage2DenominatorLock(malformedDenominator, {
  scope: SCOPE,
  resolveInventoryIdentity: inventoryIdentity,
  resolveDenominatorUnitIds: denominatorUnits,
}), TypeError, 'denominator profiles');

const emptyDenominatorUnit = clone(denominatorInput);
emptyDenominatorUnit.items[targetId].unitIds = ['', ...emptyDenominatorUnit.items[targetId].unitIds];
assert.throws(() => createStage2DenominatorLock(emptyDenominatorUnit, {
  scope: SCOPE,
  resolveInventoryIdentity: inventoryIdentity,
  resolveDenominatorUnitIds: denominatorUnits,
}), TypeError, 'empty denominator unitId');

assert.throws(() => createStage2DenominatorLock(denominatorInput, {
  scope: { ...SCOPE, scopeVersion: ['1'] },
  resolveInventoryIdentity: inventoryIdentity,
  resolveDenominatorUnitIds: denominatorUnits,
}), TypeError, 'scopeVersion');

assert.throws(() => createStage2DenominatorLock(denominatorInput, {
  scope: SCOPE,
  resolveInventoryIdentity: (ref, id) => [inventoryIdentity(ref, id)],
  resolveDenominatorUnitIds: denominatorUnits,
}), TypeError, 'inventory resolver result');

assert.throws(() => createStage2DenominatorLock(denominatorInput, {
  scope: SCOPE,
  resolveInventoryIdentity: inventoryIdentity,
  resolveDenominatorUnitIds: (id) => denominatorUnits(id).map((value) => [value]),
}), TypeError, 'unit resolver result');

const resolverValidation = validateStage2DenominatorLock(denominatorLock, {
  scope: SCOPE,
  resolveInventoryIdentity: inventoryIdentity,
  resolveDenominatorUnitIds: (id) => denominatorUnits(id).map((value) => [value]),
});
assert.equal(resolverValidation.ok, false);
assert.ok(resolverValidation.failures.some((failure) => failure.includes('denominator-unit-set-unresolved')));

console.log('issue-4892: PASS');
