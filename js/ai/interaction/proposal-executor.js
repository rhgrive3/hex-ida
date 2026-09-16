import { AIError } from '../schema.js';
import { proposalArguments, proposalCapability } from '../proposals.js';

const NOTE_BACKED_KINDS = new Set(['rename', 'comment', 'type', 'struct-field']);
const NOTE_READY_TIMEOUT_MS = 10_000;

export class ProposalExecutor {
constructor({ store, capabilityExecutor, app } = {}) {
this.store = store; this.capabilityExecutor = capabilityExecutor; this.app = app;
}

async proposeCapability(capabilityId, args, { evidenceIds, reason = '' } = {}) {
if (!this.store) throw new AIError('tool_failed', 'No proposal store is available.');
let after;
try { after = structuredClone(args); }
catch { throw new AIError('invalid_tool_call', 'Capability arguments must be structured-cloneable.'); }
const before = await this.capabilityExecutor.approvalState(capabilityId, after);
return this.store.create({ kind: 'capability', target: { capabilityId }, before, after, evidenceIds, reason });
}

async approveAndApply(id) {
if (!this.store) throw new AIError('tool_failed', 'No proposal store is available.');
const previewProposal = typeof this.store.executionView === 'function'
? this.store.executionView(id)
: this.store.get?.(id);
if (!previewProposal) throw new AIError('tool_failed', 'Proposal execution payload is unavailable.');
const currentState = await this.currentState(previewProposal);

const { proposal, approvalToken } = this.store.approve(id);
const executionProposal = typeof this.store.executionView === 'function' ? this.store.executionView(id) : proposal;
let execution = null;
const applied = await this.store.apply(id, {
approvalToken, currentState,
apply: async (item, authorization) => {
const capability = proposalCapability(item);
if (!capability) throw new AIError('invalid_tool_call', `Unsupported proposal kind: ${item.kind}`);
execution = await this.capabilityExecutor.execute(capability, proposalArguments(item), { authorization });
await this.verifyPostcondition(item, execution);
},
});
return { proposal: applied, execution };
}

async currentState(proposal) {
if (NOTE_BACKED_KINDS.has(proposal.kind)) await awaitNoteStoreReady(this.app);
if (proposal.kind === 'capability') return this.capabilityExecutor.approvalState(proposalCapability(proposal), proposalArguments(proposal));
const target = targetObject(proposal.target);
const address = target.address == null ? null : BigInt(target.address);
switch (proposal.kind) {
case 'rename': return address == null ? null : (this.app?.notes?.nameOf?.(address) || this.app?.symbols?.nameAt?.(address) || null);
case 'comment': return address == null ? null : commentStateForExpected(this.app?.notes?.comment?.(address), proposal.before);
case 'type': return address == null ? null : (this.app?.notes?.typeOf?.(address, String(target.key || 'return')) || null);
case 'struct-field': return findStructField(this.app, target);
case 'patch': {
const expected = byteArray(proposal.before);
const result = address == null ? null : await this.app?.backend?.readAt?.(address, expected.length);
return result?.found ? Array.from(result.bytes) : null;
}
case 'project-annotation': return findProjectAnnotation(this.app, target);
default: return proposal.before;
}
}

async verifyPostcondition(proposal, execution) {
if (proposal.kind === 'capability') {
const capability = proposalCapability(proposal);
if (capability === 'patch.revert' && (await this.currentState(proposal)).patch !== null) throw new AIError('tool_failed', 'Reverted patch is still present.');
if (capability === 'runtime.memory-write' && !same(execution?.after, proposal.after.bytes)) throw new AIError('tool_failed', 'Runtime write postcondition does not match the approved bytes.');
if (capability === 'patch.apply') {
if (!(execution?.output instanceof Blob) || execution.output.size !== proposal.before.size) throw new AIError('tool_failed', 'Patch output size does not match the approved file.');
for (const patch of proposal.before.patches) {
const offset = Number(BigInt(patch.fileOffset));
const bytes = new Uint8Array(await execution.output.slice(offset, offset + patch.after.length).arrayBuffer());
if (!same(Array.from(bytes), patch.after)) throw new AIError('tool_failed', 'Patch output does not contain the approved bytes.');
}
}
return;
}
if (proposal.kind === 'patch') {
if (!execution || !same(execution.after, proposal.after)) throw new AIError('tool_failed', 'Patch postcondition does not match the approved bytes.');
return;
}
let verdict;
try {
const live = await this.currentState({ ...proposal, before: proposal.after });
verdict = containsValue(live, structFieldExpectation(proposal)) ? 'verified' : 'mismatched';
} catch (error) {
throw new AIError('tool_failed', `Postcondition could not be verified for ${proposal.kind}: ${error?.message || error}`, {
cause: String(error?.message || error),
verification: 'indeterminate',
mutationResult: summarizeExecution(execution),
});
}
if (verdict !== 'verified') throw new AIError('tool_failed', `Postcondition verification failed for ${proposal.kind}.`);
}
}

async function awaitNoteStoreReady(app) {
if (!app || app.notes?.id) return app?.notes;
const controller = app.noteAttachController;
const doc = globalThis.document;
if (!controller?.signal || typeof doc?.addEventListener !== 'function') return app.notes;
if (controller.signal.aborted) throw new AIError('tool_failed', 'Annotation store binding was replaced before the proposal could be applied.');

await new Promise((resolve, reject) => {
let timer = null;
const cleanup = () => {
doc.removeEventListener('hex:notes-attached', onAttached);
controller.signal.removeEventListener('abort', onAbort);
if (timer != null) clearTimeout(timer);
};
const succeed = () => { cleanup(); resolve(); };
const fail = (message) => { cleanup(); reject(new AIError('tool_failed', message)); };
const onAttached = () => {
if (app.noteAttachController === controller && app.notes?.id) succeed();
};
const onAbort = () => fail('Annotation store binding changed before the proposal could be applied.');

doc.addEventListener('hex:notes-attached', onAttached);
controller.signal.addEventListener('abort', onAbort, { once: true });
if (app.notes?.id) return succeed();
timer = setTimeout(() => fail('Annotation store binding did not become ready before the proposal could be applied.'), NOTE_READY_TIMEOUT_MS);
});
return app.notes;
}

function targetObject(target) { return target && typeof target === 'object' ? { ...target } : { address: target }; }
function summarizeExecution(execution) {
try {
const text = JSON.stringify(execution ?? null);
return text == null ? String(execution) : text.slice(0, 512);
} catch {
return '[unserializable execution result]';
}
}
function structFieldExpectation(proposal) {
const after = proposal.after;
if (proposal.kind !== 'struct-field' || !after || typeof after !== 'object' || Array.isArray(after)) return after;
const fieldName = after.field ?? after.fieldName;
if (fieldName == null) return after;
const expectation = { ...after };
delete expectation.field;
delete expectation.fieldName;
expectation.name = fieldName;
return expectation;
}
function findStructField(app, target) {
const struct = app?.notes?.structs?.find?.((item) => item?.name === String(target.struct || target.name || ''));
return struct?.fields?.find?.((item) => Number(item?.offset) === Number(target.offset)) || null;
}
function findProjectAnnotation(app, target) { return app?.projectAnnotations?.find?.((item) => item?.id === String(target.id || ''))?.value ?? null; }
function byteArray(value) {
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
function same(a, b) { return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b)); }
function commentStateForExpected(value, expected) {
const live = value ?? null;
const liveAbsent = live == null || live === '';
const expectedAbsent = expected == null || expected === '';
if (liveAbsent && expectedAbsent) return expected ?? null;
return live;
}

function containsValue(actual, expected) {
if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
if (!actual || typeof actual !== 'object') return false;
return Object.entries(expected).every(([key, value]) => containsValue(actual[key], value));
}
return same(actual, expected);
}
function normalize(value) {
if (value instanceof Uint8Array) return Array.from(value, normalize);
if (value && typeof value === 'object' && !Array.isArray(value)) {
const out = {}; for (const key of Object.keys(value).sort()) out[key] = normalize(value[key]); return out;
}
return Array.isArray(value) ? value.map(normalize) : typeof value === 'bigint' ? value.toString() : value;
}

export function createProposalExecutor(options) { return new ProposalExecutor(options); }
