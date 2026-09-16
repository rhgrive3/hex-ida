import { AIError } from './schema.js';
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag)?.get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'buffer')?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'byteOffset')?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'byteLength')?.get;
const DATA_VIEW_BUFFER_GETTER = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')?.get;
const DATA_VIEW_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')?.get;
const DATA_VIEW_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')?.get;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
export function intrinsicBinaryContainer(value) {
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
