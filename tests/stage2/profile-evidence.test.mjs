import assert from 'node:assert/strict';
import { STAGE2_PROFILE_EVIDENCE_IDS, createStage2ProfileEvidence, validateStage2ProfileEvidence } from '../../js/platform/stage2-profile-evidence.js';

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
const denominators = {};
const items = {};
for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
  const unitIds = [`${id}:required-unit`];
  denominators[id] = { id: `denominator:${id}:v1`, lockHash: `lock:${id}:v1`.toLowerCase(), unitIds };
  items[id] = {
    profileIds: profiles[id],
    candidateCommitSha: commitSha,
    candidateTreeSha: treeSha,
    denominatorId: denominators[id].id,
    denominatorLockHash: denominators[id].lockHash,
    coveredUnitIds: unitIds,
    unitEvidence: { [unitIds[0]]: `evidence:${id}:unit` },
    realFixtureIdentities: [`fixture:${id}:real`],
    negativeTestIdentities: [`test:${id}:negative`],
    evidenceIdentities: [`evidence:${id}:aggregate`],
    providerProfileIds: id === 'S2-A7-NATIVE' || id.startsWith('S2-M6-') ? [`provider:${id}`] : [],
    implementationIdentity: `implementation:${id}`,
    independentOracleIdentities: id === 'S1-A2-NATIVE' || id.startsWith('S2-F6-') ? [`oracle:${id}:independent`] : [],
  };
}

const record = createStage2ProfileEvidence({ commitSha, treeSha, generatedAt: '2026-08-22T00:00:00Z', items });
const checked = validateStage2ProfileEvidence(record, { commitSha, treeSha, denominators });
assert.equal(checked.ok, true, JSON.stringify(checked.failures));

const incompleteItems = structuredClone(items);
incompleteItems['S2-F6-PE'].coveredUnitIds = [];
const incomplete = createStage2ProfileEvidence({ commitSha, treeSha, generatedAt: '2026-08-22T00:00:00Z', items: incompleteItems });
assert.equal(validateStage2ProfileEvidence(incomplete, { commitSha, treeSha, denominators }).reason, 'stage2-profile-evidence-incomplete');

const fabricated = createStage2ProfileEvidence({
  commitSha, treeSha, generatedAt: '2026-08-22T00:00:00Z',
  items: Object.fromEntries(STAGE2_PROFILE_EVIDENCE_IDS.map((id) => [id, {
    profileIds: profiles[id], denominatorComplete: true, exactHead: true, realFixture: true,
    independentOracle: true, capabilityOrValidatorCoverageComplete: true, negativeTests: true,
    evidenceIdentities: ['fabricated:oracle-result'], providerProfileIds: ['fabricated:provider'],
  }])),
});
assert.equal(validateStage2ProfileEvidence(fabricated, { commitSha, treeSha, denominators }).ok, false, 'recomputed self-hash must not turn asserted booleans into proof');

const tampered = JSON.parse(JSON.stringify(record));
tampered.items['S2-M6-JVM'].coveredUnitIds = [];
assert.equal(validateStage2ProfileEvidence(tampered, { commitSha, treeSha, denominators }).reason, 'stage2-profile-evidence-tampered');
assert.equal(validateStage2ProfileEvidence(record, { commitSha: 'c'.repeat(40), denominators }).reason, 'stage2-profile-evidence-stale-commit');
assert.equal(validateStage2ProfileEvidence(record, { commitSha, treeSha }).reason, 'stage2-profile-evidence-denominator-lock-required');
console.log('[stage2] per-profile evidence contract tests passed');
