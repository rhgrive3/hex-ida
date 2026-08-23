import assert from 'node:assert/strict';
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
const denominatorLock = createStage2DenominatorLock({ items: denominatorInputs }, { scope, resolveInventoryIdentity });
assert.equal(validateStage2DenominatorLock(denominatorLock, { scope, resolveInventoryIdentity }).ok, true);
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
    providerProfileIds: id === 'S2-A7-NATIVE' || id.startsWith('S2-M6-') ? [`provider:${id}`] : [],
    implementationIdentity: `implementation:${id}`,
    independentOracleIdentities: id === 'S1-A2-NATIVE' || id.startsWith('S2-F6-') ? [`oracle:${id}:independent`] : [],
  };
}

const record = createStage2ProfileEvidence({ commitSha, treeSha, generatedAt: '2026-08-22T00:00:00Z', items });
const expected = { commitSha, treeSha, denominatorLock, scope, resolveInventoryIdentity };
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
const reducedLock = createStage2DenominatorLock({ items: reducedInputs }, { scope, resolveInventoryIdentity });
const reducedCheck = validateStage2DenominatorLock(reducedLock, { scope, resolveInventoryIdentity });
assert.equal(reducedCheck.ok, false, 'a freshly re-hashed denominator still cannot omit a locked profile');
assert.ok(reducedCheck.failures.includes('S1-A2-NATIVE:denominator-profile-units-missing:x86_64:long-64'));

inventoryIdentities.set('js/platform/stage2-profile-evidence.js', 'b'.repeat(40));
const staleInventory = validateStage2DenominatorLock(denominatorLock, { scope, resolveInventoryIdentity });
assert.equal(staleInventory.ok, false, 'production inventory changes must invalidate denominator evidence');
assert.ok(staleInventory.failures.includes('S1-A2-NATIVE:denominator-inventory-stale'));
console.log('[stage2] per-profile evidence contract tests passed');
