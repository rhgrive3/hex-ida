import { AIError } from './schema.js';
import { stableDigest } from '../core/identity/index.js';
import { intrinsicBinaryContainer } from './proposal-state-binary.js';
export function fingerprint(value) {
return stableDigest(canonicalIdentity(value));
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
