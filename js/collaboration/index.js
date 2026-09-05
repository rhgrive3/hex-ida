import { deepFreeze, stableDigest } from '../core/identity/index.js';
import { createOperationIdentity, assertIdentityMatch } from '../phase12/identity.js';

export const CHANGELOG_SCHEMA_VERSION = 'hex-project-operation-v1';
export const CHECKPOINT_SCHEMA_VERSION = 'hex-project-checkpoint-v1';
const MEANINGFUL_FACTS = new Set(['name', 'type', 'struct', 'confirmation', 'patch']);
const OPERATION_ACTIONS = new Set(['set', 'remove', 'resolve', 'resurrect']);
// Factory provenance is not a transport grant or a payload-integrity proof.
// Never infer canonical identity validation from an untrusted schema tag.
const CANONICAL_PROJECT_OPERATIONS = new WeakSet();

function required(value, code) { if (typeof value !== 'string') throw new TypeError(code); const text = value.trim(); if (!text) throw new TypeError(code); return text; }
function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  const out = {};
  for (const [key, item] of Object.entries(value)) Object.defineProperty(out, key, { value: clone(item), enumerable: true, configurable: true, writable: true });
  return out;
}
function list(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('operation-causal-parents-invalid');
  return [...new Set(value.map((parent) => required(parent, 'operation-causal-parent-invalid')))].sort();
}
function factKey(target, kind) { return `${target}\u0000${kind}`; }
function payloadDigest(value) { return stableDigest(value); }
// The identity an operationId is bound to: everything that decides state
// semantics. Two operations sharing an ID must agree on all of it, otherwise
// replicas silently fork under an identical ID set (#5397).
function semanticDigest(operation) {
  return payloadDigest({
    projectIdentity: operation.projectIdentity,
    binaryIdentity: operation.binaryIdentity ?? null,
    targetEntityId: operation.targetEntityId,
    factKind: operation.factKind,
    action: operation.action,
    payload: operation.payload ?? null,
    beforeFingerprint: operation.beforeFingerprint ?? null,
    causalParents: operation.causalParents ?? [],
  });
}

export function createProjectOperation(input = {}) {
  if (input.schemaVersion != null && input.schemaVersion !== CHANGELOG_SCHEMA_VERSION) throw new TypeError('operation-schema-version-unsupported');
  const projectIdentity = required(input.projectIdentity ?? input.projectId, 'operation-project-identity-required');
  const targetEntityId = required(input.targetEntityId ?? input.entityId, 'operation-target-entity-required');
  const factKind = required(input.factKind, 'operation-fact-kind-required');
  const actionInput = input.action ?? 'set';
  if (typeof actionInput !== 'string' || !actionInput.trim()) throw new TypeError('operation-action-required');
  const action = actionInput;
  if (!OPERATION_ACTIONS.has(action)) throw new TypeError('operation-action-unsupported');
  const payload = clone(input.payload ?? input.value ?? null);
  const operationId = required(input.operationId ?? `op:${stableDigest({ projectIdentity, binaryIdentity: input.binaryIdentity || null, targetEntityId, factKind, action, payload, beforeFingerprint: input.beforeFingerprint || null, causalParents: list(input.causalParents) })}`, 'operation-id-required');
  const operation = {
    schemaVersion: CHANGELOG_SCHEMA_VERSION,
    operationId,
    projectIdentity,
    binaryIdentity: input.binaryIdentity == null ? null : required(input.binaryIdentity, 'operation-binary-identity-invalid'),
    authorIdentity: input.authorIdentity == null ? null : required(input.authorIdentity, 'operation-author-identity-invalid'),
    deviceIdentity: input.deviceIdentity == null ? null : required(input.deviceIdentity, 'operation-device-identity-invalid'),
    timestampHint: input.timestampHint == null ? null : String(input.timestampHint),
    causalParents: list(input.causalParents),
    targetEntityId,
    factKind,
    action,
    beforeFingerprint: input.beforeFingerprint == null ? null : String(input.beforeFingerprint),
    payload,
    provenance: clone(input.provenance || { source: 'local', actorIdentity: input.authorIdentity || null }),
  };
  deepFreeze(operation);
  CANONICAL_PROJECT_OPERATIONS.add(operation);
  return operation;
}

export function isCanonicalProjectOperation(value) {
  return CANONICAL_PROJECT_OPERATIONS.has(value);
}

function requireCanonicalProjectOperation(input) {
  return isCanonicalProjectOperation(input) ? input : createProjectOperation(input);
}

// The remote gate expects malformed records to normalize to no authority.
// Throwing ingress APIs use the same validator without swallowing its error.
export function canonicalizeProjectOperation(input) {
  try { return requireCanonicalProjectOperation(input); }
  catch { return null; }
}

function rememberRestoredOperation(map, operation) {
  const existing = map.get(operation.operationId);
  if (existing && semanticDigest(existing) !== semanticDigest(operation)) throw new TypeError('operation-id-content-mismatch');
  if (!existing) map.set(operation.operationId, operation);
}

function operationActionReason(action) {
  if (typeof action !== 'string') return 'operation-action-required';
  return OPERATION_ACTIONS.has(action) ? null : 'operation-action-unsupported';
}

function rawActionRejection(input) {
  if (input?.schemaVersion !== CHANGELOG_SCHEMA_VERSION) return null;
  const reason = operationActionReason(input.action);
  return reason ? Object.freeze({ status: 'rejected', reason }) : null;
}

function compareOperations(a, b) { return a.operationId.localeCompare(b.operationId); }

export function orderOperations(operations = [], existingIds = new Set()) {
  const unique = new Map();
  for (const input of operations) {
    const operation = requireCanonicalProjectOperation(input);
    const existing = unique.get(operation.operationId);
    if (existing) {
      if (semanticDigest(existing) !== semanticDigest(operation)) throw new TypeError('operation-id-content-mismatch');
      continue;
    }
    unique.set(operation.operationId, operation);
  }
  const remaining = new Map(unique);
  const seen = new Set(existingIds);
  const ordered = [];
  const unresolved = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter((operation) => operation.causalParents.every((parent) => seen.has(parent))).sort(compareOperations);
    if (!ready.length) { unresolved.push(...[...remaining.values()].sort(compareOperations)); break; }
    for (const operation of ready) { remaining.delete(operation.operationId); ordered.push(operation); seen.add(operation.operationId); }
  }
  return Object.freeze({ ordered, unresolved });
}

function emptyState(projectIdentity, binaryIdentity) {
  return { schemaVersion: CHANGELOG_SCHEMA_VERSION, projectIdentity, binaryIdentity: binaryIdentity || null, facts: {}, conflicts: [], tombstones: [], unresolved: [] };
}

function cloneState(state) { return clone(state); }

function permanentlyBlockedOp(log, operationId) {
  return (log.state?.unresolved || []).some((item) => item?.operationId === operationId && item?.reason === 'tombstone-protects-state');
}

export class ChangeLog {
  constructor(options = {}) {
    this.projectIdentity = required(options.projectIdentity ?? options.projectId, 'changelog-project-identity-required');
    this.binaryIdentity = options.binaryIdentity == null ? null : required(options.binaryIdentity, 'changelog-binary-identity-invalid');
    this.state = cloneState(options.state || emptyState(this.projectIdentity, this.binaryIdentity));
    this.operations = new Map();
    for (const input of options.operations ?? []) {
      rememberRestoredOperation(this.operations, requireCanonicalProjectOperation(input));
    }
    this.pending = new Map();
    for (const [key, input] of options.pending ?? []) {
      const operation = requireCanonicalProjectOperation(input);
      if (required(key, 'changelog-pending-key-invalid') !== operation.operationId) throw new TypeError('changelog-pending-id-mismatch');
      const applied = this.operations.get(operation.operationId);
      if (applied && semanticDigest(applied) !== semanticDigest(operation)) throw new TypeError('operation-id-content-mismatch');
      rememberRestoredOperation(this.pending, operation);
    }
    this.allowRemote = options.allowRemote === true;
    this.authorizedAuthors = new Set((options.authorizedAuthors ?? []).map((author) => required(author, 'changelog-author-identity-invalid')));
  }

  #validate(operation) {
    if (operation.schemaVersion !== CHANGELOG_SCHEMA_VERSION) return { status: 'rejected', reason: 'schema-version-unsupported' };
    const actionReason = operationActionReason(operation.action);
    if (actionReason) return { status: 'rejected', reason: actionReason };
    if (operation.projectIdentity !== this.projectIdentity) return { status: 'rejected', reason: 'wrong-project-identity' };
    if (this.binaryIdentity !== operation.binaryIdentity) return { status: 'rejected', reason: 'wrong-binary-identity' };
    if (operation.provenance?.transport === 'remote') {
      if (!this.allowRemote) return { status: 'rejected', reason: 'remote-transport-security-gate-required' };
      if (!operation.authorIdentity || !this.authorizedAuthors.has(operation.authorIdentity)) return { status: 'rejected', reason: 'unauthorized-remote-actor' };
    }
    if (operation.causalParents.some((parent) => !this.operations.has(parent))) return { status: 'unresolved', reason: 'missing-causal-parent' };
    return null;
  }

  #applyOne(operation) {
    const validation = this.#validate(operation);
    if (validation) return validation;
    if (this.operations.has(operation.operationId)) {
      const existing = this.operations.get(operation.operationId);
      if (semanticDigest(existing) !== semanticDigest(operation)) {
        return { status: 'rejected', reason: 'operation-id-content-mismatch', operationId: operation.operationId };
      }
      return { status: 'duplicate', operationId: operation.operationId };
    }
    const key = factKey(operation.targetEntityId, operation.factKind);
    const current = this.state.facts[key] || null;
    if (operation.action !== 'resolve' && operation.action !== 'remove' && this.state.tombstones.some((item) => item.key === key) && operation.action !== 'resurrect') {
      this.state.unresolved.push({ operationId: operation.operationId, reason: 'tombstone-protects-state', key });
      this.pending.set(operation.operationId, operation);
      return { status: 'unresolved', reason: 'tombstone-protects-state' };
    }
    if (operation.beforeFingerprint != null && (!current || current.stateFingerprint !== operation.beforeFingerprint)) {
      this.state.conflicts.push({ type: 'stale-precondition', key, operationId: operation.operationId, expected: operation.beforeFingerprint, observed: current?.stateFingerprint || null });
      this.operations.set(operation.operationId, operation);
      return { status: 'conflict', operationId: operation.operationId, reason: 'stale-before-fingerprint' };
    }
    if (operation.action === 'remove') {
      delete this.state.facts[key];
      this.state.tombstones.push({ key, operationId: operation.operationId, targetEntityId: operation.targetEntityId, factKind: operation.factKind });
      this.operations.set(operation.operationId, operation);
      return { status: 'applied', operationId: operation.operationId, effect: 'tombstone' };
    }
    if (operation.action === 'resolve') {
      if (!current || !current.values.some((item) => item.operationId === operation.payload?.operationId)) return { status: 'rejected', reason: 'resolution-target-missing' };
      current.resolvedOperationId = operation.payload.operationId;
      this.operations.set(operation.operationId, operation);
      return { status: 'applied', operationId: operation.operationId, effect: 'resolution' };
    }
    if (operation.action === 'resurrect') {
      this.state.tombstones = this.state.tombstones.filter((item) => item.key !== key);
      this.state.unresolved = this.state.unresolved.filter((item) => !(item.key === key && item.reason === 'tombstone-protects-state'));
    }
    const candidate = { operationId: operation.operationId, value: clone(operation.payload), provenance: clone(operation.provenance), timestampHint: operation.timestampHint };
    const candidateDigest = payloadDigest(candidate.value);
    const previous = current?.values.find((item) => payloadDigest(item.value) === candidateDigest);
    if (previous) { this.operations.set(operation.operationId, operation); return { status: 'applied', operationId: operation.operationId, effect: 'idempotent-value' }; }
    const record = current || { key, targetEntityId: operation.targetEntityId, factKind: operation.factKind, values: [], resolvedOperationId: null, stateFingerprint: null };
    record.values.push(candidate);
    record.values.sort((a, b) => a.operationId.localeCompare(b.operationId));
    record.stateFingerprint = payloadDigest(record.values.map((item) => ({ operationId: item.operationId, value: item.value })));
    this.state.facts[key] = record;
    if (MEANINGFUL_FACTS.has(operation.factKind) && record.values.length > 1) this.state.conflicts.push({ type: 'meaningful-conflict', key, factKind: operation.factKind, operationIds: record.values.map((item) => item.operationId) });
    this.operations.set(operation.operationId, operation);
    return { status: record.values.length > 1 && MEANINGFUL_FACTS.has(operation.factKind) ? 'conflict' : 'applied', operationId: operation.operationId, effect: record.values.length > 1 ? 'preserved-competing-value' : 'fact' };
  }

  // Drain pending operations whose causal parents all arrived, to a fixed
  // point in deterministic ID order. Tombstone-protected entries are never
  // retried (that used to delete/requeue forever); a rejection stops the
  // drain like the remote-delivery equivalent. Operates on #applyOne directly
  // so draining never recurses through applyOperation (#5399).
  #drainPending() {
    const drained = [];
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [operationId, operation] of [...this.pending.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (!operation.causalParents.every((parent) => this.operations.has(parent))) continue;
        if (permanentlyBlockedOp(this, operationId)) continue;
        this.pending.delete(operationId);
        const result = this.#applyOne(operation);
        if (result.status === 'unresolved') this.pending.set(operation.operationId, operation);
        else this.pending.delete(operation.operationId);
        drained.push(Object.freeze({ ...result, operationId: operation.operationId }));
        if (result.status === 'rejected') return drained;
        if (result.status !== 'unresolved') progressed = true;
      }
    }
    return drained;
  }

  applyOperation(input) {
    const actionRejection = rawActionRejection(input);
    if (actionRejection) return actionRejection;
    const operation = requireCanonicalProjectOperation(input);
    const existingPending = this.pending.get(operation.operationId);
    if (existingPending && semanticDigest(existingPending) !== semanticDigest(operation)) {
      return Object.freeze({
        status: 'rejected',
        reason: 'operation-id-content-mismatch',
        operationId: operation.operationId,
        stateDigest: this.digest(),
      });
    }
    const result = this.#applyOne(operation);
    if (result.status === 'unresolved') {
      if (!existingPending) this.pending.set(operation.operationId, operation);
    } else {
      this.pending.delete(operation.operationId);
    }
    let surfaced = result;
    if (result.status !== 'rejected') {
      const drained = this.#drainPending();
      const drainRejection = drained.find((entry) => entry.status === 'rejected');
      if (drainRejection) surfaced = drainRejection;
    }
    return Object.freeze({ ...surfaced, operationId: surfaced.operationId ?? operation.operationId, stateDigest: this.digest() });
  }

  applyBatch(inputs = []) {
    for (const input of inputs) {
      const actionRejection = rawActionRejection(input);
      if (actionRejection) return actionRejection;
    }
    const operations = inputs.map((input) => requireCanonicalProjectOperation(input));
    const ordered = orderOperations(operations, new Set(this.operations.keys()));
    if (ordered.unresolved.length) return Object.freeze({ status: 'unresolved', reason: 'missing-causal-parent', operationIds: ordered.unresolved.map((operation) => operation.operationId), stateDigest: this.digest() });
    const working = new ChangeLog({ projectIdentity: this.projectIdentity, binaryIdentity: this.binaryIdentity, state: this.state, operations: [...this.operations.values()], pending: [...this.pending.entries()], allowRemote: this.allowRemote, authorizedAuthors: [...this.authorizedAuthors] });
    const results = [];
    for (const operation of ordered.ordered) {
      const existingPending = working.pending.get(operation.operationId);
      if (existingPending) {
        if (semanticDigest(existingPending) !== semanticDigest(operation)) {
          return Object.freeze({ status: 'rejected', reason: 'operation-id-content-mismatch', operationId: operation.operationId, results, stateDigest: this.digest() });
        }
        // Keep the canonical pending copy intact. Once this batch supplies its
        // missing parents, the normal fixed-point drain applies that stored
        // operation rather than replacing it with the retry object.
        results.push(Object.freeze({ status: 'duplicate', operationId: operation.operationId }));
        continue;
      }
      const result = working.#applyOne(operation);
      results.push(result);
      if (result.status === 'rejected') return Object.freeze({ status: 'rejected', reason: result.reason, operationId: operation.operationId, results, stateDigest: this.digest() });
      if (result.status === 'unresolved') working.pending.set(operation.operationId, operation);
      else working.pending.delete(operation.operationId);
    }
    // Newly arrived parents may unblock previously pending operations: drain
    // them on the working copy before committing, so the batch converges.
    // A drain rejection aborts without committing, like an ordered rejection.
    const drained = working.#drainPending();
    results.push(...drained);
    const drainRejection = drained.find((entry) => entry.status === 'rejected');
    if (drainRejection) return Object.freeze({ status: 'rejected', reason: drainRejection.reason, operationId: drainRejection.operationId, results, stateDigest: this.digest() });
    this.state = working.state;
    this.operations = working.operations;
    this.pending = working.pending;
    const unresolved = [...this.pending.keys()].sort();
    return Object.freeze({ status: unresolved.length ? 'applied-with-unresolved' : 'applied', results, unresolvedOperationIds: unresolved, stateDigest: this.digest() });
  }

  checkpoint() {
    return deepFreeze({ schemaVersion: CHECKPOINT_SCHEMA_VERSION, projectIdentity: this.projectIdentity, binaryIdentity: this.binaryIdentity, state: cloneState(this.state), operationIds: [...this.operations.keys()].sort(), digest: this.digest() });
  }

  digest() { return payloadDigest({ state: this.state, operationIds: [...this.operations.keys()].sort() }); }
  snapshot() { return deepFreeze(cloneState(this.state)); }
  appliedOperationIds() { return Object.freeze([...this.operations.keys()].sort()); }
}

export function replayOperations({ projectIdentity, binaryIdentity = null, operations = [], checkpoint = null } = {}) {
  const log = new ChangeLog({ projectIdentity, binaryIdentity, state: checkpoint?.state, operations: checkpoint ? checkpoint.operationIds.map((operationId) => ({ operationId, schemaVersion: CHANGELOG_SCHEMA_VERSION, projectIdentity, binaryIdentity, targetEntityId: 'checkpoint', factKind: 'checkpoint', action: 'set', payload: null, causalParents: [], provenance: { source: 'checkpoint' } })) : [] });
  const filtered = checkpoint ? operations.filter((operation) => !checkpoint.operationIds.includes(operation.operationId)) : operations;
  const result = log.applyBatch(filtered);
  return Object.freeze({ ...result, state: log.snapshot(), digest: log.digest(), unresolved: result.status === 'unresolved' ? result.operationIds : result.unresolvedOperationIds || [] });
}

export function createCheckpoint(log) { if (!(log instanceof ChangeLog)) throw new TypeError('ChangeLog required'); return log.checkpoint(); }

export function restoreCheckpoint(checkpoint, options = {}) {
  if (!checkpoint || checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) throw new TypeError('checkpoint-schema-invalid');
  assertIdentityMatch(checkpoint.projectIdentity, options.projectIdentity, 'checkpoint-project-identity-mismatch');
  assertIdentityMatch(checkpoint.binaryIdentity || '', options.binaryIdentity || '', 'checkpoint-binary-identity-mismatch');
  // The restored state itself must carry the same identity: a digest over a
  // foreign state stays valid, so the digest alone cannot catch the swap (#5497).
  assertIdentityMatch(checkpoint.state?.projectIdentity ?? '', options.projectIdentity, 'checkpoint-state-project-identity-mismatch');
  assertIdentityMatch(checkpoint.state?.binaryIdentity || '', options.binaryIdentity || '', 'checkpoint-state-binary-identity-mismatch');
  const checkpointOperations = checkpoint.operationIds.map((operationId) => ({ operationId, schemaVersion: CHANGELOG_SCHEMA_VERSION, projectIdentity: options.projectIdentity, binaryIdentity: options.binaryIdentity || null, targetEntityId: 'checkpoint', factKind: 'checkpoint', action: 'set', payload: null, causalParents: [], provenance: { source: 'checkpoint' } }));
  const log = new ChangeLog({ projectIdentity: options.projectIdentity, binaryIdentity: options.binaryIdentity || null, state: checkpoint.state, operations: checkpointOperations });
  const restoreResults = [];
  for (const operation of options.operations || []) {
    if (checkpoint.operationIds.includes(operation.operationId)) continue;
    const result = log.applyOperation(operation);
    restoreResults.push(result);
    // A rejected incremental operation must reach the caller: returning the
    // log alone would silently lose the change (#5467). Unresolved (pending),
    // duplicate and conflict outcomes keep their existing semantics.
    if (result.status === 'rejected') {
      const error = new Error(`checkpoint-restore-operation-rejected:${result.reason}`);
      error.code = 'CHECKPOINT_RESTORE_OPERATION_REJECTED';
      error.reason = result.reason;
      error.operationId = result.operationId;
      error.results = Object.freeze(restoreResults);
      error.log = log;
      throw error;
    }
  }
  return log;
}

export function mergeOperations(left = [], right = []) {
  const map = new Map();
  for (const input of [...left, ...right]) {
    const operation = requireCanonicalProjectOperation(input);
    const existing = map.get(operation.operationId);
    if (existing) {
      // Same ID pinning different content must not first-wins silently (#5397).
      if (semanticDigest(existing) !== semanticDigest(operation)) throw new TypeError('operation-id-content-mismatch');
      continue;
    }
    map.set(operation.operationId, operation);
  }
  return Object.freeze([...map.values()].sort(compareOperations));
}

export function collaborationAuthority() { return Object.freeze({ localReplay: 'supported', localCanonicalApply: 'supported', remoteTransport: 'unsupported', reason: 'security-gate-required' }); }
