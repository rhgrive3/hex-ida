import assert from 'node:assert/strict';
import { stableDigest } from '../../js/core/identity/index.js';
import {
  STAGE2_PROFILE_EVIDENCE_IDS,
  createStage2DenominatorLock,
  createStage2ProfileEvidence,
  validateStage2DenominatorLock,
  validateStage2ProfileEvidence,
} from '../../js/platform/stage2-profile-evidence.js';

const commitSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const profiles = {
  'S1-A2-NATIVE': ['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc'],
  'S2-A7-NATIVE': ['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc'],
  'S2-M6-WASM': ['managed:wasm:m6'], 'S2-M6-DEX': ['managed:dex:m6'],
  'S2-M6-CIL': ['managed:cil:m6'], 'S2-M6-JVM': ['managed:jvm:m6'],
  'S2-F6-MACHO': ['macho:64'], 'S2-F6-ELF': ['elf:64'], 'S2-F6-PE': ['pe:pe32', 'pe:pe32+'],
  'S2-P12-KNOWLEDGE': ['knowledge-packages:v1'], 'S2-P12-RULES': ['capability-rules:v1'],
  'S2-P12-PATTERNS': ['patterns:read-only-v1'], 'S2-P12-COLLAB-REMOTE': ['collaboration:remote-security-v1'],
};
const scope = { schemaVersion: 'test-scope/v1', scopeVersion: 'test-stage2-v1', growthOnly: true };
const inventoryIdentities = new Map([['js/platform/stage2-profile-evidence.js', 'a'.repeat(40)]]);
const resolveInventoryIdentity = (ref) => inventoryIdentities.get(ref) || null;
const denominatorInputs = {};
const items = {};
for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
  const unitIds = profiles[id].map((profile) => `${profile}:required-unit`);
  denominatorInputs[id] = { profiles: profiles[id], unitIds, inventoryRefs: ['js/platform/stage2-profile-evidence.js'] };
}
const resolveDenominatorUnitIds = (id) => denominatorInputs[id]?.unitIds || [];
const denominatorLock = createStage2DenominatorLock({ items: denominatorInputs }, { scope, resolveInventoryIdentity, resolveDenominatorUnitIds });
assert.equal(validateStage2DenominatorLock(denominatorLock, { scope, resolveInventoryIdentity, resolveDenominatorUnitIds }).ok, true);
const knownEvidence = new Set();
for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
  const denominator = denominatorLock.items[id];
  const unitIds = denominator.unitIds;
  items[id] = {
    profileIds: profiles[id],
    candidateCommitSha: commitSha,
    candidateTreeSha: treeSha,
    denominatorId: denominator.id,
    denominatorLockHash: denominator.lockHash,
    coveredUnitIds: unitIds,
    unitEvidence: Object.fromEntries(unitIds.map((unitId) => [unitId, `evidence:${id}:${unitId}`])),
    realFixtureIdentities: [`fixture:${id}:real`],
    negativeTestIdentities: [`test:${id}:negative`],
    evidenceIdentities: [`evidence:${id}:aggregate`],
    providerProfileIds: id === 'S2-A7-NATIVE'
      ? ['native:lldb-compatible-v1:test']
      : id.startsWith('S2-M6-')
        ? [`managed:${id.slice('S2-M6-'.length).toLowerCase()}:provider-bound-runtime-v1:test`]
        : [],
    implementationIdentity: `implementation:${id}`,
    independentOracleIdentities: id === 'S1-A2-NATIVE' || id.startsWith('S2-F6-') ? [`oracle:${id}:independent`] : [],
  };
  for (const value of Object.values(items[id].unitEvidence)) knownEvidence.add(value);
  for (const key of ['realFixtureIdentities', 'negativeTestIdentities', 'evidenceIdentities', 'independentOracleIdentities']) {
    for (const value of items[id][key]) knownEvidence.add(value);
  }
  knownEvidence.add(items[id].implementationIdentity);
}

const record = createStage2ProfileEvidence({ commitSha, treeSha, generatedAt: '2026-08-22T00:00:00Z', items });
const resolveEvidenceIdentity = (identity) => knownEvidence.has(identity) ? identity : null;
const expected = { commitSha, treeSha, denominatorLock, scope, resolveInventoryIdentity, resolveDenominatorUnitIds, resolveEvidenceIdentity };
const checked = validateStage2ProfileEvidence(record, expected);
assert.equal(checked.ok, true, JSON.stringify(checked.failures));

const incompleteItems = structuredClone(items);
incompleteItems['S2-F6-PE'].coveredUnitIds = [];
const incomplete = createStage2ProfileEvidence({ commitSha, treeSha, generatedAt: '2026-08-22T00:00:00Z', items: incompleteItems });
assert.equal(validateStage2ProfileEvidence(incomplete, expected).reason, 'stage2-profile-evidence-incomplete');

const fabricated = createStage2ProfileEvidence({
  commitSha, treeSha, generatedAt: '2026-08-22T00:00:00Z',
  items: Object.fromEntries(STAGE2_PROFILE_EVIDENCE_IDS.map((id) => [id, {
    profileIds: profiles[id], denominatorComplete: true, exactHead: true, realFixture: true,
    independentOracle: true, capabilityOrValidatorCoverageComplete: true, negativeTests: true,
    evidenceIdentities: ['fabricated:oracle-result'], providerProfileIds: ['fabricated:provider'],
  }])),
});
assert.equal(validateStage2ProfileEvidence(fabricated, expected).ok, false, 'recomputed self-hash must not turn asserted booleans into proof');

const tampered = JSON.parse(JSON.stringify(record));
tampered.items['S2-M6-JVM'].coveredUnitIds = [];
assert.equal(validateStage2ProfileEvidence(tampered, expected).reason, 'stage2-profile-evidence-tampered');
assert.equal(validateStage2ProfileEvidence(record, { ...expected, commitSha: 'c'.repeat(40) }).reason, 'stage2-profile-evidence-stale-commit');
assert.equal(validateStage2ProfileEvidence(record, { commitSha, treeSha }).reason, 'stage2-profile-evidence-denominator-lock-required');

const reducedInputs = structuredClone(denominatorInputs);
reducedInputs['S1-A2-NATIVE'].unitIds = reducedInputs['S1-A2-NATIVE'].unitIds.filter((unitId) => !unitId.startsWith('x86_64:long-64:'));
assert.throws(
  () => createStage2DenominatorLock({ items: reducedInputs }, { scope, resolveInventoryIdentity, resolveDenominatorUnitIds }),
  /stage2-denominator-unit-set-mismatch:S1-A2-NATIVE/,
  'a freshly re-hashed denominator still cannot omit a canonical unit',
);

const inventedInputs = structuredClone(denominatorInputs);
inventedInputs['S1-A2-NATIVE'].unitIds.push('arm64:a64:invented-unit');
assert.throws(
  () => createStage2DenominatorLock({ items: inventedInputs }, { scope, resolveInventoryIdentity, resolveDenominatorUnitIds }),
  /stage2-denominator-unit-set-mismatch:S1-A2-NATIVE/,
  'invented units cannot enter a freshly hashed denominator',
);

const unresolvedEvidenceItems = structuredClone(items);
unresolvedEvidenceItems['S2-M6-JVM'].realFixtureIdentities = ['fabricated:fixture'];
const unresolvedEvidence = createStage2ProfileEvidence({ commitSha, treeSha, generatedAt: '2026-08-22T00:00:00Z', items: unresolvedEvidenceItems });
assert.equal(validateStage2ProfileEvidence(unresolvedEvidence, expected).ok, false, 'arbitrary evidence labels cannot prove a profile');

const invalidProviderItems = structuredClone(items);
invalidProviderItems['S2-M6-JVM'].providerProfileIds = ['managed:dex:provider-bound-runtime-v1:test'];
const invalidProvider = createStage2ProfileEvidence({ commitSha, treeSha, generatedAt: '2026-08-22T00:00:00Z', items: invalidProviderItems });
const invalidProviderCheck = validateStage2ProfileEvidence(invalidProvider, expected);
assert.equal(invalidProviderCheck.ok, false, 'a provider profile from another managed frontend cannot prove JVM M6');
assert.ok(invalidProviderCheck.failures.includes('S2-M6-JVM:provider-profile-invalid'));

const rehash = (value) => `stage2-profile-evidence:${stableDigest({
  schemaVersion: value.schemaVersion,
  commitSha: value.commitSha,
  treeSha: value.treeSha,
  generatedAt: value.generatedAt,
  items: value.items,
})}`;
const extraItem = structuredClone(record);
extraItem.items.EXTRA = {};
extraItem.evidenceId = rehash(extraItem);
const extraItemCheck = validateStage2ProfileEvidence(extraItem, expected);
assert.equal(extraItemCheck.ok, false, 'unknown profile evidence items cannot enter the authority record');
assert.ok(extraItemCheck.failures.includes('stage2-profile-evidence-item-set-mismatch'));

const duplicateProvider = structuredClone(record);
duplicateProvider.items['S2-M6-JVM'].providerProfileIds.push(duplicateProvider.items['S2-M6-JVM'].providerProfileIds[0]);
duplicateProvider.evidenceId = rehash(duplicateProvider);
const duplicateProviderCheck = validateStage2ProfileEvidence(duplicateProvider, expected);
assert.equal(duplicateProviderCheck.ok, false, 'duplicate provider identities cannot bypass canonical evidence validation');
assert.ok(duplicateProviderCheck.failures.includes('S2-M6-JVM:provider-profile-missing'));

inventoryIdentities.set('js/platform/stage2-profile-evidence.js', 'b'.repeat(40));
const staleInventory = validateStage2DenominatorLock(denominatorLock, { scope, resolveInventoryIdentity, resolveDenominatorUnitIds });
assert.equal(staleInventory.ok, false, 'production inventory changes must invalidate denominator evidence');
assert.ok(staleInventory.failures.includes('S1-A2-NATIVE:denominator-inventory-stale'));
console.log('[stage2] per-profile evidence contract tests passed');
