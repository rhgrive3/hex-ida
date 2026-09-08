import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STAGE2_PROFILE_EVIDENCE_IDS,
  createStage2DenominatorLock,
  createStage2ProfileEvidence,
  validateStage2DenominatorLock,
  validateStage2ProfileEvidence,
  createStage2CapabilityProofs,
} from '../js/platform/stage2-profile-evidence.js';

const commitSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const scope = { schemaVersion: 'test-scope/v1', scopeVersion: 'test-stage2-v1', growthOnly: true };
const inventoryIdentities = new Map([['js/platform/stage2-profile-evidence.js', 'c'.repeat(40)]]);
const resolveInventoryIdentity = (ref) => inventoryIdentities.get(ref) || null;

const EXPECTED_PROFILES = {
  'S1-A2-NATIVE': ['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc'],
  'S2-A7-NATIVE': ['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc'],
  'S2-M6-WASM': ['managed:wasm:m6'], 'S2-M6-DEX': ['managed:dex:m6'],
  'S2-M6-CIL': ['managed:cil:m6'], 'S2-M6-JVM': ['managed:jvm:m6'],
  'S2-F6-MACHO': ['macho:64'], 'S2-F6-ELF': ['elf:64'], 'S2-F6-PE': ['pe:pe32', 'pe:pe32+'],
  'S2-P12-KNOWLEDGE': ['knowledge-packages:v1'], 'S2-P12-RULES': ['capability-rules:v1'],
  'S2-P12-PATTERNS': ['patterns:read-only-v1'], 'S2-P12-COLLAB-REMOTE': ['collaboration:remote-security-v1'],
};

function buildHarness() {
  const denominatorInputs = {};
  const items = {};
  for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
    const unitIds = EXPECTED_PROFILES[id].map((profile) => `${profile}:required-unit`);
    denominatorInputs[id] = { profiles: EXPECTED_PROFILES[id], unitIds, inventoryRefs: ['js/platform/stage2-profile-evidence.js'] };
  }
  const resolveDenominatorUnitIds = (id) => denominatorInputs[id]?.unitIds || [];
  const denominatorLock = createStage2DenominatorLock({ items: denominatorInputs }, { scope, resolveInventoryIdentity, resolveDenominatorUnitIds });
  const lockCheck = validateStage2DenominatorLock(denominatorLock, { scope, resolveInventoryIdentity, resolveDenominatorUnitIds });
  assert.equal(lockCheck.ok, true, JSON.stringify(lockCheck));
  const knownEvidence = new Set();
  for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
    const denominator = denominatorLock.items[id];
    const unitIds = denominator.unitIds;
    items[id] = {
      profileIds: [...EXPECTED_PROFILES[id]],
      candidateCommitSha: commitSha,
      candidateTreeSha: treeSha,
      denominatorId: denominator.id,
      denominatorLockHash: denominator.lockHash,
      coveredUnitIds: [...unitIds],
      unitEvidence: Object.fromEntries(unitIds.map((unitId) => [unitId, `evidence:${id}:${unitId}`])),
      realFixtureIdentities: [`fixture:${id}:real`],
      negativeTestIdentities: [`test:${id}:negative`],
      evidenceIdentities: [`evidence:${id}:aggregate`],
      providerProfileIds: id === 'S2-A7-NATIVE'
        ? ['native:lldb-compatible-v1:host', 'native:remote-debug-v1:qemu-lldb']
        : id.startsWith('S2-M6-')
          ? [`managed:${id.slice('S2-M6-'.length).toLowerCase()}:provider-bound-runtime-v1:test`]
          : [],
      implementationIdentity: `implementation:${id}`,
      independentOracleIdentities: id === 'S1-A2-NATIVE' || id.startsWith('S2-F6-') || id === 'S2-P12-COLLAB-REMOTE'
        ? [`oracle:${id}:independent`]
        : [],
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
  const baseline = validateStage2ProfileEvidence(record, expected);
  assert.equal(baseline.ok, true, JSON.stringify(baseline.failures));
  return { items, expected };
}

function validateWith(items) {
  const mutated = createStage2ProfileEvidence({ commitSha, treeSha, generatedAt: '2026-08-22T00:00:00Z', items });
  return validateStage2ProfileEvidence(mutated, buildHarness.expected);
}

test('#5809 a single valid managed provider profile keeps validating', () => {
  const { items, expected } = buildHarness();
  buildHarness.expected = expected;
  items['S2-M6-WASM'].providerProfileIds = ['managed:wasm:provider-bound-runtime-v1:test'];
  const check = validateWith(items);
  assert.equal(check.ok, true, JSON.stringify(check.failures));
});

test('#5809 valid + arbitrary invalid provider profile is rejected (M6)', () => {
  const { items, expected } = buildHarness();
  buildHarness.expected = expected;
  items['S2-M6-WASM'].providerProfileIds = [
    'managed:wasm:provider-bound-runtime-v1:test',
    'totally-invalid-provider-profile',
  ];
  const check = validateWith(items);
  assert.equal(check.ok, false, 'an extra invalid provider profile must not hide behind a valid one');
  assert.ok(check.failures.includes('S2-M6-WASM:provider-profile-invalid'));
});

test('#5809 valid + wrong-frontend provider profile is rejected (M6)', () => {
  const { items, expected } = buildHarness();
  buildHarness.expected = expected;
  items['S2-M6-WASM'].providerProfileIds = [
    'managed:wasm:provider-bound-runtime-v1:test',
    'managed:jvm:provider-bound-runtime-v1:wrong-frontend',
  ];
  const check = validateWith(items);
  assert.equal(check.ok, false, 'a wrong-frontend provider profile must not validate for WASM M6');
  assert.ok(check.failures.includes('S2-M6-WASM:provider-profile-invalid'));
});

test('#5809 all-invalid provider profiles are still rejected (M6)', () => {
  const { items, expected } = buildHarness();
  buildHarness.expected = expected;
  items['S2-M6-JVM'].providerProfileIds = ['managed:dex:provider-bound-runtime-v1:test'];
  const check = validateWith(items);
  assert.equal(check.ok, false);
  assert.ok(check.failures.includes('S2-M6-JVM:provider-profile-invalid'));
});

test('#5809 A7 exact provider set behavior is preserved', () => {
  const { items, expected } = buildHarness();
  buildHarness.expected = expected;
  items['S2-A7-NATIVE'].providerProfileIds = ['native:lldb-compatible-v1:host'];
  const check = validateWith(items);
  assert.equal(check.ok, false);
  assert.ok(check.failures.includes('S2-A7-NATIVE:provider-profile-set-mismatch'));
});

test('#5809 unvalidated records never mint capability proofs', () => {
  const { items, expected } = buildHarness();
  buildHarness.expected = expected;
  items['S2-M6-WASM'].providerProfileIds = [
    'managed:wasm:provider-bound-runtime-v1:test',
    'totally-invalid-provider-profile',
  ];
  const check = validateWith(items);
  assert.equal(check.ok, false);
  assert.throws(
    () => createStage2CapabilityProofs(check),
    /stage2-profile-validation-authority-required/,
    'an invalid validation record must not mint capability proofs',
  );
});
