import { deepFreeze, jsonSafe, stableDigest } from '../core/identity/index.js';
import { isValidatedStage2CapabilityProof } from '../platform/stage2-profile-evidence.js';
import { CHANGELOG_SCHEMA_VERSION, ChangeLog, createProjectOperation, canonicalizeProjectOperation, isCanonicalProjectOperation } from './index.js';
import { applyRemoteEnvelopeQueued } from './remote-delivery.js';

export const REMOTE_COLLAB_SCHEMA = 'hex-remote-collaboration-envelope/v1';
export const REMOTE_GATE_SCHEMA = 'hex-remote-collaboration-gate/v1';
export const REMOTE_SECURITY_PROFILE_ID = 'collaboration:remote-security-v1';
const VALID_REMOTE_COLLABORATION_SUPPORT = new WeakSet();
const VERIFIED_TRANSPORT_PROOFS = new WeakMap();
const VALIDATED_REMOTE_SNAPSHOTS = new WeakMap();
const MAX_MESSAGE_ID_LENGTH = 512;

function validMessageId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_MESSAGE_ID_LENGTH && value.trim().length > 0;
}

function required(value, code) {
  if (typeof value !== 'string') throw new TypeError(code);
  const text = value.trim();
  if (!text) throw new TypeError(code);
  return text;
}

function validRawIdentity(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function positive(value, fallback, max, code) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new TypeError(code);
  return n;
}

function validSequence(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function list(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort();
}

function identityList(value, code) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((identity) => required(identity, code)))].sort();
}

function permissionList(value) {
  if (!Array.isArray(value)) return [];
  const permissions = [];
  for (const permission of value) {
    if (typeof permission !== 'string' || permission.length === 0) {
      throw new TypeError('remote-gate-permission-invalid');
    }
    permissions.push(permission);
  }
  return [...new Set(permissions)].sort();
}

function byteLength(value) {
  const text = JSON.stringify(jsonSafe(value));
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
}

function normalizePermissions(value) {
  const entries = value instanceof Map
    ? [...value.entries()]
    : (!value || typeof value !== 'object' || Array.isArray(value) ? [] : Object.entries(value));
  const normalized = Object.create(null);
  for (const [actor, permissions] of entries) {
    const identity = required(actor, 'remote-gate-actor-identity-invalid');
    if (Object.hasOwn(normalized, identity)) throw new TypeError('remote-gate-actor-identity-duplicate');
    normalized[identity] = permissionList(permissions);
  }
  return normalized;
}

function isPlainRecord(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const SNAPSHOT_SCAN_DEPTH_LIMIT = 64;

function hasAccessorProperty(owner, key) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  return typeof descriptor === 'object' && descriptor !== null
    && (typeof descriptor.get === 'function' || typeof descriptor.set === 'function');
}

const SHARED_ARRAY_BUFFER_BYTE_LENGTH = typeof SharedArrayBuffer === 'undefined'
  ? null
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get ?? null;

function isSharedArrayBuffer(value) {
  if (!SHARED_ARRAY_BUFFER_BYTE_LENGTH || value == null || typeof value !== 'object') return false;
  try {
    SHARED_ARRAY_BUFFER_BYTE_LENGTH.call(value);
    return true;
  } catch {
    return false;
  }
}

function isSharedMemory(value) {
  if (isSharedArrayBuffer(value)) return true;
  if (!ArrayBuffer.isView(value)) return false;
  return isSharedArrayBuffer(value.buffer);
}

function scanMapEntries(value, depth, seen) {
  let entries;
  try { entries = Map.prototype.entries.call(value); }
  catch { return null; }
  for (const [key, item] of entries) {
    if (!scanForSnapshotUnsafeValues(key, depth + 1, seen)) return false;
    if (!scanForSnapshotUnsafeValues(item, depth + 1, seen)) return false;
  }
  return true;
}

function scanSetValues(value, depth, seen) {
  let values;
  try { values = Set.prototype.values.call(value); }
  catch { return null; }
  for (const item of values) {
    if (!scanForSnapshotUnsafeValues(item, depth + 1, seen)) return false;
  }
  return true;
}

function scanForSnapshotUnsafeValues(value, depth, seen) {
  if (value == null || typeof value !== 'object') return true;
  if (isSharedMemory(value)) return false;
  if (depth > SNAPSHOT_SCAN_DEPTH_LIMIT) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  const mapSafe = scanMapEntries(value, depth, seen);
  if (mapSafe !== null) return mapSafe;
  const setSafe = scanSetValues(value, depth, seen);
  if (setSafe !== null) return setSafe;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  for (const key of Object.keys(value)) {
    if (hasAccessorProperty(value, key)) return false;
    if (!scanForSnapshotUnsafeValues(value[key], depth + 1, seen)) return false;
  }
  return true;
}

function snapshotRemoteEnvelope(envelope) {
  if (!isPlainRecord(envelope)) return null;
  if (!scanForSnapshotUnsafeValues(envelope, 0, new Set())) return null;
  let snapshot;
  try {
    snapshot = structuredClone(envelope);
  } catch {
    return null;
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  return deepFreeze(snapshot);
}

function isCanonicalRemoteOperation(operation) {
  if (!isPlainRecord(operation)) return false;
  const canonical = canonicalizeProjectOperation(operation);
  return canonical != null
    && isCanonicalProjectOperation(canonical)
    && stableDigest(operation) === stableDigest(canonical);
}

function authorized(permissions, operation) {
  if (permissions.includes('*')) return true;
  const fact = `fact:${operation.factKind}`;
  const action = `action:${operation.action}`;
  const combined = `${fact}:action:${operation.action}`;
  return permissions.includes(combined) || (permissions.includes(fact) && permissions.includes(action));
}

export function envelopeIdentity(envelope) {
  const { envelopeId, ...payload } = envelope;
  return `remote-envelope:${stableDigest(payload)}`;
}

export function createRemoteCollaborationEnvelope(input = {}) {
  const projectIdentity = required(input.projectIdentity, 'remote-project-identity-required');
  const binaryIdentity = input.binaryIdentity == null ? null : required(input.binaryIdentity, 'remote-binary-identity-invalid');
  const sessionIdentity = required(input.sessionIdentity, 'remote-session-identity-required');
  const actorIdentity = required(input.actorIdentity, 'remote-actor-identity-required');
  const deviceIdentity = required(input.deviceIdentity, 'remote-device-identity-required');
  const messageId = required(input.messageId, 'remote-message-id-required');
  const sequence = input.sequence;
  if (!validSequence(sequence)) throw new TypeError('remote-sequence-invalid');
  if (!Array.isArray(input.operations) || input.operations.length === 0) throw new TypeError('remote-operations-required');
  const operations = input.operations.map((operation) => createProjectOperation({
    ...operation,
    projectIdentity,
    binaryIdentity,
    authorIdentity: actorIdentity,
    deviceIdentity,
    provenance: { ...(operation.provenance || {}), source: 'collaborator', transport: 'remote', actorIdentity, deviceIdentity },
  }));
  const envelope = {
    schemaVersion: REMOTE_COLLAB_SCHEMA,
    operationSchemaVersion: CHANGELOG_SCHEMA_VERSION,
    projectIdentity,
    binaryIdentity,
    sessionIdentity,
    actorIdentity,
    deviceIdentity,
    messageId,
    sequence,
    operations,
    transportProof: {
      authenticated: input.transportProof?.authenticated === true,
      confidentiality: input.transportProof?.confidentiality === 'verified' ? 'verified' : 'unverified',
      integrity: input.transportProof?.integrity === 'verified' ? 'verified' : 'unverified',
      proofIdentity: input.transportProof?.proofIdentity == null
        ? null
        : required(input.transportProof.proofIdentity, 'remote-transport-proof-identity-invalid'),
    },
    egress: {
      userAuthorized: input.egress?.userAuthorized === true,
      rawBinaryBytes: input.egress?.rawBinaryBytes === true,
      derivedDataOnly: input.egress?.derivedDataOnly !== false,
    },
  };
  return deepFreeze({ ...envelope, envelopeId: envelopeIdentity(envelope) });
}

export class RemoteCollaborationGate {
  constructor(input = {}) {
    this.schemaVersion = REMOTE_GATE_SCHEMA;
    this.projectIdentity = required(input.projectIdentity, 'remote-gate-project-required');
    this.binaryIdentity = input.binaryIdentity == null ? null : required(input.binaryIdentity, 'remote-gate-binary-invalid');
    this.sessionIdentity = required(input.sessionIdentity, 'remote-gate-session-required');
    this.allowedActors = normalizePermissions(input.allowedActors);
    this.revokedActors = new Set(identityList(input.revokedActors, 'remote-gate-revoked-actor-invalid'));
    this.supportedEnvelopeSchemas = new Set(list(input.supportedEnvelopeSchemas || [REMOTE_COLLAB_SCHEMA]));
    this.supportedOperationSchemas = new Set(list(input.supportedOperationSchemas || [CHANGELOG_SCHEMA_VERSION]));
    this.maxBatch = positive(input.maxBatch, 256, 4096, 'remote-gate-max-batch-invalid');
    this.maxMessageBytes = positive(input.maxMessageBytes, 1024 * 1024, 32 * 1024 * 1024, 'remote-gate-max-message-invalid');
    this.seenMessages = new Set();
    this.seenEnvelopeIds = new Set();
    this.lastSequenceByActor = new Map();
    this.verifyTransportProof = typeof input.verifyTransportProof === 'function' ? input.verifyTransportProof : null;
    this.transportVerifierIdentity = input.transportVerifierIdentity == null
      ? null
      : required(input.transportVerifierIdentity, 'remote-gate-transport-verifier-identity-invalid');
  }

  validate(envelope) {
    VERIFIED_TRANSPORT_PROOFS.delete(this);
    VALIDATED_REMOTE_SNAPSHOTS.delete(envelope);
    const snap = snapshotRemoteEnvelope(envelope);
    if (!snap) return { ok: false, reason: 'remote-envelope-shape-invalid' };
    if (!this.supportedEnvelopeSchemas.has(snap.schemaVersion)) return { ok: false, reason: 'remote-envelope-schema-unsupported' };
    if (!this.supportedOperationSchemas.has(snap.operationSchemaVersion)) return { ok: false, reason: 'remote-operation-schema-unsupported' };
    if (!validRawIdentity(snap.projectIdentity)) return { ok: false, reason: 'remote-project-identity-required' };
    if (snap.binaryIdentity != null && !validRawIdentity(snap.binaryIdentity)) return { ok: false, reason: 'remote-binary-identity-invalid' };
    if (!validRawIdentity(snap.sessionIdentity)) return { ok: false, reason: 'remote-session-identity-required' };
    if (!validRawIdentity(snap.actorIdentity)) return { ok: false, reason: 'remote-actor-identity-required' };
    if (!validRawIdentity(snap.deviceIdentity)) return { ok: false, reason: 'remote-device-identity-required' };
    if (!validRawIdentity(snap.messageId)) return { ok: false, reason: 'remote-message-id-required' };
    if (snap.projectIdentity !== this.projectIdentity) return { ok: false, reason: 'remote-wrong-project' };
    if ((snap.binaryIdentity ?? null) !== this.binaryIdentity) return { ok: false, reason: 'remote-wrong-binary' };
    if (snap.sessionIdentity !== this.sessionIdentity) return { ok: false, reason: 'remote-wrong-session' };
    if (!validSequence(snap.sequence)) return { ok: false, reason: 'remote-sequence-invalid' };
    if (!validMessageId(snap.messageId)) return { ok: false, reason: 'remote-message-id-invalid' };
    if (typeof snap.envelopeId !== 'string' || snap.envelopeId !== envelopeIdentity(snap)) return { ok: false, reason: 'remote-envelope-identity-mismatch' };
    if (this.revokedActors.has(snap.actorIdentity)) return { ok: false, reason: 'remote-actor-revoked' };
    const permissions = Object.hasOwn(this.allowedActors, snap.actorIdentity) ? this.allowedActors[snap.actorIdentity] : null;
    if (!permissions) return { ok: false, reason: 'remote-actor-unauthorized' };
    if (this.seenMessages.has(snap.messageId) || this.seenEnvelopeIds.has(snap.envelopeId)) return { ok: false, reason: 'remote-replay-or-duplicate' };
    const previous = this.lastSequenceByActor.get(snap.actorIdentity);
    if (previous != null && snap.sequence <= previous) return { ok: false, reason: 'remote-stale-sequence' };
    if (!Array.isArray(snap.operations) || snap.operations.length === 0 || snap.operations.length > this.maxBatch) return { ok: false, reason: 'remote-batch-budget-exceeded' };
    if (byteLength(snap) > this.maxMessageBytes) return { ok: false, reason: 'remote-message-budget-exceeded' };
    if (snap.transportProof?.authenticated !== true || snap.transportProof?.confidentiality !== 'verified' || snap.transportProof?.integrity !== 'verified') {
      return { ok: false, reason: 'remote-transport-security-unverified' };
    }
    if (!this.verifyTransportProof) return { ok: false, reason: 'remote-transport-proof-verifier-required' };
    let verified = false;
    try { verified = this.verifyTransportProof(snap.transportProof, snap) === true; }
    catch { return { ok: false, reason: 'remote-transport-proof-rejected' }; }
    if (!verified) return { ok: false, reason: 'remote-transport-proof-rejected' };
    if (snap.egress?.userAuthorized !== true) return { ok: false, reason: 'remote-egress-user-authorization-required' };
    if (snap.egress?.rawBinaryBytes === true || snap.egress?.derivedDataOnly !== true) return { ok: false, reason: 'remote-raw-binary-egress-forbidden' };
    for (const operation of snap.operations) {
      if (!isCanonicalRemoteOperation(operation)) return { ok: false, reason: 'remote-operation-shape-invalid' };
      if (operation.projectIdentity !== this.projectIdentity || (operation.binaryIdentity ?? null) !== this.binaryIdentity) return { ok: false, reason: 'remote-operation-scope-mismatch' };
      if (operation.authorIdentity !== snap.actorIdentity || operation.deviceIdentity !== snap.deviceIdentity) return { ok: false, reason: 'remote-operation-actor-binding-mismatch' };
      if (operation.provenance?.transport !== 'remote') return { ok: false, reason: 'remote-operation-provenance-invalid' };
      if (!authorized(permissions, operation)) return { ok: false, reason: 'remote-operation-not-authorized', factKind: operation.factKind, action: operation.action };
    }
    VALIDATED_REMOTE_SNAPSHOTS.set(envelope, snap);
    VERIFIED_TRANSPORT_PROOFS.set(this, Object.freeze({
      envelopeId: snap.envelopeId,
      verifier: this.verifyTransportProof,
      verifierIdentity: this.transportVerifierIdentity,
    }));
    return { ok: true };
  }

  validatedSnapshot(envelope) {
    return VALIDATED_REMOTE_SNAPSHOTS.get(envelope) ?? null;
  }

  accept(envelope) {
    const checked = this.validate(envelope);
    if (!checked.ok) return Object.freeze({ status: 'rejected', reason: checked.reason });
    const snap = this.validatedSnapshot(envelope);
    if (!snap) return Object.freeze({ status: 'rejected', reason: 'remote-ingress-snapshot-required' });
    this.seenMessages.add(snap.messageId);
    this.seenEnvelopeIds.add(snap.envelopeId);
    this.lastSequenceByActor.set(snap.actorIdentity, snap.sequence);
    return Object.freeze({ status: 'accepted', envelopeId: snap.envelopeId, operationCount: snap.operations.length });
  }

  revoke(actorIdentity) {
    this.revokedActors.add(required(actorIdentity, 'remote-revoke-actor-required'));
  }

  snapshot() {
    return deepFreeze({
      schemaVersion: this.schemaVersion,
      projectIdentity: this.projectIdentity,
      binaryIdentity: this.binaryIdentity,
      sessionIdentity: this.sessionIdentity,
      actors: Object.keys(this.allowedActors).sort(),
      revokedActors: [...this.revokedActors].sort(),
      seenMessageCount: this.seenMessages.size,
      transportVerifierIdentity: this.transportVerifierIdentity,
    });
  }
}

export function applyRemoteEnvelope(log, gate, envelope) {
  return applyRemoteEnvelopeQueued(log, gate, envelope);
}

export class RemoteCollaborationChannel {
  constructor({ gate, log, transport } = {}) {
    if (!(gate instanceof RemoteCollaborationGate)) throw new TypeError('RemoteCollaborationGate required');
    if (!(log instanceof ChangeLog)) throw new TypeError('ChangeLog required');
    if (!transport || typeof transport.send !== 'function') throw new TypeError('remote-transport-send-required');
    this.gate = gate;
    this.log = log;
    this.transport = transport;
  }

  async send(envelope) {
    const checked = this.gate.validate(envelope);
    if (!checked.ok) return { status: 'rejected', reason: checked.reason };
    const snap = this.gate.validatedSnapshot(envelope);
    if (!snap) return { status: 'rejected', reason: 'remote-ingress-snapshot-required' };
    await this.transport.send(snap);
    return { status: 'sent', envelopeId: snap.envelopeId };
  }

  receive(envelope) {
    return applyRemoteEnvelopeQueued(this.log, this.gate, envelope);
  }
}

export function remoteCollaborationSupport({
  gate,
  profileProof = null,
  expectedCommitSha = null,
  expectedTreeSha = null,
} = {}) {
  const commitSha = String(expectedCommitSha || '').toLowerCase();
  const treeSha = String(expectedTreeSha || '').toLowerCase();
  const exactIdentity = /^[0-9a-f]{40}$/.test(commitSha) && /^[0-9a-f]{40}$/.test(treeSha);
  const brandedProfile = isValidatedStage2CapabilityProof(profileProof, {
    itemId: 'S2-P12-COLLAB-REMOTE',
    profileIds: [REMOTE_SECURITY_PROFILE_ID],
  });
  const transportVerifierIdentity = gate instanceof RemoteCollaborationGate ? gate.transportVerifierIdentity : null;
  const transportVerifierBound = typeof transportVerifierIdentity === 'string'
    && Array.isArray(profileProof?.independentOracleIdentities)
    && profileProof.independentOracleIdentities.includes(transportVerifierIdentity);
  const activeTransportProof = gate instanceof RemoteCollaborationGate ? VERIFIED_TRANSPORT_PROOFS.get(gate) : null;
  const activeVerificationBound = !!activeTransportProof
    && activeTransportProof.verifier === gate.verifyTransportProof
    && activeTransportProof.verifierIdentity === transportVerifierIdentity;
  const ready = gate instanceof RemoteCollaborationGate
    && typeof gate.verifyTransportProof === 'function'
    && transportVerifierBound
    && activeVerificationBound
    && exactIdentity
    && brandedProfile
    && profileProof.commitSha === commitSha
    && profileProof.treeSha === treeSha;
  const result = Object.freeze({
    status: ready ? 'supported-for-exact-security-profile' : 'unsupported',
    securityProfileId: ready ? REMOTE_SECURITY_PROFILE_ID : null,
    authority: ready ? 'remote-authorized-canonical-operations' : 'none',
    evidenceId: ready ? profileProof.evidenceId : null,
  });
  if (ready) VALID_REMOTE_COLLABORATION_SUPPORT.add(result);
  return result;
}

export function isValidatedRemoteCollaborationSupport(value) {
  return !!value && VALID_REMOTE_COLLABORATION_SUPPORT.has(value) && value.status === 'supported-for-exact-security-profile';
}
