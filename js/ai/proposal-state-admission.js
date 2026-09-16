import { AIError } from './schema.js';
import { intrinsicBinaryContainer } from './proposal-state-binary.js';
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
const PROPOSAL_STATE_MAX_BINARY_BYTES = 256 * 1024;
const PROPOSAL_STATE_MAX_NODES = 250_000;
const PROPOSAL_STATE_MAX_DEPTH = 128;
export function admitBoundedProposalState(values) {
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
export function rejectUnstableProposalState(value, seen = new Set()) {
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
