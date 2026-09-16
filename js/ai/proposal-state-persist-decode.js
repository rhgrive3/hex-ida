import { AIError } from './schema.js';
export function decodePersistedExecutionPayload(text) {
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
