import { AIError } from './schema.js';
import { jsonSafe } from './validation.js';
import { admitBoundedProposalState, decodePersistedExecutionPayload, encodePersistedExecutionPayload, fingerprint, persistedValueRevision, rejectUnstableProposalState, snapshotProposalPayload } from './proposal-state.js';
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
let proposalSequence = 1;
export class ProposalStore {
constructor({ evidenceStore, binding = null, currentEvidenceBinding = null } = {}) {
this.evidenceStore = evidenceStore;
this.binding = typeof binding === 'function' ? binding : null;
this.currentEvidenceBinding = typeof currentEvidenceBinding === 'function' ? currentEvidenceBinding : null;
this.records = new Map();
this.approvals = new Map();
this.audit = [];
}
evidenceBindingIsCurrent(record) {
if (!this.currentEvidenceBinding) return true;
const bound = record?.sourceBinding;
if (typeof bound !== 'string' || !bound) return false;
let current;
try { current = this.currentEvidenceBinding(); } catch { return false; }
return typeof current === 'string' && current.length > 0 && current === bound;
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
return hasDeterministicEvidenceAuthority(this.evidenceStore, id, (record) => this.evidenceBindingIsCurrent(record));
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
function hasDeterministicEvidenceAuthority(evidenceStore, id, bindingIsCurrent = null) {
if (typeof evidenceStore?.get === 'function') {
const record = evidenceStore.get(id);
if (record?.status !== 'verified') return false;
if (typeof bindingIsCurrent === 'function' && !bindingIsCurrent(record)) return false;
return true;
}
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
if (!evidenceIds.length || !evidenceIds.every((value) => hasDeterministicEvidenceAuthority(store.evidenceStore, value, (record) => store.evidenceBindingIsCurrent(record)))) return null;
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
function assertProposalBinding(store, expectedRevision) {
const currentRevision = fingerprint(store?.binding?.() || null);
if (currentRevision !== expectedRevision) {
throw new AIError('scope_violation', 'The proposal belongs to a different binary, project, or runtime session.');
}
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
