import { AIError } from './schema.js';
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
export function snapshotProposalPayload(value, stableBefore = value.before) {
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
