import { AIError } from './schema.js';
import { jsonSafe } from './validation.js';
import { stableDigest } from '../core/identity/index.js';
const PROPOSAL_KINDS = new Set(['rename', 'comment', 'type', 'struct-field', 'patch', 'project-annotation', 'capability']);
const PROPOSAL_CAPABILITIES = Object.freeze({
rename: 'annotation.rename', comment: 'annotation.comment', type: 'annotation.set-type',
'struct-field': 'annotation.struct-field', patch: 'patch.create', 'project-annotation': 'annotation.project',
});
const CAPABILITY_PROPOSALS = new Set([
'patch.apply', 'patch.revert', 'runtime.continue', 'runtime.pause',
'runtime.step-in', 'runtime.step-over', 'runtime.step-out', 'runtime.memory-write',
]);
const EXECUTION_PAYLOADS = new WeakMap();
const PROPOSAL_AUTHORITIES = new WeakMap();
const EXECUTION_AUTHORIZATIONS = new WeakMap();
const EXECUTION_COMMIT_GUARDS = new WeakMap();
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag)?.get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'buffer')?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'byteOffset')?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'byteLength')?.get;
const DATA_VIEW_BUFFER_GETTER = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')?.get;
const DATA_VIEW_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')?.get;
const DATA_VIEW_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')?.get;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
const MAP_ENTRIES = Map.prototype.entries;
const SET_VALUES = Set.prototype.values;
const SUPPORTED_PROPOSAL_STATE_PROTOTYPES = new Set([
Array.prototype, Date.prototype, Map.prototype, Set.prototype, RegExp.prototype,
ArrayBuffer.prototype, DataView.prototype,
...[
Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
Int32Array, Uint32Array, Float32Array, Float64Array,
...(typeof BigInt64Array === 'function' ? [BigInt64Array] : []),
...(typeof BigUint64Array === 'function' ? [BigUint64Array] : []),
].map((typedArrayConstructor) => typedArrayConstructor.prototype),
]);
let proposalSequence = 1;
const PROPOSAL_STATE_MAX_BINARY_BYTES = 256 * 1024;
const PROPOSAL_STATE_MAX_NODES = 250_000;
const PROPOSAL_STATE_MAX_DEPTH = 128;
export class ProposalStore {
constructor({ evidenceStore, binding = null } = {}) {
this.evidenceStore = evidenceStore;
this.binding = typeof binding === 'function' ? binding : null;
this.records = new Map();
this.approvals = new Map();
this.audit = [];
}
create(input = {}) {
const kind = input.kind;
if (!PROPOSAL_KINDS.has(kind)) throw new AIError('invalid_tool_call', `Unsupported proposal kind: ${kind}`);
if (input.evidenceIds != null && !Array.isArray(input.evidenceIds)) {
throw new AIError('invalid_tool_call', 'A proposal requires deterministic evidence.');
}
if (kind === 'struct-field') rejectStructFieldTargetOverride(input.after);
if (kind === 'project-annotation' && !hasProjectAnnotationTargetId(input.target)) {
throw new AIError('invalid_tool_call', 'A project-annotation proposal requires a non-empty string target id.');
}
const evidenceIds = Array.from(new Set((input.evidenceIds || []).filter((id) => {
if (typeof id !== 'string') return false;
return hasDeterministicEvidenceAuthority(this.evidenceStore, id);
})));
if (!evidenceIds.length) throw new AIError('invalid_tool_call', 'A proposal requires deterministic evidence.');
let id;
if (Object.prototype.hasOwnProperty.call(input, 'id')) {
const inputId = input.id;
if (typeof inputId !== 'string' || !inputId) throw new AIError('invalid_tool_call', 'Proposal id must be a non-empty string.');
id = inputId;
if (this.records.has(id)) throw new AIError('invalid_tool_call', `Proposal id already exists: ${id}`);
} else {
do id = `proposal_${proposalSequence++}`;
while (this.records.has(id));
}
const binding = this.binding?.() || null;
const before = input.before;
admitBoundedProposalState([input.target, before, input.after]);
rejectUnstableProposalState(before);
const executionPayload = snapshotProposalPayload(input, before);
if (kind === 'patch' && (executionPayload.before instanceof Uint8Array || executionPayload.after instanceof Uint8Array)) {
executionPayload.before = proposalBytes(executionPayload.before);
executionPayload.after = proposalBytes(executionPayload.after);
}
const capability = proposalCapability({ kind, target: executionPayload.target });
if (!capability) throw new AIError('invalid_tool_call', 'Unsupported capability proposal.');
const revision = fingerprint(executionPayload.before);
const targetRevision = persistedValueRevision(executionPayload.target);
const afterRevision = persistedValueRevision(executionPayload.after);
const bindingRevision = fingerprint(binding);
const authority = Object.freeze({
id,
kind,
capability,
revision,
targetRevision,
afterRevision,
bindingRevision,
});
const record = {
id, kind,
target: jsonSafe(executionPayload.target),
before: jsonSafe(executionPayload.before),
after: jsonSafe(executionPayload.after),
reason: String(input.reason || '').slice(0, 2000), evidenceIds,
createdAt: new Date().toISOString(), status: 'pending',
revision,
binding: jsonSafe(binding),
bindingRevision,
};
EXECUTION_PAYLOADS.set(record, executionPayload);
PROPOSAL_AUTHORITIES.set(record, authority);
this.records.set(id, record);
this.audit.push({ type: 'proposal-created', proposalId: id, timestamp: record.createdAt });
return proposalSnapshot(record);
}
restorePersistedPending(initial = []) {
if (!Array.isArray(initial)) return this;
for (const persisted of initial) {
const record = restoredPendingRecord(this, persisted);
if (record) this.records.set(record.id, record);
}
return this;
}
persistedActions() {
return Array.from(this.records.values(), (proposal) => proposal.status === 'pending'
? proposalPersistenceSnapshot(proposal)
: proposalSnapshot(proposal));
}
approve(id) {
const proposal = requireProposalRecord(this, id);
const authority = proposalAuthority(proposal);
if (proposal.status !== 'pending') throw new AIError('approval_required', 'Only pending proposals can be approved.');
const token = randomToken();
proposal.status = 'approved';
this.approvals.set(authority.id, token);
this.audit.push({ type: 'proposal-approved', proposalId: authority.id, timestamp: new Date().toISOString() });
return { proposal: proposalSnapshot(proposal), approvalToken: token };
}
reject(id) {
const proposal = requireProposalRecord(this, id);
const authority = proposalAuthority(proposal);
if (proposal.status !== 'pending' && proposal.status !== 'approved') return proposalSnapshot(proposal);
proposal.status = 'rejected';
this.approvals.delete(authority.id);
this.audit.push({ type: 'proposal-rejected', proposalId: authority.id, timestamp: new Date().toISOString() });
return proposalSnapshot(proposal);
}
async apply(id, { approvalToken, currentState, apply } = {}) {
const proposal = requireProposalRecord(this, id);
const authority = proposalAuthority(proposal);
if (proposal.status !== 'approved' || this.approvals.get(authority.id) !== approvalToken) throw new AIError('approval_required', 'A valid user approval token is required.');
proposal.status = 'applying';
this.approvals.delete(authority.id);
this.audit.push({ type: 'proposal-applying', proposalId: authority.id, timestamp: new Date().toISOString() });
let bindingRevision;
try {
bindingRevision = fingerprint(this.binding?.() || null);
} catch (error) {
proposal.status = 'failed';
this.audit.push({ type: 'proposal-failed', proposalId: authority.id, timestamp: new Date().toISOString() });
throw error;
}
if (authority.bindingRevision !== bindingRevision) {
proposal.status = 'failed';
this.audit.push({ type: 'proposal-binding-mismatch', proposalId: authority.id, timestamp: new Date().toISOString() });
throw new AIError('scope_violation', 'The proposal belongs to a different binary, project, or runtime session.');
}
let currentRevision;
try {
currentRevision = fingerprint(currentState);
} catch (error) {
proposal.status = 'failed';
this.audit.push({ type: 'proposal-failed', proposalId: authority.id, timestamp: new Date().toISOString() });
throw error;
}
if (currentRevision !== authority.revision) {
proposal.status = 'failed';
this.audit.push({ type: 'proposal-stale', proposalId: authority.id, timestamp: new Date().toISOString() });
throw new AIError('tool_failed', 'The proposal target changed after it was created.');
}
if (typeof apply !== 'function') {
proposal.status = 'failed';
throw new AIError('tool_failed', 'No mutation adapter is available.');
}
let authorization = null;
try {
const executionProposal = proposalExecutionView(proposal);
authorization = issueProposalAuthorization(this, proposal, executionProposal, approvalToken);
await apply(executionProposal, authorization);
if (!proposalAuthorizationCommitted(authorization)) {
assertProposalBinding(this, authority.bindingRevision);
}
proposal.status = 'applied';
this.audit.push({ type: 'proposal-applied', proposalId: authority.id, timestamp: new Date().toISOString() });
return proposalSnapshot(proposal);
} catch (error) {
proposal.status = 'failed';
if (error?.details?.verification === 'indeterminate') {
proposal.partial = true;
this.audit.push({ type: 'proposal-partial', proposalId: authority.id, timestamp: new Date().toISOString(), reason: String(error?.details?.cause || error?.message || 'postcondition unverifiable').slice(0, 2000) });
}
this.audit.push({ type: 'proposal-failed', proposalId: authority.id, timestamp: new Date().toISOString() });
throw error;
} finally {
if (authorization) {
EXECUTION_AUTHORIZATIONS.delete(authorization);
EXECUTION_COMMIT_GUARDS.delete(authorization);
}
}
}
require(id) { return proposalSnapshot(requireProposalRecord(this, id)); }
has(id) { return typeof id === 'string' && !!id && this.records.has(id); }
get(id) {
if (typeof id !== 'string' || !id) return null;
const value = this.records.get(id);
return value ? proposalSnapshot(value) : null;
}
all() { return Array.from(this.records.values(), (proposal) => proposalPortableSnapshot(proposal)); }
executionView(id) { return proposalExecutionView(requireProposalRecord(this, id)); }
}
export function proposalCapability(proposal) {
if (proposal?.kind === 'capability') {
const id = proposal.target?.capabilityId;
return CAPABILITY_PROPOSALS.has(id) ? id : null;
}
return PROPOSAL_CAPABILITIES[proposal?.kind] || null;
}
export function proposalArguments(proposal) {
if (proposal?.kind === 'capability') return proposal.after;
const target = proposalTarget(proposal?.target);
if (proposal?.kind === 'rename' || proposal?.kind === 'comment' || proposal?.kind === 'type') return { ...target, value: proposal.after };
if (proposal?.kind === 'struct-field') return { ...target, ...structFieldValue(proposal.after) };
if (proposal?.kind === 'patch') return { ...target, before: proposalBytes(proposal.before), after: proposalBytes(proposal.after) };
return { ...target, value: proposal?.after };
}
function rejectStructFieldTargetOverride(after) {
if (!after || typeof after !== 'object' || Array.isArray(after)) return;
for (const key of ['struct', 'name', 'offset']) {
if (Object.prototype.hasOwnProperty.call(after, key)) {
throw new AIError('invalid_tool_call', 'A struct-field proposal must not override the approved target through after.');
}
}
}
function hasProjectAnnotationTargetId(target) {
const id = target && typeof target === 'object' ? target.id : null;
return typeof id === 'string' && id.length > 0;
}
function structFieldValue(after) {
if (!after || typeof after !== 'object' || Array.isArray(after)) return { type: after };
const value = {};
if (after.field != null) value.field = after.field;
if (after.fieldName != null) value.fieldName = after.fieldName;
if (after.type != null) value.type = after.type;
if (after.binaryId != null) value.binaryId = after.binaryId;
return value;
}
export function isLiveProposalAuthorization(authorization) {
const record = authorization && EXECUTION_AUTHORIZATIONS.get(authorization);
return !!record && record.store.records.get(record.proposalId) === record.proposal && record.proposal.status === 'applying';
}
export function consumeProposalAuthorization(authorization, capability, args, currentState) {
if (!authorization || typeof authorization !== 'object') return false;
const record = EXECUTION_AUTHORIZATIONS.get(authorization);
if (!record) return false;
EXECUTION_AUTHORIZATIONS.delete(authorization);
EXECUTION_COMMIT_GUARDS.delete(authorization);
try {
if (authorization.kind !== 'proposal' || authorization.token !== record.token || authorization.proposalId !== record.proposalId) return false;
if (record.store.records.get(record.proposalId) !== record.proposal || record.proposal.status !== 'applying') return false;
const authority = proposalAuthority(record.proposal);
if (authority.id !== record.proposalId || authority.capability !== record.capability || authority.bindingRevision !== record.bindingRevision) return false;
if (record.capability !== capability) return false;
if (authority.kind === 'capability' && fingerprint(currentState) !== authority.revision) return false;
if (fingerprint(record.store.binding?.() || null) !== record.bindingRevision) return false;
if (fingerprint(args) !== record.argumentsRevision) return false;
EXECUTION_COMMIT_GUARDS.set(authorization, record);
return true;
} catch {
return false;
}
}
export function assertProposalAuthorizationBinding(authorization, { commit = false } = {}) {
const record = authorization && EXECUTION_COMMIT_GUARDS.get(authorization);
if (!record) throw new AIError('approval_required', 'A valid approved proposal authorization is required at mutation commit.');
if (record.store.records.get(record.proposalId) !== record.proposal || record.proposal.status !== 'applying') {
throw new AIError('approval_required', 'The proposal is no longer applying.');
}
assertProposalBinding(record.store, record.bindingRevision);
if (commit) record.committed = true;
return true;
}
function proposalAuthorizationCommitted(authorization) {
return authorization && EXECUTION_COMMIT_GUARDS.get(authorization)?.committed === true;
}
function issueProposalAuthorization(store, proposal, executionProposal, approvalToken) {
const authority = proposalAuthority(proposal);
const capability = authority.capability;
if (!capability) throw new AIError('invalid_tool_call', `Unsupported proposal kind: ${authority.kind}`);
const authorization = Object.freeze({ kind: 'proposal', token: approvalToken, proposalId: authority.id });
EXECUTION_AUTHORIZATIONS.set(authorization, {
store,
proposal,
proposalId: authority.id,
token: approvalToken,
capability,
argumentsRevision: fingerprint(proposalArguments(executionProposal)),
bindingRevision: authority.bindingRevision,
});
return authorization;
}
function requireProposalRecord(store, id) {
if (typeof id !== 'string' || !id) throw new AIError('invalid_tool_call', 'Unknown proposal.');
const value = store.records.get(id);
if (!value) throw new AIError('invalid_tool_call', 'Unknown proposal.');
return value;
}
function hasDeterministicEvidenceAuthority(evidenceStore, id) {
if (typeof evidenceStore?.get === 'function') return evidenceStore.get(id)?.status === 'verified';
return evidenceStore?.has?.(id) === true;
}
function restoredPendingRecord(store, persisted) {
if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) return null;
if (persisted.status !== 'pending') return null;
const id = persisted.id;
if (typeof id !== 'string' || !id || store.records.has(id)) return null;
const kind = persisted.kind;
const capability = PROPOSAL_CAPABILITIES[kind];
if (!PROPOSAL_KINDS.has(kind) || !capability) return null;
if (persisted.capability != null && persisted.capability !== capability) return null;
if (typeof persisted.createdAt !== 'string' || !persisted.createdAt) return null;
if (typeof persisted.revision !== 'string' || !persisted.revision) return null;
if (typeof persisted.targetRevision !== 'string' || !persisted.targetRevision) return null;
if (typeof persisted.afterRevision !== 'string' || !persisted.afterRevision) return null;
if (persisted.executionPayload != null && (typeof persisted.executionPayload !== 'string' || !persisted.executionPayload)) return null;
if (typeof persisted.bindingRevision !== 'string' || !persisted.bindingRevision) return null;
const evidenceIds = Array.from(new Set(Array.isArray(persisted.evidenceIds)
? persisted.evidenceIds.filter((value) => typeof value === 'string' && value)
: []));
if (!evidenceIds.length || !evidenceIds.every((value) => hasDeterministicEvidenceAuthority(store.evidenceStore, value))) return null;
let binding;
let payload;
try {
binding = store.binding?.() || null;
if (fingerprint(binding) !== persisted.bindingRevision) return null;
if (typeof persisted.executionPayload === 'string' && persisted.executionPayload) {
payload = decodePersistedExecutionPayload(persisted.executionPayload);
if (encodePersistedExecutionPayload(payload) !== persisted.executionPayload) return null;
} else {
if (persisted.executionDisplayExact !== true) return null;
rejectUnstableProposalState(persisted);
payload = snapshotProposalPayload(persisted);
}
if (fingerprint(payload.before) !== persisted.revision) return null;
if (persistedValueRevision(payload.target) !== persisted.targetRevision) return null;
if (persistedValueRevision(payload.after) !== persisted.afterRevision) return null;
} catch {
return null;
}
const record = {
id,
kind,
target: jsonSafe(payload.target),
before: jsonSafe(payload.before),
after: jsonSafe(payload.after),
reason: String(persisted.reason || '').slice(0, 2000),
evidenceIds,
createdAt: persisted.createdAt,
status: 'pending',
revision: persisted.revision,
binding: jsonSafe(binding),
bindingRevision: persisted.bindingRevision,
};
EXECUTION_PAYLOADS.set(record, payload);
PROPOSAL_AUTHORITIES.set(record, Object.freeze({
id,
kind,
capability,
revision: persisted.revision,
targetRevision: persisted.targetRevision,
afterRevision: persisted.afterRevision,
bindingRevision: persisted.bindingRevision,
}));
return record;
}
function proposalPortableSnapshot(proposal) {
const snapshot = proposalSnapshot(proposal);
const authority = proposalAuthority(proposal);
const displayExact = fingerprint(snapshot.before) === authority.revision
&& persistedValueRevision(snapshot.target) === authority.targetRevision
&& persistedValueRevision(snapshot.after) === authority.afterRevision;
return {
...snapshot,
targetRevision: authority.targetRevision,
afterRevision: authority.afterRevision,
executionDisplayExact: displayExact,
};
}
function proposalPersistenceSnapshot(proposal) {
const authority = proposalAuthority(proposal);
const payload = EXECUTION_PAYLOADS.get(proposal);
if (!payload) throw new AIError('tool_failed', 'Proposal execution payload is unavailable.');
const executionPayload = encodePersistedExecutionPayload(payload);
if (persistedValueRevision(payload.target) !== authority.targetRevision
|| persistedValueRevision(payload.after) !== authority.afterRevision
|| fingerprint(payload.before) !== authority.revision) {
throw new AIError('tool_failed', 'Proposal execution authority changed before persistence.');
}
return {
...proposalSnapshot(proposal),
executionPayload,
targetRevision: authority.targetRevision,
afterRevision: authority.afterRevision,
};
}
function proposalAuthority(proposal) {
const authority = PROPOSAL_AUTHORITIES.get(proposal);
if (!authority) throw new AIError('tool_failed', 'Proposal authority metadata is unavailable.');
return authority;
}
function proposalSnapshot(proposal) {
const authority = proposalAuthority(proposal);
return {
...proposal,
id: authority.id,
kind: authority.kind,
target: jsonSafe(proposal.target),
before: jsonSafe(proposal.before),
after: jsonSafe(proposal.after),
evidenceIds: Array.isArray(proposal.evidenceIds) ? [...proposal.evidenceIds] : [],
revision: authority.revision,
binding: jsonSafe(proposal.binding),
bindingRevision: authority.bindingRevision,
};
}
function proposalTarget(target) { return target && typeof target === 'object' ? { ...target } : { address: target }; }
function proposalBytes(value) {
if (!Array.isArray(value) && !(value instanceof Uint8Array)) {
throw new AIError('invalid_tool_call', 'Mutation bytes must be an Array or Uint8Array.');
}
const raw = Array.from(value);
for (const byte of raw) {
if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
throw new AIError('invalid_tool_call', 'Mutation contains a non-byte value.');
}
}
return Array.from(raw);
}
function proposalExecutionView(proposal) {
const payload = EXECUTION_PAYLOADS.get(proposal);
if (!payload) throw new AIError('tool_failed', 'Proposal execution payload is unavailable.');
return { ...proposalSnapshot(proposal), ...snapshotProposalPayload(payload) };
}
function restoreRegExpLastIndex(source, target, seen = new WeakSet()) {
if (!source || typeof source !== 'object' || !target || typeof target !== 'object') return;
if (seen.has(source)) return;
seen.add(source);
if (source instanceof RegExp && target instanceof RegExp) {
target.lastIndex = source.lastIndex;
return;
}
if (source instanceof Map && target instanceof Map) {
const srcKeys = Array.from(source.keys());
const tgtKeys = Array.from(target.keys());
for (let i = 0; i < srcKeys.length; i++) {
restoreRegExpLastIndex(srcKeys[i], tgtKeys[i], seen);
restoreRegExpLastIndex(source.get(srcKeys[i]), target.get(tgtKeys[i]), seen);
}
return;
}
if (source instanceof Set && target instanceof Set) {
const srcVals = Array.from(source.values());
const tgtVals = Array.from(target.values());
for (let i = 0; i < srcVals.length; i++) {
restoreRegExpLastIndex(srcVals[i], tgtVals[i], seen);
}
return;
}
if (Array.isArray(source) && Array.isArray(target)) {
for (let i = 0; i < source.length; i++) {
restoreRegExpLastIndex(source[i], target[i], seen);
}
return;
}
for (const key of Object.keys(source)) {
if (key in target) {
restoreRegExpLastIndex(source[key], target[key], seen);
}
}
}
function snapshotProposalPayload(value, stableBefore = value.before) {
const clone = globalThis.structuredClone;
if (typeof clone !== 'function') {
throw new AIError('tool_failed', 'Structured cloning is unavailable for proposal execution payloads.');
}
let payload;
try {
payload = {
target: clone(value.target),
before: clone(stableBefore),
after: clone(value.after),
};
restoreRegExpLastIndex(value.target, payload.target);
restoreRegExpLastIndex(stableBefore, payload.before);
restoreRegExpLastIndex(value.after, payload.after);
} catch {
throw new AIError('invalid_tool_call', 'Proposal execution payload must be structured-cloneable.');
}
if (containsSharedMemory(payload)) {
throw new AIError('invalid_tool_call', 'Proposal execution payload must not contain shared memory.');
}
return payload;
}
function admitBoundedProposalState(values) {
let binaryBytes = 0;
let nodes = 0;
const seen = new WeakSet();
const spendNode = () => {
nodes += 1;
if (nodes > PROPOSAL_STATE_MAX_NODES) {
throw new AIError('tool_failed',
'Proposal state exceeds the admitted snapshot work budget and cannot be snapshotted or fingerprinted safely.');
}
};
const visit = (value, depth) => {
if (value === null || typeof value !== 'object') return;
if (depth > PROPOSAL_STATE_MAX_DEPTH) {
throw new AIError('tool_failed',
'Proposal state is nested beyond the admitted snapshot depth and cannot be snapshotted safely.');
}
spendNode();
if (seen.has(value)) return;
seen.add(value);
const binary = intrinsicBinaryContainer(value);
if (binary) {
binaryBytes += binary.byteLength || 0;
if (binaryBytes > PROPOSAL_STATE_MAX_BINARY_BYTES) {
throw new AIError('tool_failed',
'Proposal state binary payload exceeds the admitted size budget and cannot be snapshotted or fingerprinted safely.');
}
return;
}
if (value instanceof Map) {
for (const [key, item] of value) { visit(key, depth + 1); visit(item, depth + 1); }
return;
}
if (value instanceof Set) {
for (const item of value) visit(item, depth + 1);
return;
}
if (Array.isArray(value)) {
if (nodes + value.length > PROPOSAL_STATE_MAX_NODES) spendNode();
for (let i = 0; i < value.length; i += 1) { spendNode(); visit(value[i], depth + 1); }
return;
}
const keys = Object.keys(value);
if (nodes + keys.length > PROPOSAL_STATE_MAX_NODES) spendNode();
for (const key of keys) { spendNode(); visit(value[key], depth + 1); }
};
for (const value of values) visit(value, 0);
}
function rejectUnstableProposalState(value, seen = new Set()) {
if (value === null || typeof value !== 'object') return;
if (seen.has(value)) return;
seen.add(value);
try {
const prototype = Object.getPrototypeOf(value);
if (prototype !== Object.prototype && prototype !== null && !SUPPORTED_PROPOSAL_STATE_PROTOTYPES.has(prototype)) {
throw new AIError('tool_failed', 'Proposal state contains an unsupported non-plain object and cannot be snapshotted safely.');
}
const keys = Reflect.ownKeys(value);
if (keys.some((key) => typeof key === 'symbol')) {
throw new AIError('tool_failed', 'Proposal state contains symbol-keyed own properties and cannot be fingerprinted safely.');
}
for (const key of keys) {
const descriptor = Object.getOwnPropertyDescriptor(value, key);
if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
throw new AIError('tool_failed', 'Proposal state contains accessor-backed state and cannot be snapshotted safely.');
}
rejectUnstableProposalState(descriptor.value, seen);
}
if (prototype === Map.prototype) {
for (const [key, item] of MAP_ENTRIES.call(value)) {
rejectUnstableProposalState(key, seen);
rejectUnstableProposalState(item, seen);
}
} else if (prototype === Set.prototype) {
for (const item of SET_VALUES.call(value)) rejectUnstableProposalState(item, seen);
}
} catch (error) {
if (error instanceof AIError) throw error;
throw new AIError('tool_failed', 'Proposal state cannot be snapshotted safely.');
}
}
function containsSharedMemory(value, seen = new WeakSet()) {
if (value === null || typeof value !== 'object') return false;
const SharedBuffer = globalThis.SharedArrayBuffer;
if (typeof SharedBuffer === 'function' && value instanceof SharedBuffer) return true;
if (ArrayBuffer.isView(value)) {
return typeof SharedBuffer === 'function' && value.buffer instanceof SharedBuffer;
}
if (value instanceof ArrayBuffer) return false;
if (seen.has(value)) return false;
seen.add(value);
if (value instanceof Map) {
for (const [key, item] of value) {
if (containsSharedMemory(key, seen) || containsSharedMemory(item, seen)) return true;
}
return false;
}
if (value instanceof Set) {
for (const item of value) {
if (containsSharedMemory(item, seen)) return true;
}
return false;
}
for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
if ('value' in descriptor && containsSharedMemory(descriptor.value, seen)) return true;
}
return false;
}
function fingerprint(value) {
return stableDigest(canonicalIdentity(value));
}
function assertProposalBinding(store, expectedRevision) {
const currentRevision = fingerprint(store?.binding?.() || null);
if (currentRevision !== expectedRevision) {
throw new AIError('scope_violation', 'The proposal belongs to a different binary, project, or runtime session.');
}
}
function intrinsicBinaryContainer(value) {
if (typeof ARRAY_BUFFER_BYTE_LENGTH_GETTER === 'function') {
try {
const byteLength = ARRAY_BUFFER_BYTE_LENGTH_GETTER.call(value);
return { kind: 'ArrayBuffer', buffer: value, byteOffset: 0, byteLength };
} catch {
}
}
if (!ArrayBuffer.isView(value)) return null;
if (typeof TYPED_ARRAY_TAG_GETTER === 'function'
&& typeof TYPED_ARRAY_BUFFER_GETTER === 'function'
&& typeof TYPED_ARRAY_BYTE_OFFSET_GETTER === 'function'
&& typeof TYPED_ARRAY_BYTE_LENGTH_GETTER === 'function') {
const kind = TYPED_ARRAY_TAG_GETTER.call(value);
if (typeof kind === 'string' && kind) {
return {
kind,
buffer: TYPED_ARRAY_BUFFER_GETTER.call(value),
byteOffset: TYPED_ARRAY_BYTE_OFFSET_GETTER.call(value),
byteLength: TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value),
};
}
}
if (typeof DATA_VIEW_BUFFER_GETTER === 'function'
&& typeof DATA_VIEW_BYTE_OFFSET_GETTER === 'function'
&& typeof DATA_VIEW_BYTE_LENGTH_GETTER === 'function') {
try {
return {
kind: 'DataView',
buffer: DATA_VIEW_BUFFER_GETTER.call(value),
byteOffset: DATA_VIEW_BYTE_OFFSET_GETTER.call(value),
byteLength: DATA_VIEW_BYTE_LENGTH_GETTER.call(value),
};
} catch {
}
}
throw new AIError('tool_failed', 'Proposal binary-container identity cannot be determined safely.');
}
function canonicalIdentity(value, stack = new Set()) {
if (value === null) return 'z';
if (value === undefined) return 'v';
const type = typeof value;
if (type === 'boolean') return value ? 'b1' : 'b0';
if (type === 'bigint') return `i${value.toString(10)};`;
if (type === 'number') {
if (Number.isNaN(value)) return 'dNaN;';
if (value === Infinity) return 'dInfinity;';
if (value === -Infinity) return 'd-Infinity;';
if (Object.is(value, -0)) return 'd-0;';
return `d${JSON.stringify(value)};`;
}
if (type === 'string') return `s${JSON.stringify(value)}`;
if (type === 'symbol' || type === 'function') {
throw new AIError('tool_failed', 'Proposal state cannot contain function or symbol values.');
}
if (type !== 'object') return `x${JSON.stringify(String(value))}`;
if (stack.has(value)) throw new AIError('tool_failed', 'Proposal state contains a cyclic value and cannot be fingerprinted safely.');
stack.add(value);
try {
if (Object.getOwnPropertySymbols(value).length) {
throw new AIError('tool_failed', 'Proposal state contains symbol-keyed own properties and cannot be fingerprinted safely.');
}
if (value instanceof Date) return `t${JSON.stringify(Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString())}`;
const binary = intrinsicBinaryContainer(value);
if (binary) {
const bytes = new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
let hexText = '';
for (const byte of bytes) hexText += byte.toString(16).padStart(2, '0');
return `y${JSON.stringify(binary.kind)}:${binary.byteOffset}:${binary.byteLength}:${JSON.stringify(hexText)}`;
}
if (value instanceof Map) {
return `m[${Array.from(value.entries()).map(([k, v]) => `${canonicalIdentity(k, stack)}:${canonicalIdentity(v, stack)}`).join(',')}]`;
}
if (value instanceof Set) {
return `e[${Array.from(value.values()).map((item) => canonicalIdentity(item, stack)).join(',')}]`;
}
if (value instanceof RegExp) {
return `r${JSON.stringify(value.source)}:${JSON.stringify(value.flags)}:${canonicalIdentity(value.lastIndex, stack)}`;
}
if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype) {
throw new AIError('tool_failed', 'Proposal state contains an unsupported non-plain object and cannot be fingerprinted safely.');
}
if (!Array.isArray(value)) {
const proto = Object.getPrototypeOf(value);
if (proto !== Object.prototype && proto !== null) {
throw new AIError('tool_failed', 'Proposal state contains an unsupported non-plain object and cannot be fingerprinted safely.');
}
}
if (Array.isArray(value)) {
const items = [];
for (let index = 0; index < value.length; index++) {
items.push(Object.prototype.hasOwnProperty.call(value, index)
? `p${canonicalIdentity(value[index], stack)}`
: 'h');
}
return `a[${items.join(',')}]`;
}
const keys = Object.keys(value).sort();
return `o{${keys.map((key) => `${JSON.stringify(key)}:${canonicalIdentity(value[key], stack)}`).join(',')}}`;
} finally {
stack.delete(value);
}
}
function persistedValueRevision(value) {
return stableDigest(JSON.stringify(encodePersistedValue(value)));
}
function encodePersistedExecutionPayload(payload) {
return JSON.stringify({
version: 1,
target: encodePersistedValue(payload.target),
before: encodePersistedValue(payload.before),
after: encodePersistedValue(payload.after),
});
}
function decodePersistedExecutionPayload(text) {
let envelope;
try { envelope = JSON.parse(text); } catch {
throw new AIError('tool_failed', 'Persisted proposal execution payload is invalid.');
}
if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.version !== 1
|| !Object.hasOwn(envelope, 'target') || !Object.hasOwn(envelope, 'before') || !Object.hasOwn(envelope, 'after')) {
throw new AIError('tool_failed', 'Persisted proposal execution payload is invalid.');
}
return {
target: decodePersistedValue(envelope.target),
before: decodePersistedValue(envelope.before),
after: decodePersistedValue(envelope.after),
};
}
function encodePersistedValue(root) {
const seen = new Map();
const encode = (value) => {
if (value === null) return ['null'];
if (value === undefined) return ['undefined'];
const type = typeof value;
if (type === 'boolean') return ['boolean', value];
if (type === 'string') return ['string', value];
if (type === 'bigint') return ['bigint', value.toString(10)];
if (type === 'number') {
if (Number.isNaN(value)) return ['number', 'NaN'];
if (value === Infinity) return ['number', 'Infinity'];
if (value === -Infinity) return ['number', '-Infinity'];
if (Object.is(value, -0)) return ['number', '-0'];
return ['number', value];
}
if (type === 'symbol' || type === 'function' || type !== 'object') {
throw new AIError('tool_failed', 'Proposal execution payload cannot be persisted losslessly.');
}
if (seen.has(value)) return ['ref', seen.get(value)];
const id = seen.size;
seen.set(value, id);
if (value instanceof Date) return ['date', id, Number.isNaN(value.getTime()) ? null : value.toISOString()];
const binary = intrinsicBinaryContainer(value);
if (binary) {
if (binary.kind === 'ArrayBuffer') {
const bytes = Array.from(new Uint8Array(binary.buffer, 0, binary.byteLength));
return ['buffer', id, bytes];
}
return ['view', id, binary.kind, binary.byteOffset, binary.byteLength, encode(binary.buffer)];
}
if (value instanceof RegExp) return ['regexp', id, value.source, value.flags, value.lastIndex];
if (value instanceof Map) return ['map', id, Array.from(value.entries(), ([key, item]) => [encode(key), encode(item)])];
if (value instanceof Set) return ['set', id, Array.from(value.values(), encode)];
if (Array.isArray(value)) {
if (Object.getPrototypeOf(value) !== Array.prototype) {
throw new AIError('tool_failed', 'Proposal execution payload cannot be persisted losslessly.');
}
const entries = Object.keys(value).map((key) => [key, encode(value[key])]);
return ['array', id, value.length, entries];
}
const proto = Object.getPrototypeOf(value);
if (proto !== Object.prototype && proto !== null) {
throw new AIError('tool_failed', 'Proposal execution payload cannot be persisted losslessly.');
}
return ['object', id, proto === null ? 0 : 1, Object.keys(value).map((key) => [key, encode(value[key])])];
};
return encode(root);
}
function decodePersistedValue(root) {
const refs = new Map();
const decode = (node) => {
if (!Array.isArray(node) || typeof node[0] !== 'string') throw new AIError('tool_failed', 'Persisted proposal execution value is invalid.');
const tag = node[0];
if (tag === 'null' && node.length === 1) return null;
if (tag === 'undefined' && node.length === 1) return undefined;
if (tag === 'boolean' && node.length === 2 && typeof node[1] === 'boolean') return node[1];
if (tag === 'string' && node.length === 2 && typeof node[1] === 'string') return node[1];
if (tag === 'bigint' && node.length === 2 && typeof node[1] === 'string' && /^-?\d+$/.test(node[1])) return BigInt(node[1]);
if (tag === 'number' && node.length === 2) {
if (node[1] === 'NaN') return NaN;
if (node[1] === 'Infinity') return Infinity;
if (node[1] === '-Infinity') return -Infinity;
if (node[1] === '-0') return -0;
if (typeof node[1] === 'number' && Number.isFinite(node[1])) return node[1];
throw new AIError('tool_failed', 'Persisted proposal execution number is invalid.');
}
if (tag === 'ref' && node.length === 2 && Number.isSafeInteger(node[1]) && node[1] >= 0 && refs.has(node[1])) return refs.get(node[1]);
const id = node[1];
if (!Number.isSafeInteger(id) || id < 0 || refs.has(id)) throw new AIError('tool_failed', 'Persisted proposal execution reference is invalid.');
if (tag === 'date' && node.length === 3 && (node[2] === null || typeof node[2] === 'string')) {
const value = node[2] === null ? new Date(NaN) : new Date(node[2]);
refs.set(id, value);
return value;
}
if (tag === 'buffer' && node.length === 3) {
const bytes = decodePersistedBytes(node[2]);
const value = Uint8Array.from(bytes).buffer;
refs.set(id, value);
return value;
}
if (tag === 'view' && node.length === 6 && typeof node[2] === 'string'
&& Number.isSafeInteger(node[3]) && node[3] >= 0 && Number.isSafeInteger(node[4]) && node[4] >= 0) {
const buffer = decode(node[5]);
if (!(buffer instanceof ArrayBuffer) || node[3] + node[4] > buffer.byteLength) {
throw new AIError('tool_failed', 'Persisted proposal execution view is invalid.');
}
const value = persistedView(node[2], buffer, node[3], node[4]);
refs.set(id, value);
return value;
}
if (tag === 'regexp' && node.length === 5 && typeof node[2] === 'string' && typeof node[3] === 'string'
&& Number.isSafeInteger(node[4]) && node[4] >= 0) {
const value = new RegExp(node[2], node[3]);
value.lastIndex = node[4];
refs.set(id, value);
return value;
}
if (tag === 'map' && node.length === 3 && Array.isArray(node[2])) {
const value = new Map();
refs.set(id, value);
for (const entry of node[2]) {
if (!Array.isArray(entry) || entry.length !== 2) throw new AIError('tool_failed', 'Persisted proposal execution map is invalid.');
value.set(decode(entry[0]), decode(entry[1]));
}
return value;
}
if (tag === 'set' && node.length === 3 && Array.isArray(node[2])) {
const value = new Set();
refs.set(id, value);
for (const item of node[2]) value.add(decode(item));
return value;
}
if (tag === 'array' && node.length === 4 && Number.isSafeInteger(node[2]) && node[2] >= 0 && Array.isArray(node[3])) {
const value = new Array(node[2]);
refs.set(id, value);
decodePersistedEntries(value, node[3], decode, { arrayLength: node[2] });
return value;
}
if (tag === 'object' && node.length === 4 && (node[2] === 0 || node[2] === 1) && Array.isArray(node[3])) {
const value = node[2] === 0 ? Object.create(null) : {};
refs.set(id, value);
decodePersistedEntries(value, node[3], decode);
return value;
}
throw new AIError('tool_failed', 'Persisted proposal execution value is invalid.');
};
return decode(root);
}
function decodePersistedEntries(target, entries, decode, { arrayLength = null } = {}) {
const keys = new Set();
for (const entry of entries) {
if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || keys.has(entry[0])) {
throw new AIError('tool_failed', 'Persisted proposal execution object is invalid.');
}
const key = entry[0];
if (arrayLength != null && /^(?:0|[1-9]\d*)$/.test(key)) {
const index = Number(key);
const isArrayIndex = Number.isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === key;
if (isArrayIndex && index >= arrayLength) throw new AIError('tool_failed', 'Persisted proposal execution array is invalid.');
}
keys.add(key);
Object.defineProperty(target, key, { value: decode(entry[1]), writable: true, enumerable: true, configurable: true });
}
}
function decodePersistedBytes(value) {
if (!Array.isArray(value)) throw new AIError('tool_failed', 'Persisted proposal execution bytes are invalid.');
for (const byte of value) {
if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new AIError('tool_failed', 'Persisted proposal execution bytes are invalid.');
}
return value;
}
function persistedView(kind, buffer, byteOffset, byteLength) {
if (kind === 'DataView') return new DataView(buffer, byteOffset, byteLength);
const Ctor = globalThis[kind];
if (typeof Ctor !== 'function' || !Ctor.BYTES_PER_ELEMENT || byteLength % Ctor.BYTES_PER_ELEMENT !== 0) {
throw new AIError('tool_failed', 'Persisted proposal execution view kind is invalid.');
}
return new Ctor(buffer, byteOffset, byteLength / Ctor.BYTES_PER_ELEMENT);
}
function randomToken() {
const crypto = globalThis.crypto;
if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
if (!crypto || typeof crypto.getRandomValues !== 'function') {
throw new AIError('tool_failed', 'Secure randomness is unavailable for approval tokens.');
}
const bytes = new Uint8Array(16);
crypto.getRandomValues(bytes);
let token = 'approval_';
for (const byte of bytes) token += byte.toString(16).padStart(2, '0');
return token;
}
