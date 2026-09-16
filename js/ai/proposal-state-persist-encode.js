import { AIError } from './schema.js';
import { stableDigest } from '../core/identity/index.js';
import { intrinsicBinaryContainer } from './proposal-state-binary.js';
export function persistedValueRevision(value) {
return stableDigest(JSON.stringify(encodePersistedValue(value)));
}
export function encodePersistedExecutionPayload(payload) {
return JSON.stringify({
version: 1,
target: encodePersistedValue(payload.target),
before: encodePersistedValue(payload.before),
after: encodePersistedValue(payload.after),
});
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
