import {
  STAGE2_PROFILE_EVIDENCE_IDS,
  createStage2CapabilityProofs,
  createStage2DenominatorLock,
  createStage2ProfileEvidence,
  validateStage2ProfileEvidence,
} from '../../../js/platform/stage2-profile-evidence.js';

const commitSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const inventoryRef = 'js/platform/stage2-profile-evidence.js';
const profiles = Object.freeze({
  'S1-A2-NATIVE': ['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc'],
  'S2-A7-NATIVE': ['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc'],
  'S2-M6-WASM': ['managed:wasm:m6'], 'S2-M6-DEX': ['managed:dex:m6'],
  'S2-M6-CIL': ['managed:cil:m6'], 'S2-M6-JVM': ['managed:jvm:m6'],
  'S2-F6-MACHO': ['macho:64'], 'S2-F6-ELF': ['elf:64'], 'S2-F6-PE': ['pe:pe32', 'pe:pe32+'],
  'S2-P12-KNOWLEDGE': ['knowledge-packages:v1'], 'S2-P12-RULES': ['capability-rules:v1'],
  'S2-P12-PATTERNS': ['patterns:read-only-v1'], 'S2-P12-COLLAB-REMOTE': ['collaboration:remote-security-v1'],
});

export function validatedCapabilityProofFixture() {
  const scope = { schemaVersion: 'test-scope/v1', scopeVersion: 'test-stage2-v1', growthOnly: true };
  const resolveInventoryIdentity = (ref) => ref === inventoryRef ? 'c'.repeat(40) : null;
  const denominatorInputs = { items: {} };
  for (const id of STAGE2_PROFILE_EVIDENCE_IDS) denominatorInputs.items[id] = {
    profiles: profiles[id],
    unitIds: profiles[id].map((profile) => `${profile}:required-unit`),
    inventoryRefs: [inventoryRef],
  };
  const denominatorLock = createStage2DenominatorLock(denominatorInputs, { scope, resolveInventoryIdentity });
  const items = {};
  for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
    const denominator = denominatorLock.items[id];
    items[id] = {
      profileIds: profiles[id], candidateCommitSha: commitSha, candidateTreeSha: treeSha,
      denominatorId: denominator.id, denominatorLockHash: denominator.lockHash,
      coveredUnitIds: denominator.unitIds,
      unitEvidence: Object.fromEntries(denominator.unitIds.map((unitId) => [unitId, `evidence:${id}:${unitId}`])),
      realFixtureIdentities: [`fixture:${id}:real`], negativeTestIdentities: [`test:${id}:negative`],
      evidenceIdentities: [`evidence:${id}:aggregate`], implementationIdentity: `implementation:${id}`,
      providerProfileIds: id === 'S2-A7-NATIVE' || id.startsWith('S2-M6-') ? [`provider:${id}`] : [],
      independentOracleIdentities: id === 'S1-A2-NATIVE' || id.startsWith('S2-F6-') ? [`oracle:${id}:independent`] : [],
    };
  }
  const record = createStage2ProfileEvidence({ commitSha, treeSha, generatedAt: '2026-08-22T00:00:00Z', items });
  const validation = validateStage2ProfileEvidence(record, { commitSha, treeSha, denominatorLock, scope, resolveInventoryIdentity });
  if (!validation.ok) throw new Error(`profile proof fixture invalid: ${validation.failures.join(',')}`);
  return { validation, proofs: createStage2CapabilityProofs(validation) };
}
