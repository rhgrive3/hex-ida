import { AIError } from '../schema.js';
import { assertSchema } from '../validation.js';
import { assertProposalAuthorizationBinding, consumeProposalAuthorization, isLiveProposalAuthorization } from '../proposals.js';
import { validatePatchRange, instructionPatchArchitectureSupported } from '../../patch.js';
import { CapabilityExecutor as BaseCapabilityExecutor } from './executor-base.js';

export * from './executor-base.js';

const APPROVAL_STATE_IDS = new Set([
'patch.apply', 'patch.revert', 'runtime.continue', 'runtime.pause',
'runtime.step-in', 'runtime.step-over', 'runtime.step-out', 'runtime.memory-write',
]);
const PRECOMMIT_IDS = new Set([
'annotation.rename', 'annotation.comment', 'annotation.set-type', 'annotation.struct-field',
'annotation.project', 'runtime.continue', 'runtime.pause', 'runtime.step-in', 'runtime.step-over', 'runtime.step-out',
]);

function runtimeSession(platform) {
const session = platform?.currentSession?.(false);
if (!session?.adapter) throw new AIError('tool_failed', 'Runtime adapter is unavailable.');
return session;
}

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
return Uint8Array.from(raw);
}

function equalBytes(a, b) {
return a?.length === b?.length && Array.from(a).every((value, index) => value === b[index]);
}

function staleError(error) {
return error?.code === 'stale-target'
|| error?.code === 'stale-request'
|| error?.stale === true
|| /stale/i.test(String(error?.message || ''));
}

function sessionSnapshot(session) {
return Object.freeze({
id: session?.id ?? null,
generation: session?.generation ?? null,
adapterEpoch: session?.adapter?.epoch ?? null,
});
}

function sameSessionSnapshot(before, session) {
if (!session) return false;
if (before.id != null && session.id !== before.id) return false;
if (before.generation != null && session.generation !== before.generation) return false;
if (before.adapterEpoch != null && session.adapter?.epoch !== before.adapterEpoch) return false;
return true;
}

function assertSessionSnapshot(runtimePlatform, before) {
const current = runtimePlatform?.currentSession?.(false);
if (!sameSessionSnapshot(before, current)) {
throw new AIError('tool_failed', 'Runtime memory target is stale: session generation changed during atomic write.');
}
}

async function atomicBoundedMemoryWrite(runtimePlatform, args, options = {}, commitGuard = null) {
const session = runtimeSession(runtimePlatform);
const adapter = session.adapter;
const bytes = byteArray(args.bytes);
const expected = byteArray(args.expectedBefore);
if (!bytes.length || bytes.length > 64 * 1024 || bytes.length !== expected.length) {
throw new AIError(
'invalid_tool_call',
'Runtime write bytes and expected-before must have the same length between 1 and 65536.',
);
}

if (adapter.compareAndWriteMemoryAtomic !== true || typeof adapter.compareAndWriteMemory !== 'function') {
throw new AIError(
'tool_failed',
'Runtime adapter does not provide an atomic compare-and-write memory primitive.',
);
}

const before = sessionSnapshot(session);
commitGuard?.();
let result;
try {
result = await adapter.compareAndWriteMemory(args.address, expected, bytes, {
signal: options?.signal || null,
expectedSessionId: before.id,
expectedGeneration: before.generation,
expectedEpoch: before.adapterEpoch,
});
} catch (error) {
if (staleError(error)) {
throw new AIError(
'tool_failed',
`Runtime memory target is stale: ${error?.message || 'atomic compare-and-write rejected the expected-before state.'}`,
);
}
throw error instanceof AIError
? error
: new AIError('tool_failed', error?.message || 'Runtime atomic memory write failed.');
}

assertSessionSnapshot(runtimePlatform, before);

if (result?.written != null && (
typeof result.written !== 'number'
|| !Number.isSafeInteger(result.written)
|| result.written !== bytes.length
)) {
throw new AIError('tool_failed', 'Runtime atomic memory write returned an invalid written count.');
}

const after = await adapter.readMemory(args.address, bytes.length);
assertSessionSnapshot(runtimePlatform, before);
if (!equalBytes(after, bytes)) {
throw new AIError('tool_failed', 'Runtime memory write postcondition verification failed.');
}

return {
address: String(args.address),
written: bytes.length,
before: Array.from(expected),
after: Array.from(bytes),
};
}

export class CapabilityExecutor extends BaseCapabilityExecutor {
async execute(id, args = {}, options = {}) {
const entry = this.catalog?.get?.(id);
if (!entry || !entry.agentExposed) throw new AIError('invalid_tool_call', `Unknown or human-only capability: ${id}`);
const proposalAuthorization = isLiveProposalAuthorization(options.authorization);
const executionArgs = entry.requiresApproval || proposalAuthorization ? snapshotApprovedArguments(args) : args;
assertSchema(executionArgs, entry.inputSchema || { type: 'object' }, 'invalid_tool_call');
const runtimePlatform = entry.category === 'runtime' ? await this.resolveRuntimePlatform() : null;
this.verifyBinding(entry, executionArgs, runtimePlatform);
this.verifyScope(entry, options);
let commitGuard = null;
if (proposalAuthorization) {
const context = captureMutationContext(entry, this.app, runtimePlatform);
const currentState = APPROVAL_STATE_IDS.has(id)
? await this.approvalState(id, executionArgs, runtimePlatform)
: undefined;
assertMutationContext(context, this.app, runtimePlatform);
if (entry.requiresApproval && !consumeProposalAuthorization(options.authorization, id, executionArgs, currentState)) {
throw new AIError('approval_required', `Capability ${id} requires an approved proposal authorization.`);
}
if (!entry.requiresApproval && !consumeProposalAuthorization(options.authorization, id, executionArgs, currentState)) {
throw new AIError('approval_required', `Capability ${id} requires an approved proposal authorization.`);
}
commitGuard = () => {
assertMutationContext(context, this.app, runtimePlatform);
assertProposalAuthorizationBinding(options.authorization, { commit: true });
};
} else if (entry.requiresApproval) {
throw new AIError('approval_required', `Capability ${id} requires an approved proposal authorization.`);
}
if (entry.agentTool) return this.executeTool(entry, executionArgs, options);
if (entry.actionKind) return this.executeAction(entry, executionArgs);
return this.executeBuiltIn(entry, executionArgs, options, runtimePlatform, commitGuard);
}

async approvalState(id, args = {}, runtimePlatform = null) {
const entry = this.catalog?.get?.(id);
if (!entry || !entry.agentExposed) throw new AIError('invalid_tool_call', `Unknown or human-only capability: ${id}`);
const executionArgs = snapshotApprovedArguments(args);
assertSchema(executionArgs, entry.inputSchema || { type: 'object' }, 'invalid_tool_call');
const platform = entry.category === 'runtime' ? (runtimePlatform || await this.resolveRuntimePlatform()) : null;
this.verifyBinding(entry, executionArgs, platform);
switch (id) {
case 'patch.apply': {
const source = executionArgs.file || this.app?.file;
if (typeof source?.size !== 'number' || !Number.isSafeInteger(source.size) || source.size < 0) {
throw new AIError('tool_failed', 'Patch source size is unavailable.');
}
return { size: source.size, patches: (this.app?.patches?.list?.() || []).map(serializePatch) };
}
case 'patch.revert': {
const patch = this.app?.patches?.at?.(BigInt(executionArgs.fileOffset));
return { patch: patch ? serializePatch(patch) : null };
}
case 'runtime.memory-write': {
const expected = byteArray(executionArgs.expectedBefore);
if (!expected.length || expected.length > 64 * 1024) throw new AIError('invalid_tool_call', 'Runtime expected-before must contain between 1 and 65536 bytes.');
const bytes = await runtimeSession(platform).adapter.readMemory(executionArgs.address, expected.length);
return Array.from(bytes || []);
}
case 'runtime.continue': case 'runtime.pause': case 'runtime.step-in': case 'runtime.step-over': case 'runtime.step-out':
return runtimeStatus(platform);
default:
throw new AIError('invalid_tool_call', `Capability ${id} cannot be proposed for approval.`);
}
}

async executeBuiltIn(entry, args, options, runtimePlatform = null, commitGuard = null) {
if (entry.id === 'runtime.memory-write') return atomicBoundedMemoryWrite(runtimePlatform, args, options, commitGuard);
if (entry.id === 'patch.create') return guardedCreatePatch(this.app, args, commitGuard);
if (entry.id === 'patch.apply') return guardedApplyPatch(this.app, args, commitGuard);
if (entry.id === 'patch.revert') return this.guardedRevertPatch(args, commitGuard);
if (commitGuard && PRECOMMIT_IDS.has(entry.id)) commitGuard();
return super.executeBuiltIn(entry, args, options, runtimePlatform);
}

guardedRevertPatch(args, commitGuard = null) {
const patch = this.app?.patches?.at?.(BigInt(args.fileOffset));
if (!patch) throw new AIError('tool_failed', 'Patch is no longer present.');
commitGuard?.();
this.app.patches.remove(patch.offset);
const metadata = serializePatch(patch);
this.reverts.set(String(patch.offset), metadata);
return { reverted: true, patch: metadata };
}
}

function captureMutationContext(entry, app, runtimePlatform) {
const patchSet = entry?.id?.startsWith?.('patch.') ? app?.patches || null : null;
const session = entry?.category === 'runtime' ? runtimePlatform?.currentSession?.(false) : null;
return Object.freeze({
patchSet,
runtimeSessionId: session?.id ?? null,
runtimeGeneration: session?.generation ?? null,
runtimeAdapter: session?.adapter || null,
});
}

function assertMutationContext(context, app, runtimePlatform) {
if (context?.patchSet && app?.patches !== context.patchSet) {
throw new AIError('scope_violation', 'The approved proposal mutation target changed before commit.');
}
if (context && (context.runtimeSessionId != null || context.runtimeAdapter)) {
const session = runtimePlatform?.currentSession?.(false);
if (!session || session.id !== context.runtimeSessionId
|| (context.runtimeGeneration != null && session.generation !== context.runtimeGeneration)
|| session.adapter !== context.runtimeAdapter) {
throw new AIError('scope_violation', 'The approved runtime session changed before commit.');
}
}
}

function snapshotApprovedArguments(value) {
const clone = globalThis.structuredClone;
if (typeof clone !== 'function') throw new AIError('tool_failed', 'Structured cloning is unavailable for approved capability arguments.');
let snapshot;
try { snapshot = clone(value); }
catch { throw new AIError('invalid_tool_call', 'Approved capability arguments must be structured-cloneable.'); }
if (containsSharedMemory(snapshot)) throw new AIError('invalid_tool_call', 'Approved capability arguments must not contain shared memory.');
return snapshot;
}

function containsSharedMemory(value, seen = new WeakSet()) {
if (value === null || typeof value !== 'object') return false;
const SharedBuffer = globalThis.SharedArrayBuffer;
if (typeof SharedBuffer === 'function' && value instanceof SharedBuffer) return true;
if (ArrayBuffer.isView(value)) return typeof SharedBuffer === 'function' && value.buffer instanceof SharedBuffer;
if (value instanceof ArrayBuffer || seen.has(value)) return false;
seen.add(value);
if (value instanceof Map) {
for (const [key, item] of value) if (containsSharedMemory(key, seen) || containsSharedMemory(item, seen)) return true;
return false;
}
if (value instanceof Set) {
for (const item of value) if (containsSharedMemory(item, seen)) return true;
return false;
}
for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
if ('value' in descriptor && containsSharedMemory(descriptor.value, seen)) return true;
}
return false;
}

function runtimeStatus(platform) {
const session = platform?.currentSession?.(false);
return session ? {
connected: !!session.adapter?.connected,
sessionId: session.id,
binaryId: session.binaryHash || null,
backend: session.backend,
capabilities: session.adapter?.capabilities || {},
} : { connected: false, sessionId: null };
}

async function guardedCreatePatch(app, args, commitGuard) {
const architecture = String(app?.store?.get?.('architecture') || '').toLowerCase();
if (args.instruction !== false && !instructionPatchArchitectureSupported(architecture)) {
throw new AIError('invalid_tool_call', `Instruction patching is unsupported for architecture: ${architecture || 'unknown'}.`);
}
const address = BigInt(args.address), before = byteArray(args.before), after = byteArray(args.after);
if (!before.length || before.length !== after.length) throw new AIError('invalid_tool_call', 'Patch before/after lengths must match and be non-zero.');
const regions = app?.store?.get?.('regions') || [];
const region = regions.find((item) => address >= item.vmAddr && address < item.vmAddr + item.size);
const fileSize = app?.file?.size ?? app?.store?.get?.('fileInfo')?.size ?? null;
const range = validatePatchRange(region, address, after.length, fileSize, args.instruction !== false);
if (!range.ok) throw new AIError('invalid_tool_call', range.error);
if (app?.patches?.at?.(range.fileOffset)) throw new AIError('tool_failed', 'Patch target already has a patch; revert it before creating a replacement.');
const result = await app?.backend?.readAt?.(address, before.length);
if (!result?.found || !equalBytes(result.bytes, before)) throw new AIError('tool_failed', 'Patch target is stale: original bytes no longer match expected-before.');
commitGuard?.();
app.patches?.add?.(range.fileOffset, before, after, {
addr: address, label: args.label || null, reason: args.reason || null,
expectedBefore: before, createdAt: new Date().toISOString(),
});
const stored = app.patches?.at?.(range.fileOffset);
if (!stored || !equalBytes(stored.before, before) || !equalBytes(stored.after, after)) throw new AIError('tool_failed', 'Patch postcondition verification failed.');
return serializePatch(stored);
}

async function guardedApplyPatch(app, args, commitGuard) {
const source = args.file || app?.file;
const patches = app?.patches;
const output = await patches?.apply?.(source);
commitGuard?.();
if (!(output instanceof Blob)) throw new AIError('tool_failed', 'Patch application did not produce an output Blob.');
return { ok: true, output, size: output.size, patches: patches.list().map(serializePatch) };
}

function serializePatch(item) {
return {
fileOffset: item.offset.toString(), address: item.addr == null ? null : String(item.addr),
before: Array.from(item.before), after: Array.from(item.after),
label: item.label || null, reason: item.reason || null,
};
}

export function createCapabilityExecutor(options) {
return new CapabilityExecutor(options);
}
