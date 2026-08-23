import { deepFreeze, stableDigest } from '../core/identity/index.js';

export const STAGE2_PROFILE_EVIDENCE_SCHEMA = 'hex-stage2-profile-evidence/v2';
export const STAGE2_DENOMINATOR_LOCK_SCHEMA = 'hex-stage2-profile-denominators/v1';
export const STAGE2_PROFILE_EVIDENCE_IDS = Object.freeze([
  'S1-A2-NATIVE',
  'S2-A7-NATIVE',
  'S2-M6-WASM', 'S2-M6-DEX', 'S2-M6-CIL', 'S2-M6-JVM',
  'S2-F6-MACHO', 'S2-F6-ELF', 'S2-F6-PE',
  'S2-P12-KNOWLEDGE', 'S2-P12-RULES', 'S2-P12-PATTERNS', 'S2-P12-COLLAB-REMOTE',
]);

const EXPECTED_PROFILES = Object.freeze({
  'S1-A2-NATIVE': Object.freeze(['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc']),
  'S2-A7-NATIVE': Object.freeze(['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc']),
  'S2-M6-WASM': Object.freeze(['managed:wasm:m6']),
  'S2-M6-DEX': Object.freeze(['managed:dex:m6']),
  'S2-M6-CIL': Object.freeze(['managed:cil:m6']),
  'S2-M6-JVM': Object.freeze(['managed:jvm:m6']),
  'S2-F6-MACHO': Object.freeze(['macho:64']),
  'S2-F6-ELF': Object.freeze(['elf:64']),
  'S2-F6-PE': Object.freeze(['pe:pe32', 'pe:pe32+']),
  'S2-P12-KNOWLEDGE': Object.freeze(['knowledge-packages:v1']),
  'S2-P12-RULES': Object.freeze(['capability-rules:v1']),
  'S2-P12-PATTERNS': Object.freeze(['patterns:read-only-v1']),
  'S2-P12-COLLAB-REMOTE': Object.freeze(['collaboration:remote-security-v1']),
});
const VALID_PROFILE_VALIDATIONS = new WeakSet();
const VALID_PROFILE_RECORDS = new WeakMap();
const VALID_CAPABILITY_PROOFS = new WeakSet();

function sorted(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort(); }
function includesAll(values, expected) { const set = new Set(values); return expected.every((item) => set.has(item)); }
function same(values, expected) { const left = sorted(values); const right = sorted(expected); return left.length === right.length && left.every((item, index) => item === right[index]); }
function evidenceMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(key), String(item || '')]));
}
function payload(record) {
  return {
    schemaVersion: record.schemaVersion,
    commitSha: record.commitSha,
    treeSha: record.treeSha,
    generatedAt: record.generatedAt,
    items: record.items,
  };
}
function identity(record) { return `stage2-profile-evidence:${stableDigest(payload(record))}`; }

function scopeLockHash(scope) { return `stage2-scope-lock:${stableDigest(scope)}`; }
function denominatorItemPayload(item) {
  return {
    id: item.id,
    profiles: item.profiles,
    unitIds: item.unitIds,
    inventoryRefs: item.inventoryRefs,
    inventoryHash: item.inventoryHash,
  };
}
function denominatorItemHash(item) { return `stage2-denominator-item:${stableDigest(denominatorItemPayload(item))}`; }
function denominatorLockPayload(lock) {
  return {
    schemaVersion: lock.schemaVersion,
    scopeVersion: lock.scopeVersion,
    scopeLockHash: lock.scopeLockHash,
    items: lock.items,
  };
}
function denominatorLockHash(lock) { return `stage2-denominator-lock:${stableDigest(denominatorLockPayload(lock))}`; }
function expectedInventoryHash(refs, resolveInventoryIdentity) {
  const identities = refs.map((ref) => [ref, String(resolveInventoryIdentity(ref) || '')]);
  if (identities.some(([, value]) => !value)) throw new TypeError('stage2-denominator-inventory-ref-unresolved');
  return `stage2-denominator-inventory:${stableDigest(identities)}`;
}

export function createStage2DenominatorLock(input = {}, { scope, resolveInventoryIdentity } = {}) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new TypeError('stage2-denominator-scope-required');
  if (typeof resolveInventoryIdentity !== 'function') throw new TypeError('stage2-denominator-inventory-resolver-required');
  const items = {};
  for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
    const source = input.items?.[id] || {};
    const profiles = sorted(source.profiles);
    const unitIds = sorted(source.unitIds);
    const inventoryRefs = sorted(source.inventoryRefs);
    const item = {
      id: `stage2-denominator:${id}:v1`,
      profiles: Object.freeze(profiles),
      unitIds: Object.freeze(unitIds),
      inventoryRefs: Object.freeze(inventoryRefs),
      inventoryHash: expectedInventoryHash(inventoryRefs, resolveInventoryIdentity),
    };
    items[id] = deepFreeze({ ...item, lockHash: denominatorItemHash(item) });
  }
  const lock = {
    schemaVersion: STAGE2_DENOMINATOR_LOCK_SCHEMA,
    scopeVersion: String(scope.scopeVersion || ''),
    scopeLockHash: scopeLockHash(scope),
    items: deepFreeze(items),
  };
  return deepFreeze({ ...lock, lockHash: denominatorLockHash(lock) });
}

export function validateStage2DenominatorLock(lock, { scope, resolveInventoryIdentity } = {}) {
  if (!lock || lock.schemaVersion !== STAGE2_DENOMINATOR_LOCK_SCHEMA) return { ok: false, reason: 'stage2-denominator-lock-schema-invalid' };
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return { ok: false, reason: 'stage2-denominator-scope-required' };
  if (typeof resolveInventoryIdentity !== 'function') return { ok: false, reason: 'stage2-denominator-inventory-resolver-required' };
  if (lock.scopeVersion !== scope.scopeVersion || lock.scopeLockHash !== scopeLockHash(scope)) return { ok: false, reason: 'stage2-denominator-scope-lock-mismatch' };
  const failures = [];
  const itemIds = sorted(Object.keys(lock.items || {}));
  if (!same(itemIds, STAGE2_PROFILE_EVIDENCE_IDS)) failures.push('denominator-item-set-mismatch');
  for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
    const item = lock.items?.[id];
    if (!item || typeof item !== 'object' || Array.isArray(item)) { failures.push(`${id}:denominator-lock-missing`); continue; }
    const profiles = sorted(item.profiles);
    const unitIds = sorted(item.unitIds);
    const inventoryRefs = sorted(item.inventoryRefs);
    if (item.id !== `stage2-denominator:${id}:v1`) failures.push(`${id}:denominator-id-invalid`);
    if (!same(profiles, EXPECTED_PROFILES[id])) failures.push(`${id}:denominator-profile-set-mismatch`);
    if (unitIds.length === 0 || unitIds.length !== (Array.isArray(item.unitIds) ? item.unitIds.length : -1)) failures.push(`${id}:denominator-units-invalid`);
    for (const profile of EXPECTED_PROFILES[id]) {
      if (!unitIds.some((unitId) => unitId.startsWith(`${profile}:`))) failures.push(`${id}:denominator-profile-units-missing:${profile}`);
    }
    if (inventoryRefs.length === 0 || inventoryRefs.length !== (Array.isArray(item.inventoryRefs) ? item.inventoryRefs.length : -1)) failures.push(`${id}:denominator-inventory-refs-invalid`);
    let inventoryHash = null;
    try { inventoryHash = expectedInventoryHash(inventoryRefs, resolveInventoryIdentity); }
    catch { failures.push(`${id}:denominator-inventory-ref-unresolved`); }
    if (inventoryHash && item.inventoryHash !== inventoryHash) failures.push(`${id}:denominator-inventory-stale`);
    if (item.lockHash !== denominatorItemHash({ ...item, profiles, unitIds, inventoryRefs })) failures.push(`${id}:denominator-item-lock-mismatch`);
  }
  if (lock.lockHash !== denominatorLockHash(lock)) failures.push('denominator-root-lock-mismatch');
  return { ok: failures.length === 0, reason: failures.length ? 'stage2-denominator-lock-invalid' : null, failures, lockHash: lock.lockHash || null };
}

export function createStage2ProfileEvidence(input = {}) {
  const items = {};
  for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
    const source = input.items?.[id] || {};
    items[id] = deepFreeze({
      profileIds: Object.freeze(sorted(source.profileIds)),
      candidateCommitSha: String(source.candidateCommitSha || '').toLowerCase(),
      candidateTreeSha: String(source.candidateTreeSha || '').toLowerCase(),
      denominatorId: String(source.denominatorId || ''),
      denominatorLockHash: String(source.denominatorLockHash || '').toLowerCase(),
      coveredUnitIds: Object.freeze(sorted(source.coveredUnitIds)),
      unitEvidence: deepFreeze(evidenceMap(source.unitEvidence)),
      realFixtureIdentities: Object.freeze(sorted(source.realFixtureIdentities)),
      negativeTestIdentities: Object.freeze(sorted(source.negativeTestIdentities)),
      evidenceIdentities: Object.freeze(sorted(source.evidenceIdentities)),
      providerProfileIds: Object.freeze(sorted(source.providerProfileIds)),
      implementationIdentity: String(source.implementationIdentity || ''),
      independentOracleIdentities: Object.freeze(sorted(source.independentOracleIdentities)),
    });
  }
  const record = {
    schemaVersion: STAGE2_PROFILE_EVIDENCE_SCHEMA,
    commitSha: String(input.commitSha || '').toLowerCase(),
    treeSha: String(input.treeSha || '').toLowerCase(),
    generatedAt: String(input.generatedAt || ''),
    items: deepFreeze(items),
  };
  return deepFreeze({ ...record, evidenceId: identity(record) });
}

export function validateStage2ProfileEvidence(record, expected = {}) {
  if (!record || record.schemaVersion !== STAGE2_PROFILE_EVIDENCE_SCHEMA) return { ok: false, reason: 'stage2-profile-evidence-schema-invalid' };
  if (!/^[0-9a-f]{40}$/.test(record.commitSha || '')) return { ok: false, reason: 'stage2-profile-evidence-commit-invalid' };
  if (!/^[0-9a-f]{40}$/.test(record.treeSha || '')) return { ok: false, reason: 'stage2-profile-evidence-tree-invalid' };
  if (!Number.isFinite(Date.parse(record.generatedAt || ''))) return { ok: false, reason: 'stage2-profile-evidence-time-invalid' };
  if (record.evidenceId !== identity(record)) return { ok: false, reason: 'stage2-profile-evidence-tampered' };
  if (expected.commitSha && record.commitSha !== String(expected.commitSha).toLowerCase()) return { ok: false, reason: 'stage2-profile-evidence-stale-commit' };
  if (expected.treeSha && record.treeSha !== String(expected.treeSha).toLowerCase()) return { ok: false, reason: 'stage2-profile-evidence-stale-tree' };
  if (!expected.denominatorLock || typeof expected.denominatorLock !== 'object' || Array.isArray(expected.denominatorLock)) return { ok: false, reason: 'stage2-profile-evidence-denominator-lock-required' };
  const denominatorLock = validateStage2DenominatorLock(expected.denominatorLock, {
    scope: expected.scope,
    resolveInventoryIdentity: expected.resolveInventoryIdentity,
  });
  if (!denominatorLock.ok) return { ok: false, reason: denominatorLock.reason, failures: denominatorLock.failures || [] };
  const denominators = expected.denominatorLock.items;
  const failures = [];
  for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
    const item = record.items?.[id];
    const expectedProfiles = EXPECTED_PROFILES[id];
    if (!item) { failures.push(`${id}:missing`); continue; }
    const denominator = denominators[id];
    if (!denominator || typeof denominator !== 'object' || !Array.isArray(denominator.unitIds) || denominator.unitIds.length === 0) {
      failures.push(`${id}:denominator-lock-missing`);
      continue;
    }
    const profiles = sorted(item.profileIds);
    if (!includesAll(profiles, expectedProfiles)) failures.push(`${id}:profile-denominator-incomplete`);
    if (item.candidateCommitSha !== record.commitSha || item.candidateTreeSha !== record.treeSha) failures.push(`${id}:not-exact-head`);
    if (item.denominatorId !== denominator.id || item.denominatorLockHash !== denominator.lockHash) failures.push(`${id}:denominator-lock-mismatch`);
    if (!same(item.coveredUnitIds, denominator.unitIds)) failures.push(`${id}:denominator-not-complete`);
    for (const unitId of denominator.unitIds) if (!item.unitEvidence || typeof item.unitEvidence[unitId] !== 'string' || !item.unitEvidence[unitId]) failures.push(`${id}:unit-evidence-missing:${unitId}`);
    if (!Array.isArray(item.realFixtureIdentities) || item.realFixtureIdentities.length === 0) failures.push(`${id}:real-fixture-missing`);
    if (!Array.isArray(item.negativeTestIdentities) || item.negativeTestIdentities.length === 0) failures.push(`${id}:negative-tests-missing`);
    if (!Array.isArray(item.evidenceIdentities) || item.evidenceIdentities.length === 0) failures.push(`${id}:evidence-identity-missing`);
    if (!item.implementationIdentity) failures.push(`${id}:implementation-identity-missing`);
    if ((id === 'S1-A2-NATIVE' || id.startsWith('S2-F6-')) && (!Array.isArray(item.independentOracleIdentities) || item.independentOracleIdentities.length === 0 || item.independentOracleIdentities.includes(item.implementationIdentity))) failures.push(`${id}:independent-oracle-missing`);
    if ((id === 'S2-A7-NATIVE' || id.startsWith('S2-M6-')) && (!Array.isArray(item.providerProfileIds) || item.providerProfileIds.length === 0)) failures.push(`${id}:provider-profile-missing`);
  }
  const result = Object.freeze({ ok: failures.length === 0, reason: failures.length ? 'stage2-profile-evidence-incomplete' : null, failures: Object.freeze(failures), evidenceId: record.evidenceId });
  if (result.ok) {
    VALID_PROFILE_VALIDATIONS.add(result);
    VALID_PROFILE_RECORDS.set(result, record);
  }
  return result;
}

export function createStage2CapabilityProofs(validation) {
  if (!validation || !VALID_PROFILE_VALIDATIONS.has(validation)) throw new TypeError('stage2-profile-validation-authority-required');
  const record = VALID_PROFILE_RECORDS.get(validation);
  const proofs = {};
  for (const id of STAGE2_PROFILE_EVIDENCE_IDS) {
    const item = record.items[id];
    const proof = deepFreeze({
      authority: 'validated-stage2-profile-evidence',
      itemId: id,
      evidenceId: record.evidenceId,
      commitSha: record.commitSha,
      treeSha: record.treeSha,
      profileIds: item.profileIds,
      denominatorId: item.denominatorId,
      denominatorLockHash: item.denominatorLockHash,
      providerProfileIds: item.providerProfileIds,
      implementationIdentity: item.implementationIdentity,
      independentOracleIdentities: item.independentOracleIdentities,
    });
    VALID_CAPABILITY_PROOFS.add(proof);
    proofs[id] = proof;
  }
  return deepFreeze(proofs);
}

export function isValidatedStage2CapabilityProof(proof, { itemId, profileIds = [] } = {}) {
  if (!proof || !VALID_CAPABILITY_PROOFS.has(proof) || proof.authority !== 'validated-stage2-profile-evidence') return false;
  if (itemId && proof.itemId !== itemId) return false;
  return includesAll(sorted(proof.profileIds), sorted(profileIds));
}
