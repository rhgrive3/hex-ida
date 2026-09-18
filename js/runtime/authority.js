import { deepFreeze, stableDigest, stableDigestBytes, stableStringify } from '../core/identity/index.js';
import { DEBUG_CAPABILITIES } from '../debug/adapter.js';
import { isValidatedStage2CapabilityProof } from '../platform/stage2-profile-evidence.js';

export const RUNTIME_AUTHORITY_SCHEMA = 'hex-runtime-authority/v1';
export const RUNTIME_OBSERVATION_SCHEMA = 'hex-runtime-observation/v1';
const DEBUG_CAPABILITY_SET = new Set(DEBUG_CAPABILITIES);

// These are the locked Stage 2 profiles.  A runtime proof is an authority
// boundary, so accepting an arbitrary caller supplied profile label would let
// a provider mint a new profile merely by naming it.
const NATIVE_TARGET_PROFILES = new Set(['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc']);
const NATIVE_TARGET_PROVIDER_PROFILE = Object.freeze({
  'arm64:a64': 'native:remote-debug-v1:qemu-lldb',
  'arm64e:a64+pac': 'native:remote-debug-v1:qemu-lldb',
  'x86_64:long-64': 'native:lldb-compatible-v1:host',
  'riscv64:rv64imc': 'native:remote-debug-v1:qemu-lldb',
});
const PROVIDER_PROFILE_PATTERNS = Object.freeze([
  /^native:(?:remote-debug|lldb-compatible|frida-compatible|replay)-v1(?::[a-z0-9][a-z0-9._-]{0,63})?$/i,
  /^managed:(?:wasm|dex|cil|jvm):provider-bound-runtime-v1(?::[a-z0-9][a-z0-9._-]{0,63})?$/i,
]);
const MANAGED_TARGET_PROFILE = /^managed:(?:wasm|dex|cil|jvm):m6$/;
const VALID_RUNTIME_PROFILE_SUPPORT = new WeakSet();
// Runtime support is a live-provider authority, so the branding transition may
// not be driven by caller-supplied booleans. A receipt is only minted by a
// tracker that actually accepted the runtime traffic it now attests to (#8851).
const RUNTIME_VALIDATION_RECEIPT_SCHEMA = 'hex-runtime-validation-receipt/v1';
const VALID_RUNTIME_VALIDATION_RECEIPTS = new WeakSet();
const LIVE_RUNTIME_TRACKERS = new WeakSet();
const RECEIPT_BINDING_FIELDS = Object.freeze([
  'bindingId', 'providerIdentity', 'providerProfileId', 'runtimeInstanceIdentity',
  'targetIdentity', 'targetProfileId', 'binaryIdentity', 'buildIdentity',
  'moduleIdentity', 'loadMappingIdentity', 'sessionIdentity', 'commitSha',
  'treeSha', 'epoch',
]);
const BINDING_FIELDS = Object.freeze([
  'schemaVersion', 'providerIdentity', 'providerProfileId', 'providerVersion',
  'runtimeInstanceIdentity', 'targetIdentity', 'targetProfileId',
  'architectureProfileId', 'binaryIdentity', 'buildIdentity',
  'runtimeBuildIdentity', 'moduleIdentity', 'loadMappingIdentity',
  'sessionIdentity', 'capabilityVersion', 'commitSha', 'treeSha', 'epoch',
]);
const OBSERVATION_FIELDS = Object.freeze([
  'schemaVersion', 'bindingId', 'providerIdentity', 'providerProfileId',
  'providerVersion', 'runtimeInstanceIdentity', 'targetIdentity',
  'targetProfileId', 'architectureProfileId', 'binaryIdentity',
  'buildIdentity', 'runtimeBuildIdentity', 'moduleIdentity',
  'loadMappingIdentity', 'sessionIdentity', 'capabilityVersion', 'commitSha',
  'treeSha', 'epoch', 'sequence', 'observedAt', 'kind', 'payload', 'authority',
]);

function required(value, code) {
  if (typeof value !== 'string') throw new TypeError(code);
  const text = value.trim();
  if (!text) throw new TypeError(code);
  return text;
}

function optional(value, code) {
  if (value == null) return null;
  return required(value, code);
}

function optionalSha(value, code) {
  const text = optional(value, code);
  if (text == null) return null;
  const normalized = text.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new TypeError(code);
  return normalized;
}

function identityAlias(input, primary, alias, code) {
  const first = input[primary] == null ? null : required(input[primary], code);
  const second = input[alias] == null ? null : required(input[alias], code);
  if (first != null && second != null && first !== second) throw new TypeError('runtime-identity-alias-mismatch');
  return first ?? second;
}

function numericPrimitive(value, code) {
  // Authority ordering fields (epoch/sequence) are canonical numbers. Numeric
  // strings must not launder into authority identity; transport/UI boundaries
  // that need them convert explicitly before calling these constructors.
  if (typeof value === 'number') return value;
  throw new TypeError(code);
}

function uint(value, code) {
  const n = numericPrimitive(value, code);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(code);
  return n;
}

function boundedCount(value, fallback, max, code) {
  const n = value == null ? fallback : numericPrimitive(value, code);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new TypeError(code);
  return n;
}

// #8971 resource authority for canonical observation payloads. Admission is
// measured on the caller's own views before any owned copy, boxed byte array or
// identity material is allocated, so one oversized observation fails closed with
// a deterministic reason instead of aborting the worker heap.
const OBSERVATION_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const OBSERVATION_MAX_PAYLOAD_NODES = 65_536;
const OBSERVATION_MAX_RETAINED_BYTES = 8 * 1024 * 1024;
const OBSERVATION_IDENTITY_CHUNK_BYTES = 8_192;
// Keep the historical frozen `bytes:number[]` shape only for genuinely small
// binary leaves so existing small-record consumers remain source-compatible.
// Larger leaves use bounded immutable base64 chunks, avoiding one boxed Number
// per retained byte and making tracker read/snapshot clones proportional to a
// few hundred strings rather than millions of JS elements (#8971 property 8).
const OBSERVATION_BOXED_BINARY_MAX_BYTES = 64 * 1024;
const CANONICAL_BINARY_ENCODING = 'base64-chunks-v1';
const TRUSTED_CANONICAL_BINARY_INFO = new WeakMap();

function createObservationWorkControl(options = {}) {
  if (options == null) options = {};
  if (typeof options !== 'object' || Array.isArray(options)) throw new TypeError('runtime-observation-work-options-invalid');
  const signal = options.signal ?? null;
  const isCancelled = options.isCancelled ?? null;
  const deadlineAt = options.deadlineAt ?? null;
  const now = options.now ?? Date.now;
  if (signal != null && (typeof signal !== 'object' && typeof signal !== 'function')) throw new TypeError('runtime-observation-signal-invalid');
  if (isCancelled != null && typeof isCancelled !== 'function') throw new TypeError('runtime-observation-cancel-check-invalid');
  if (deadlineAt != null && (typeof deadlineAt !== 'number' || !Number.isFinite(deadlineAt))) throw new TypeError('runtime-observation-deadline-invalid');
  if (typeof now !== 'function') throw new TypeError('runtime-observation-clock-invalid');
  return Object.freeze({
    check() {
      if (signal?.aborted || (isCancelled && isCancelled())) throw new TypeError('runtime-observation-cancelled');
      if (deadlineAt != null) {
        const current = now();
        if (typeof current !== 'number' || !Number.isFinite(current)) throw new TypeError('runtime-observation-clock-invalid');
        if (current >= deadlineAt) throw new TypeError('runtime-observation-deadline-exceeded');
      }
    },
  });
}

// Canonical authority records must not retain mutable binary backing storage.
// Small values preserve the legacy frozen byte-array transport shape. Larger
// values are represented by frozen base64 chunks; strings are immutable and
// detached, so they preserve #6214 without per-byte boxed storage.
const CANONICAL_BINARY_TAG = '$hexRuntimeBinary';
const CANONICAL_BINARY_BYTES = 'bytes';
const CANONICAL_BINARY_TYPES = new Set([
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
]);

function sharedArrayBuffer(value) {
  return typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer;
}

function binaryTypeName(value) {
  if (value instanceof ArrayBuffer) return 'ArrayBuffer';
  if (sharedArrayBuffer(value)) return 'SharedArrayBuffer';
  const name = value?.constructor?.name;
  return typeof name === 'string' && name ? name : 'view';
}

function binaryBytes(value) {
  if (value instanceof ArrayBuffer || sharedArrayBuffer(value)) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function canonicalBinaryShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Object.prototype.hasOwnProperty.call(value, CANONICAL_BINARY_TAG)) return null;
  const type = value[CANONICAL_BINARY_TAG];
  if (!CANONICAL_BINARY_TYPES.has(type)) return null;
  const keys = Object.keys(value);
  if (keys.length === 2 && Object.prototype.hasOwnProperty.call(value, CANONICAL_BINARY_BYTES)
      && Array.isArray(value[CANONICAL_BINARY_BYTES])) {
    return { type, storage: 'boxed', byteLength: value[CANONICAL_BINARY_BYTES].length, bytes: value[CANONICAL_BINARY_BYTES] };
  }
  if (keys.length === 4
      && value.encoding === CANONICAL_BINARY_ENCODING
      && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0
      && Array.isArray(value.chunks)
      && Object.prototype.hasOwnProperty.call(value, 'encoding')
      && Object.prototype.hasOwnProperty.call(value, 'byteLength')
      && Object.prototype.hasOwnProperty.call(value, 'chunks')) {
    return { type, storage: 'packed', byteLength: value.byteLength, chunks: value.chunks };
  }
  return null;
}

function encodeBase64Range(bytes, start, end, control = null) {
  control?.check();
  if (typeof globalThis.btoa !== 'function') throw new TypeError('runtime-observation-base64-unavailable');
  let binary = '';
  for (let i = start; i < end; i += 1) {
    if ((i & 0x1fff) === 0) control?.check();
    binary += String.fromCharCode(Number(bytes[i]) & 0xff);
  }
  const out = globalThis.btoa(binary);
  control?.check();
  return out;
}

function decodeBase64Chunk(text, control = null) {
  control?.check();
  if (typeof text !== 'string' || text.length % 4 !== 0 || typeof globalThis.atob !== 'function') {
    throw new TypeError('runtime-observation-binary-invalid');
  }
  let binary;
  try { binary = globalThis.atob(text); } catch { throw new TypeError('runtime-observation-binary-invalid'); }
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    if ((index & 0x1fff) === 0) control?.check();
    out[index] = binary.charCodeAt(index);
  }
  if (globalThis.btoa(binary) !== text) throw new TypeError('runtime-observation-binary-invalid');
  control?.check();
  return out;
}

function canonicalBinaryInfo(value, control = null) {
  const shape = canonicalBinaryShape(value);
  if (!shape) return null;
  control?.check();
  const trusted = TRUSTED_CANONICAL_BINARY_INFO.get(value);
  if (trusted && trusted.type === shape.type && trusted.byteLength === shape.byteLength) {
    return { ...shape, digest: trusted.digest, trusted: true };
  }
  if (shape.storage === 'boxed') {
    for (let index = 0; index < shape.bytes.length; index += 1) {
      if ((index & 0x1fff) === 0) control?.check();
      const byte = shape.bytes[index];
      if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) throw new TypeError('runtime-observation-binary-invalid');
    }
    return { ...shape, digest: stableDigestBytes(shape.bytes) };
  }
  const expectedChunks = shape.byteLength === 0 ? 0 : Math.ceil(shape.byteLength / OBSERVATION_IDENTITY_CHUNK_BYTES);
  if (shape.chunks.length !== expectedChunks) throw new TypeError('runtime-observation-binary-invalid');
  const materialized = new Uint8Array(shape.byteLength);
  let decoded = 0;
  for (let index = 0; index < shape.chunks.length; index += 1) {
    control?.check();
    const text = shape.chunks[index];
    if (typeof text !== 'string') throw new TypeError('runtime-observation-binary-invalid');
    const remaining = shape.byteLength - decoded;
    const expectedBytes = Math.min(OBSERVATION_IDENTITY_CHUNK_BYTES, remaining);
    const expectedChars = Math.ceil(expectedBytes / 3) * 4;
    if (text.length !== expectedChars) throw new TypeError('runtime-observation-binary-invalid');
    const bytes = decodeBase64Chunk(text, control);
    if (bytes.byteLength !== expectedBytes) throw new TypeError('runtime-observation-binary-invalid');
    materialized.set(bytes, decoded);
    decoded += bytes.byteLength;
  }
  if (decoded !== shape.byteLength) throw new TypeError('runtime-observation-binary-invalid');
  return { ...shape, digest: stableDigestBytes(materialized) };
}

function canonicalBinary(type, bytes, control = null) {
  control?.check();
  const length = bytes.length ?? bytes.byteLength ?? 0;
  const digest = stableDigestBytes(bytes);
  if (length <= OBSERVATION_BOXED_BINARY_MAX_BYTES) {
    const copy = new Array(length);
    for (let index = 0; index < length; index += 1) {
      if ((index & 0x1fff) === 0) control?.check();
      copy[index] = Number(bytes[index]) & 0xff;
    }
    const canonical = Object.freeze({
      [CANONICAL_BINARY_TAG]: type,
      [CANONICAL_BINARY_BYTES]: Object.freeze(copy),
    });
    TRUSTED_CANONICAL_BINARY_INFO.set(canonical, { type, byteLength: length, digest });
    return canonical;
  }
  const chunks = [];
  for (let offset = 0; offset < length; offset += OBSERVATION_IDENTITY_CHUNK_BYTES) {
    control?.check();
    chunks.push(encodeBase64Range(bytes, offset, Math.min(offset + OBSERVATION_IDENTITY_CHUNK_BYTES, length), control));
  }
  const canonical = Object.freeze({
    [CANONICAL_BINARY_TAG]: type,
    encoding: CANONICAL_BINARY_ENCODING,
    byteLength: length,
    chunks: Object.freeze(chunks),
  });
  TRUSTED_CANONICAL_BINARY_INFO.set(canonical, { type, byteLength: length, digest });
  return canonical;
}

function canonicalBinaryFromInfo(info, control = null) {
  if (info.storage === 'boxed') return canonicalBinary(info.type, info.bytes, control);
  const canonical = Object.freeze({
    [CANONICAL_BINARY_TAG]: info.type,
    encoding: CANONICAL_BINARY_ENCODING,
    byteLength: info.byteLength,
    chunks: Object.freeze([...info.chunks]),
  });
  TRUSTED_CANONICAL_BINARY_INFO.set(canonical, {
    type: info.type,
    byteLength: info.byteLength,
    digest: info.digest,
  });
  return canonical;
}

function binaryLeafResource(value) {
  const shape = canonicalBinaryShape(value);
  if (shape) return shape.byteLength;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || sharedArrayBuffer(value)) {
    return binaryBytes(value).byteLength;
  }
  return null;
}

// #8971 byte/work admission. The budget is charged against the caller's views
// before `clone()` allocates the owned copy, and against an already-canonical
// record before its binary representation is walked again.
function admitPayloadResources(value, budget, seen, control = null) {
  control?.check();
  if (value === null || typeof value !== 'object') {
    budget.nodes += 1;
  } else {
    const binaryBytesUsed = binaryLeafResource(value);
    if (binaryBytesUsed !== null) {
      budget.bytes += binaryBytesUsed;
      budget.nodes += 1;
    } else if (seen.has(value)) {
      throw new TypeError('runtime-observation-cyclic-payload');
    } else {
      seen.add(value);
      budget.nodes += 1;
      if (Array.isArray(value)) {
        for (const item of value) admitPayloadResources(item, budget, seen, control);
      } else if (value instanceof Map) {
        for (const [key, item] of value) {
          admitPayloadResources(key, budget, seen, control);
          admitPayloadResources(item, budget, seen, control);
        }
      } else if (value instanceof Set) {
        for (const item of value) admitPayloadResources(item, budget, seen, control);
      } else if (!(value instanceof Date)) {
        for (const key of Object.keys(value)) admitPayloadResources(value[key], budget, seen, control);
      }
      seen.delete(value);
    }
  }
  if (budget.bytes > OBSERVATION_MAX_PAYLOAD_BYTES) throw new TypeError('runtime-observation-payload-bytes-exceed-limit');
  if (budget.nodes > OBSERVATION_MAX_PAYLOAD_NODES) throw new TypeError('runtime-observation-payload-nodes-exceed-limit');
}

function payloadRetainedBytes(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return 0;
  const leaf = binaryLeafResource(value);
  if (leaf !== null) return leaf;
  if (seen.has(value)) return 0;
  seen.add(value);
  let total = 0;
  if (Array.isArray(value)) {
    for (const item of value) total += payloadRetainedBytes(item, seen);
  } else if (value instanceof Map) {
    for (const [key, item] of value) total += payloadRetainedBytes(key, seen) + payloadRetainedBytes(item, seen);
  } else if (value instanceof Set) {
    for (const item of value) total += payloadRetainedBytes(item, seen);
  } else if (!(value instanceof Date)) {
    for (const key of Object.keys(value)) total += payloadRetainedBytes(value[key], seen);
  }
  seen.delete(value);
  return total;
}

function cloneFallback(value, seen = new WeakMap(), control = null) {
  control?.check();
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  const info = canonicalBinaryInfo(value, control);
  if (info) {
    const canonical = canonicalBinaryFromInfo(info, control);
    seen.set(value, canonical);
    return canonical;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || sharedArrayBuffer(value)) {
    const canonical = canonicalBinary(binaryTypeName(value), binaryBytes(value), control);
    seen.set(value, canonical);
    return canonical;
  }
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    seen.set(value, copy);
    return copy;
  }
  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    for (const [key, item] of value) copy.set(cloneFallback(key, seen, control), cloneFallback(item, seen, control));
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    for (const item of value) copy.add(cloneFallback(item, seen, control));
    return copy;
  }
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(cloneFallback(item, seen, control));
    return copy;
  }
  const copy = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, {
      value: cloneFallback(value[key], seen, control), enumerable: true, configurable: true, writable: true,
    });
  }
  return copy;
}

function clone(value, control = null) {
  if (value == null || typeof value !== 'object') return value;
  return cloneFallback(value, new WeakMap(), control);
}

function capabilityList(value) {
  if (!Array.isArray(value)) return [];
  const normalized = value.map((capability) => {
    if (typeof capability !== 'string' || !capability.trim()) throw new TypeError('runtime-capability-invalid');
    return capability.trim();
  });
  const out = [...new Set(normalized)].sort();
  for (const capability of out) if (!DEBUG_CAPABILITY_SET.has(capability)) throw new TypeError(`runtime-capability-unknown:${capability}`);
  return out;
}

function hasOwnTrueCapability(source, capability) {
  return !!source
    && typeof source === 'object'
    && !Array.isArray(source)
    && Object.prototype.hasOwnProperty.call(source, capability)
    && source[capability] === true;
}

function identityList(value, code) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(code);
  const normalized = value.map((item) => required(item, code));
  const out = [...new Set(normalized)].sort();
  if (out.length === 0) throw new TypeError(code);
  return out;
}

function bindingPayload(input = {}) {
  const targetProfileId = identityAlias(input, 'targetProfileId', 'architectureProfileId', 'runtime-target-profile-required');
  const buildIdentity = identityAlias(input, 'buildIdentity', 'runtimeBuildIdentity', 'runtime-build-identity-invalid');
  return {
    schemaVersion: RUNTIME_AUTHORITY_SCHEMA,
    providerIdentity: required(input.providerIdentity, 'runtime-provider-identity-required'),
    providerProfileId: optional(input.providerProfileId, 'runtime-provider-profile-invalid'),
    providerVersion: optional(input.providerVersion, 'runtime-provider-version-invalid'),
    runtimeInstanceIdentity: required(input.runtimeInstanceIdentity, 'runtime-instance-identity-required'),
    targetIdentity: required(input.targetIdentity ?? input.processIdentity, 'runtime-target-identity-required'),
    targetProfileId,
    architectureProfileId: targetProfileId,
    binaryIdentity: required(input.binaryIdentity ?? input.binaryHash, 'runtime-binary-identity-required'),
    buildIdentity,
    runtimeBuildIdentity: buildIdentity,
    moduleIdentity: required(input.moduleIdentity, 'runtime-module-identity-required'),
    loadMappingIdentity: required(input.loadMappingIdentity, 'runtime-load-mapping-identity-required'),
    sessionIdentity: required(input.sessionIdentity ?? input.sessionId, 'runtime-session-identity-required'),
    capabilityVersion: required(input.capabilityVersion, 'runtime-capability-version-required'),
    commitSha: optionalSha(input.commitSha ?? input.sourceCommitSha, 'runtime-commit-identity-invalid'),
    treeSha: optionalSha(input.treeSha ?? input.sourceTreeSha, 'runtime-tree-identity-invalid'),
    epoch: uint(input.epoch ?? 0, 'runtime-epoch-invalid'),
  };
}

function bindingIdFor(binding) {
  const payload = {};
  for (const field of BINDING_FIELDS) if (field !== 'schemaVersion' || binding[field] != null) payload[field] = binding[field];
  return `runtime-binding:${stableDigest(payload)}`;
}

function canonicalBinding(input, { throwOnError = true } = {}) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('runtime-binding-schema-invalid');
    if (input.schemaVersion != null && input.schemaVersion !== RUNTIME_AUTHORITY_SCHEMA) throw new TypeError('runtime-binding-schema-invalid');
    const binding = bindingPayload(input);
    const expectedId = bindingIdFor(binding);
    if (input.schemaVersion === RUNTIME_AUTHORITY_SCHEMA && input.bindingId !== expectedId) throw new TypeError('runtime-binding-identity-invalid');
    return deepFreeze({ ...binding, bindingId: expectedId });
  } catch (error) {
    if (throwOnError) throw error;
    return null;
  }
}

function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function numberWitness(value) {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Infinity';
  if (value === -Infinity) return '-Infinity';
  if (Object.is(value, -0)) return '-0';
  return String(value);
}

// #8971 byte-native identity material. `stableDigestBytes()` hashes the exact
// canonical byte-array text without allocating a boxed copy or decimal JSON.
// `type` + `length` + byte content remain identity-sensitive (#7108). The
// representation change is explicitly namespaced by runtime-observation:v3.
function binaryIdentityMaterial(type, bytes, control = null) {
  control?.check();
  const length = bytes.length ?? bytes.byteLength ?? 0;
  const digest = stableDigestBytes(bytes);
  control?.check();
  return { $t: 'binary', type, length, digest };
}

function canonicalBinaryIdentityMaterial(info, control = null) {
  control?.check();
  if (typeof info.digest !== 'string') throw new TypeError('runtime-observation-binary-invalid');
  return { $t: 'binary', type: info.type, length: info.byteLength, digest: info.digest };
}

// Observation identity must be sensitive to TYPES and canonical values, not
// just core jsonSafe text. This wrapper preserves special-number distinctions
// and gives Map/Set semantic collections insertion-order-independent material.
function typeTagged(value, seen = new WeakSet(), control = null) {
  if (value === null) return { $t: 'null' };
  switch (typeof value) {
    case 'bigint': return { $t: 'bigint', v: value.toString() };
    case 'number': return { $t: 'number', v: numberWitness(value) };
    case 'boolean': return { $t: 'boolean', v: value };
    case 'string': return { $t: 'string', v: value };
    case 'undefined': case 'function': case 'symbol': return { $t: typeof value };
  }
  const binaryInfo = canonicalBinaryInfo(value, control);
  if (binaryInfo) return canonicalBinaryIdentityMaterial(binaryInfo, control);
  if (seen.has(value)) fail('runtime-observation-cyclic-payload');
  seen.add(value);
  const nested = (item) => typeTagged(item, seen, control);
  let out;
  if (value instanceof Date) out = { $t: 'date', v: value.toISOString() };
  else if (ArrayBuffer.isView(value)) {
    out = binaryIdentityMaterial(value.constructor?.name ?? 'view', new Uint8Array(value.buffer, value.byteOffset, value.byteLength), control);
  } else if (value instanceof ArrayBuffer || sharedArrayBuffer(value)) {
    out = binaryIdentityMaterial(binaryTypeName(value), new Uint8Array(value), control);
  } else if (value instanceof Map) {
    const entries = [...value.entries()].map(([key, item]) => [nested(key), nested(item)]);
    entries.sort((a, b) => compareCanonicalText(stableStringify(a[0]), stableStringify(b[0])) || compareCanonicalText(stableStringify(a[1]), stableStringify(b[1])));
    out = { $t: 'Map', v: entries };
  } else if (value instanceof Set) {
    const values = [...value].map(nested);
    values.sort((a, b) => compareCanonicalText(stableStringify(a), stableStringify(b)));
    out = { $t: 'Set', v: values };
  } else if (Array.isArray(value)) out = { $t: 'array', v: value.map(nested) };
  else {
    out = { $t: 'object' };
    for (const key of Object.keys(value).sort()) out[key] = nested(value[key]);
  }
  seen.delete(value);
  return out;
}

function observationIdentity(observation, control = null) {
  const payload = {};
  for (const field of OBSERVATION_FIELDS) payload[field] = typeTagged(observation[field], new WeakSet(), control);
  // #8971: the binary identity material changed representation, so the derived
  // id is explicitly migrated instead of silently reusing the v2 namespace.
  return `runtime-observation:v3:${stableDigest(payload)}`;
}

function profileAllowed(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return !!text && PROVIDER_PROFILE_PATTERNS.some((pattern) => pattern.test(text));
}

function targetProfileAllowed(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return !!text && (NATIVE_TARGET_PROFILES.has(text) || MANAGED_TARGET_PROFILE.test(text));
}

function authorityText(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return text || false;
}

function authoritySha(value) {
  const text = authorityText(value);
  if (text == null || text === false) return text;
  const normalized = text.toLowerCase();
  return /^[0-9a-f]{40}$/.test(normalized) ? normalized : false;
}

function mismatchReason(binding, providerProfileId, targetProfileId, expectedBuildIdentity, proof = {}) {
  const boundProviderProfileId = binding.providerProfileId;
  const boundTargetProfileId = binding.targetProfileId;
  const proofProviderProfileId = authorityText(proof.providerProfileId);
  const proofTargetProfileId = authorityText(proof.targetProfileId);
  const proofProviderIdentity = authorityText(proof.providerIdentity);
  const proofBuildIdentity = authorityText(proof.buildIdentity ?? proof.runtimeBuildIdentity ?? null);
  if (proofProviderProfileId === false || proofTargetProfileId === false || proofProviderIdentity === false || proofBuildIdentity === false) return 'runtime-proof-identity-invalid';
  const expectedBuild = authorityText(expectedBuildIdentity);
  if (expectedBuild === false) return 'runtime-build-identity-invalid';
  if (!profileAllowed(providerProfileId)) return 'runtime-provider-profile-unsupported';
  if (!targetProfileAllowed(targetProfileId)) return 'runtime-target-profile-unsupported';
  if (NATIVE_TARGET_PROVIDER_PROFILE[targetProfileId] && NATIVE_TARGET_PROVIDER_PROFILE[targetProfileId] !== providerProfileId) return 'runtime-provider-target-profile-mismatch';
  if (boundProviderProfileId !== providerProfileId) return 'runtime-provider-profile-mismatch';
  if (boundTargetProfileId !== targetProfileId) return 'runtime-target-profile-mismatch';
  if (proofProviderProfileId != null && proofProviderProfileId !== providerProfileId) return 'runtime-proof-provider-profile-mismatch';
  if (proofTargetProfileId != null && proofTargetProfileId !== targetProfileId) return 'runtime-proof-target-profile-mismatch';
  if (proofProviderIdentity != null && proofProviderIdentity !== binding.providerIdentity) return 'runtime-proof-provider-identity-mismatch';
  if (expectedBuild != null && binding.buildIdentity !== expectedBuild) return 'runtime-build-identity-mismatch';
  if (proofBuildIdentity != null && proofBuildIdentity !== binding.buildIdentity) return 'runtime-proof-build-identity-mismatch';
  return null;
}

export function createRuntimeAuthorityBinding(input = {}) {
  // The factory creates a new authority record.  A caller may spread an
  // existing record while advancing an epoch or replacing a session, so an
  // old schema/id pair is input metadata rather than an assertion here.
  return canonicalBinding({ ...input, schemaVersion: undefined, bindingId: undefined });
}

export function createRuntimeObservation(input = {}, options = {}) {
  const control = createObservationWorkControl(options);
  control.check();
  const binding = canonicalBinding(input.binding || input);
  const payload = input.payload ?? null;
  // #8971: charge the byte/node budget before any owned copy or identity work.
  admitPayloadResources(payload, { bytes: 0, nodes: 0 }, new WeakSet(), control);
  const sequence = uint(input.sequence, 'runtime-observation-sequence-invalid');
  const observedAt = required(input.observedAt ?? input.timestamp, 'runtime-observation-timestamp-required');
  const observation = {
    schemaVersion: RUNTIME_OBSERVATION_SCHEMA,
    bindingId: binding.bindingId,
    providerIdentity: binding.providerIdentity,
    providerProfileId: binding.providerProfileId,
    providerVersion: binding.providerVersion,
    runtimeInstanceIdentity: binding.runtimeInstanceIdentity,
    targetIdentity: binding.targetIdentity,
    targetProfileId: binding.targetProfileId,
    architectureProfileId: binding.architectureProfileId,
    binaryIdentity: binding.binaryIdentity,
    buildIdentity: binding.buildIdentity,
    runtimeBuildIdentity: binding.runtimeBuildIdentity,
    moduleIdentity: binding.moduleIdentity,
    loadMappingIdentity: binding.loadMappingIdentity,
    sessionIdentity: binding.sessionIdentity,
    capabilityVersion: binding.capabilityVersion,
    commitSha: binding.commitSha,
    treeSha: binding.treeSha,
    epoch: binding.epoch,
    sequence,
    observedAt,
    kind: required(input.kind ?? 'observation', 'runtime-observation-kind-required'),
    payload: freezeObservationValue(clone(payload, control)),
    authority: 'runtime-evidence',
  };
  const observationId = observationIdentity(observation, control);
  control.check();
  return freezeObservationValue(deepFreeze({ ...observation, observationId }));
}


export function validateRuntimeObservation(bindingInput, observation, options = {}) {
  let control;
  try { control = createObservationWorkControl(options); control.check(); }
  catch (error) { return { ok: false, reason: error?.message || 'runtime-observation-work-invalid' }; }
  const binding = canonicalBinding(bindingInput || {}, { throwOnError: false });
  if (!binding) return { ok: false, reason: 'runtime-binding-identity-invalid' };
  if (!observation || typeof observation !== 'object' || observation.schemaVersion !== RUNTIME_OBSERVATION_SCHEMA) return { ok: false, reason: 'runtime-observation-schema-invalid' };
  if (observation.authority !== 'runtime-evidence') return { ok: false, reason: 'runtime-observation-authority-invalid' };
  const identityKeys = ['bindingId', 'providerIdentity', 'providerProfileId', 'providerVersion', 'runtimeInstanceIdentity', 'targetIdentity', 'targetProfileId', 'architectureProfileId', 'binaryIdentity', 'buildIdentity', 'runtimeBuildIdentity', 'moduleIdentity', 'loadMappingIdentity', 'sessionIdentity', 'capabilityVersion', 'commitSha', 'treeSha', 'epoch'];
  for (const key of identityKeys) {
    if (observation[key] !== binding[key]) return { ok: false, reason: `runtime-observation-${key}-mismatch`, expected: binding[key], observed: observation[key] };
  }
  if (typeof observation.sequence !== 'number' || !Number.isSafeInteger(observation.sequence) || observation.sequence < 0) return { ok: false, reason: 'runtime-observation-sequence-invalid' };
  if (typeof observation.observedAt !== 'string' || !observation.observedAt.trim()) return { ok: false, reason: 'runtime-observation-timestamp-required' };
  if (typeof observation.kind !== 'string' || !observation.kind.trim()) return { ok: false, reason: 'runtime-observation-kind-required' };
  try {
    // Imported/schema observations must obey the same pre-canonical resource
    // authority as freshly created records; do this before identity traversal.
    admitPayloadResources(observation.payload, { bytes: 0, nodes: 0 }, new WeakSet(), control);
    if (observation.observationId !== observationIdentity(observation, control)) return { ok: false, reason: 'runtime-observation-identity-invalid' };
  } catch (error) {
    return { ok: false, reason: error?.message || 'runtime-observation-invalid' };
  }
  const minimumSequence = options.minimumSequence == null ? 0 : uint(options.minimumSequence, 'runtime-minimum-sequence-invalid');
  if (observation.sequence < minimumSequence) return { ok: false, reason: 'runtime-observation-stale-sequence' };
  return { ok: true, binding, observation };
}

function freezeObservationValue(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Map) {
    for (const [k, v] of value.entries()) {
      freezeObservationValue(k, seen);
      freezeObservationValue(v, seen);
    }
    Object.defineProperty(value, 'set', { value: () => { throw new TypeError('Cannot mutate frozen Map'); }, configurable: false, writable: false });
    Object.defineProperty(value, 'delete', { value: () => { throw new TypeError('Cannot mutate frozen Map'); }, configurable: false, writable: false });
    Object.defineProperty(value, 'clear', { value: () => { throw new TypeError('Cannot mutate frozen Map'); }, configurable: false, writable: false });
    return Object.freeze(value);
  }
  if (value instanceof Set) {
    for (const v of value.values()) {
      freezeObservationValue(v, seen);
    }
    Object.defineProperty(value, 'add', { value: () => { throw new TypeError('Cannot mutate frozen Set'); }, configurable: false, writable: false });
    Object.defineProperty(value, 'delete', { value: () => { throw new TypeError('Cannot mutate frozen Set'); }, configurable: false, writable: false });
    Object.defineProperty(value, 'clear', { value: () => { throw new TypeError('Cannot mutate frozen Set'); }, configurable: false, writable: false });
    return Object.freeze(value);
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return value;
  }
  for (const child of Object.values(value)) {
    freezeObservationValue(child, seen);
  }
  return Object.freeze(value);
}


export class RuntimeAuthorityTracker {
  #observations;
  #retainedBytes;
  #acceptedObservationIds;
  #mutationAuthorityIds;

  constructor(bindingInput, options = {}) {
    this.binding = canonicalBinding(bindingInput || {});
    this.lastSequence = -1;
    this.closed = false;
    this.maxObservations = boundedCount(options.maxObservations, 1024, 4096, 'runtime-max-observations-invalid');
    // #8971: count-based eviction alone cannot bound memory, because one accepted
    // record already owns its canonical payload copy.
    this.maxRetainedPayloadBytes = boundedCount(
      options.maxRetainedPayloadBytes, OBSERVATION_MAX_RETAINED_BYTES, OBSERVATION_MAX_PAYLOAD_BYTES * 8,
      'runtime-max-retained-payload-bytes-invalid',
    );
    this.#observations = [];
    this.#retainedBytes = 0;
    this.#acceptedObservationIds = new Set();
    this.#mutationAuthorityIds = new Set();
    LIVE_RUNTIME_TRACKERS.add(this);
  }

  #recordBounded(set, id) {
    set.add(id);
    while (set.size > this.maxObservations) set.delete(set.values().next().value);
  }

  get retainedPayloadBytes() {
    return this.#retainedBytes;
  }

  get observations() {
    return this.#observations.map((obs) => deepFreeze(freezeObservationValue(clone(obs))));
  }

  accept(input, options = {}) {
    if (this.closed) return Object.freeze({ status: 'rejected', reason: 'runtime-tracker-closed' });
    let observation;
    try {
      const control = createObservationWorkControl(options);
      control.check();
      if (input?.schemaVersion === RUNTIME_OBSERVATION_SCHEMA) {
        // Fail closed on imported canonical records before cloning attacker-
        // controlled binary/node material (#8971 property 9).
        admitPayloadResources(input.payload, { bytes: 0, nodes: 0 }, new WeakSet(), control);
        observation = deepFreeze(freezeObservationValue(clone(input, control)));
      } else {
        observation = createRuntimeObservation({ ...input, binding: this.binding }, options);
      }
    } catch (error) {
      return Object.freeze({ status: 'rejected', reason: error?.message || 'runtime-observation-invalid' });
    }

    const checked = validateRuntimeObservation(this.binding, observation, { ...options, minimumSequence: this.lastSequence + 1 });
    if (!checked.ok) return Object.freeze({ status: 'rejected', reason: checked.reason });
    const retained = payloadRetainedBytes(observation.payload);
    if (this.#retainedBytes + retained > this.maxRetainedPayloadBytes) {
      return Object.freeze({ status: 'rejected', reason: 'runtime-tracker-retained-payload-bytes-exceeded' });
    }
    this.lastSequence = observation.sequence;
    this.#observations.push(observation);
    this.#retainedBytes += retained;
    while (this.#observations.length > this.maxObservations) {
      const evicted = this.#observations.shift();
      this.#retainedBytes -= payloadRetainedBytes(evicted.payload);
    }
    this.#recordBounded(this.#acceptedObservationIds, observation.observationId);
    return Object.freeze({ status: 'accepted', observationId: observation.observationId, sequence: observation.sequence });
  }


  authorizeMutation(input = {}) {
    if (this.closed) return Object.freeze({ status: 'rejected', reason: 'runtime-tracker-closed' });
    const bindingId = required(input.bindingId ?? this.binding.bindingId, 'runtime-mutation-binding-required');
    if (bindingId !== this.binding.bindingId) return Object.freeze({ status: 'rejected', reason: 'runtime-mutation-binding-mismatch' });
    if (input.explicitApproval !== true) return Object.freeze({ status: 'rejected', reason: 'runtime-mutation-explicit-approval-required' });
    const actorIdentity = required(input.actorIdentity, 'runtime-mutation-actor-required');
    const operation = required(input.operation, 'runtime-mutation-operation-required');
    const scope = input.scope ?? {};
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
      throw new TypeError('runtime-mutation-scope-invalid');
    }
    const token = {
      schemaVersion: 'hex-runtime-mutation-authority/v1',
      bindingId,
      actorIdentity,
      operation,
      scope: clone(scope),
      issuedAt: required(input.issuedAt, 'runtime-mutation-issued-at-required'),
      authority: 'explicit-local-runtime-mutation',
    };
    const tokenId = `runtime-mutation:${stableDigest(token)}`;
    this.#recordBounded(this.#mutationAuthorityIds, tokenId);
    return Object.freeze({ status: 'authorized', token: deepFreeze({ ...token, tokenId }) });
  }

  mintProfileSupportReceipt(input = {}) {
    if (!LIVE_RUNTIME_TRACKERS.has(this)) throw new TypeError('runtime-receipt-mint-untrusted');
    if (this.closed) throw new TypeError('runtime-receipt-tracker-closed');
    const observationIdentities = identityList(input.observationIdentities, 'runtime-receipt-observation-identities-required');
    const mutationAuthorityIdentities = identityList(input.mutationAuthorityIdentities, 'runtime-receipt-mutation-identities-required');
    const testItemIdentities = identityList(input.testItemIdentities, 'runtime-receipt-test-identities-required');
    for (const observationId of observationIdentities) {
      if (!this.#acceptedObservationIds.has(observationId)) throw new TypeError(`runtime-receipt-observation-unbound:${observationId}`);
    }
    for (const mutationId of mutationAuthorityIdentities) {
      if (!this.#mutationAuthorityIds.has(mutationId)) throw new TypeError(`runtime-receipt-mutation-authority-unbound:${mutationId}`);
    }
    const receipt = {
      schemaVersion: RUNTIME_VALIDATION_RECEIPT_SCHEMA,
      bindingId: this.binding.bindingId,
      providerIdentity: this.binding.providerIdentity,
      providerProfileId: this.binding.providerProfileId,
      runtimeInstanceIdentity: this.binding.runtimeInstanceIdentity,
      targetIdentity: this.binding.targetIdentity,
      targetProfileId: this.binding.targetProfileId,
      binaryIdentity: this.binding.binaryIdentity,
      buildIdentity: this.binding.buildIdentity,
      moduleIdentity: this.binding.moduleIdentity,
      loadMappingIdentity: this.binding.loadMappingIdentity,
      sessionIdentity: this.binding.sessionIdentity,
      commitSha: this.binding.commitSha,
      treeSha: this.binding.treeSha,
      epoch: this.binding.epoch,
      lastSequence: this.lastSequence,
      observationIdentities: Object.freeze(observationIdentities),
      mutationAuthorityIdentities: Object.freeze(mutationAuthorityIdentities),
      testItemIdentities: Object.freeze(testItemIdentities),
    };
    const branded = deepFreeze({ ...receipt, receiptId: `runtime-receipt:${stableDigest(receipt)}` });
    VALID_RUNTIME_VALIDATION_RECEIPTS.add(branded);
    return branded;
  }

  nextEpoch(bindingOverrides = {}) {
    const nextBinding = createRuntimeAuthorityBinding({ ...this.binding, ...bindingOverrides, epoch: this.binding.epoch + 1, sessionIdentity: bindingOverrides.sessionIdentity ?? this.binding.sessionIdentity });
    this.closed = true;
    return nextBinding;
  }

  snapshot() {
    return deepFreeze({ binding: this.binding, lastSequence: this.lastSequence, observations: [...this.observations] });
  }
}

function runtimeReceiptReason(receipt, canonical, providerProfileId, targetProfileId) {
  if (!receipt || typeof receipt !== 'object' || !VALID_RUNTIME_VALIDATION_RECEIPTS.has(receipt)) return 'runtime-validation-receipt-required';
  if (receipt.schemaVersion !== RUNTIME_VALIDATION_RECEIPT_SCHEMA) return 'runtime-validation-receipt-schema-invalid';
  for (const field of RECEIPT_BINDING_FIELDS) {
    if (receipt[field] !== canonical[field]) return `runtime-validation-receipt-identity-mismatch:${field}`;
  }
  if (receipt.providerProfileId !== providerProfileId) return 'runtime-validation-receipt-provider-profile-mismatch';
  if (receipt.targetProfileId !== targetProfileId) return 'runtime-validation-receipt-target-profile-mismatch';
  for (const field of ['observationIdentities', 'mutationAuthorityIdentities', 'testItemIdentities']) {
    if (!Array.isArray(receipt[field]) || receipt[field].length === 0) return `runtime-validation-receipt-evidence-missing:${field}`;
  }
  return null;
}

export function runtimeProfileSupport({
  binding,
  providerProfileId = null,
  targetProfileId = null,
  providerCapabilities = {},
  requiredCapabilities = [],
  proof = {},
  expectedHeadSha = null,
  expectedTreeSha = null,
  expectedBuildIdentity = null,
  profileProof = null,
  runtimeReceipt = null,
} = {}) {
  const canonical = canonicalBinding(binding || {}, { throwOnError: false });
  const hasBinding = canonical != null;
  const declared = capabilityList(requiredCapabilities);
  // Capability support is authority input, not a convenience lookup.  An
  // inherited property (for example from a prototype carrying attacker
  // supplied flags) is not evidence that this provider advertises the
  // operation.  Malformed maps fail closed as a missing denominator.
  const missing = declared.filter((key) => !hasOwnTrueCapability(providerCapabilities, key));
  const proofComplete = proof.exactHead === true
    && proof.identityNegativeTests === true
    && proof.staleEventTests === true
    && proof.lifecycleTests === true
    && proof.capabilityTests === true
    && proof.moduleMappingTests === true
    && proof.mutationAuthorityTests === true;
  const normalizedProviderProfileId = authorityText(providerProfileId);
  const normalizedTargetProfileId = authorityText(targetProfileId);
  let reason = null;
  if (!hasBinding) reason = 'runtime-binding-identity-invalid';
  else if (normalizedProviderProfileId === false || normalizedTargetProfileId === false) reason = 'runtime-profile-identity-invalid';
  else if (!normalizedProviderProfileId || !normalizedTargetProfileId) reason = 'runtime-profile-identity-required';
  else reason = mismatchReason(canonical, normalizedProviderProfileId, normalizedTargetProfileId, expectedBuildIdentity, proof);

  const managedMatch = typeof normalizedTargetProfileId === 'string' ? normalizedTargetProfileId.match(/^managed:(wasm|dex|cil|jvm):m6$/) : null;
  const profileItemId = managedMatch ? `S2-M6-${managedMatch[1].toUpperCase()}` : 'S2-A7-NATIVE';
  const profileEvidenceComplete = normalizedTargetProfileId
    && isValidatedStage2CapabilityProof(profileProof, { itemId: profileItemId, profileIds: [normalizedTargetProfileId] })
    && profileProof.commitSha === canonical?.commitSha
    && profileProof.treeSha === canonical?.treeSha;
  if (!reason && !profileEvidenceComplete) reason = 'runtime-profile-evidence-required';

  // A profile proof is only current when its head/tree agrees with both the
  // authority record and any caller-supplied expected revision.  A boolean
  // exactHead flag alone is not an identity.
  if (!reason && hasBinding) {
    const proofHeadSha = authoritySha(proof.headSha ?? proof.commitSha ?? null);
    const proofTreeSha = authoritySha(proof.treeSha ?? null);
    const expectedHead = authoritySha(expectedHeadSha ?? proof.expectedHeadSha ?? null);
    const expectedTree = authoritySha(expectedTreeSha ?? proof.expectedTreeSha ?? null);
    if ([proofHeadSha, proofTreeSha, expectedHead, expectedTree].includes(false)) reason = 'runtime-proof-exact-identity-invalid';
    else if (canonical.commitSha == null || canonical.treeSha == null || proofHeadSha == null || proofTreeSha == null) reason = 'runtime-proof-exact-identity-required';
    else if (proofHeadSha !== canonical.commitSha) reason = 'runtime-proof-stale-head';
    else if (proofTreeSha !== canonical.treeSha) reason = 'runtime-proof-stale-tree';
    else if (expectedHead != null && (canonical.commitSha !== expectedHead || proofHeadSha !== expectedHead)) reason = 'runtime-proof-stale-head';
    else if (expectedTree != null && (canonical.treeSha !== expectedTree || proofTreeSha !== expectedTree)) reason = 'runtime-proof-stale-tree';
  }
  if (!reason && hasBinding) reason = runtimeReceiptReason(runtimeReceipt, canonical, normalizedProviderProfileId, normalizedTargetProfileId);
  const proven = hasBinding
    && declared.length > 0
    && missing.length === 0
    && proofComplete
    && !reason
    && canonical.buildIdentity != null;
  const result = Object.freeze({
    status: proven ? 'supported-for-exact-provider-profile' : hasBinding ? 'partial' : 'unavailable',
    bindingId: hasBinding ? canonical.bindingId : null,
    providerIdentity: hasBinding ? canonical.providerIdentity : null,
    providerProfileId: normalizedProviderProfileId || null,
    targetProfileId: normalizedTargetProfileId || null,
    requiredCapabilities: Object.freeze(declared),
    missingCapabilities: Object.freeze(missing),
    proofComplete,
    buildIdentity: hasBinding ? canonical.buildIdentity : null,
    commitSha: hasBinding ? canonical.commitSha : null,
    treeSha: hasBinding ? canonical.treeSha : null,
    reason,
    authority: proven ? 'runtime-evidence-bound' : 'none',
    runtimeReceiptId: proven ? runtimeReceipt.receiptId : null,
    runtimeReceiptBindingId: proven ? runtimeReceipt.bindingId : null,
  });
  if (proven) VALID_RUNTIME_PROFILE_SUPPORT.add(result);
  return result;
}

export function isValidatedRuntimeProfileSupport(value) {
  return !!value && VALID_RUNTIME_PROFILE_SUPPORT.has(value) && value.status === 'supported-for-exact-provider-profile';
}
