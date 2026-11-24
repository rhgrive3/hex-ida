import { fnv64Text, fnv64Hex } from './fnv64.js';
import { getEngineMode, wasmStableStringify, wasmStableDigest } from '../hex-engine-bridge.js';

const ID_SCHEMA_VERSION = 1;
const HEX_RE = /^[0-9a-f]+$/i;

function fail(code) {
  throw new TypeError(code);
}

function nonEmpty(value, code) {
  if (typeof value !== 'string') fail(code);
  const text = value.trim();
  if (!text) fail(code);
  return text;
}

function nonNegativeInteger(value, fallback, code) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function sortedStrings(value, code) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(code);
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') fail(code);
    const text = item.trim();
    if (!text) fail(code);
    out.push(text);
  }
  return [...new Set(out)].sort();
}

function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}


// Only ordinary records have semantics fully represented by Object.keys().
// Structured types above are handled explicitly; every other prototype must
// fail closed rather than silently inherit plain-object identity semantics.
function isCanonicalPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnsupportedCanonicalObject(value) {
  if (!isCanonicalPlainObject(value)) fail('identity-unsupported-object');
}

function sortKeysIfNeeded(keys) {
  const len = keys.length;
  if (len <= 1) return keys;
  for (let i = 1; i < len; i += 1) {
    if (keys[i - 1] > keys[i]) {
      keys.sort();
      return keys;
    }
  }
  return keys;
}

function isArrayIndexKey(key) {
  const len = key.length;
  if (len === 0 || len > 10) return false;
  const c0 = key.charCodeAt(0);
  if (c0 < 0x30 || c0 > 0x39) return false;
  if (c0 === 0x30) return len === 1;
  let n = c0 - 0x30;
  for (let i = 1; i < len; i += 1) {
    const c = key.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
    n = n * 10 + (c - 0x30);
  }
  return n < 0xffffffff;
}

// Matches OrdinaryOwnPropertyKeys order on the object produced by jsonSafe():
// array-index keys first in ascending numeric order, followed by non-index keys
// in lexicographical code-unit order (including when a Proxy returns out-of-order keys).
function sortCanonicalJsonKeys(keys) {
  const len = keys.length;
  if (len <= 1) return keys;
  let sawNonIndex = false;
  let hasIndexAfterNonIndex = false;
  let prevIndex = -1;
  let indexOutOfOrder = false;
  let nonIndexOutOfOrder = false;
  let prevNonIndex = null;
  let split = 0;
  for (let i = 0; i < len; i += 1) {
    const k = keys[i];
    if (isArrayIndexKey(k)) {
      if (sawNonIndex) { hasIndexAfterNonIndex = true; break; }
      const n = Number(k);
      if (n <= prevIndex) indexOutOfOrder = true;
      prevIndex = n;
      split = i + 1;
    } else {
      sawNonIndex = true;
      if (prevNonIndex !== null && prevNonIndex > k) nonIndexOutOfOrder = true;
      prevNonIndex = k;
    }
  }
  if (!hasIndexAfterNonIndex && !indexOutOfOrder) {
    if (!nonIndexOutOfOrder) return keys;
    if (split === 0) { keys.sort(); return keys; }
    const rest = keys.slice(split).sort();
    for (let i = 0; i < rest.length; i += 1) keys[split + i] = rest[i];
    return keys;
  }
  const indexKeys = [];
  const otherKeys = [];
  for (let i = 0; i < len; i += 1) {
    const k = keys[i];
    if (isArrayIndexKey(k)) indexKeys.push(k);
    else otherKeys.push(k);
  }
  indexKeys.sort((a, b) => Number(a) - Number(b));
  otherKeys.sort();
  for (let i = 0; i < indexKeys.length; i += 1) keys[i] = indexKeys[i];
  for (let i = 0; i < otherKeys.length; i += 1) keys[indexKeys.length + i] = otherKeys[i];
  return keys;
}

export function jsonSafe(value, seen = null) {
  if (value == null) return value;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value) ? value : null;
  if (t === 'bigint') return value.toString();
  if (t === 'function' || t === 'symbol') return null;
  if (t !== 'object') return String(value);
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const out = new Array(view.length);
    for (let i = 0; i < view.length; i += 1) out[i] = view[i];
    return out;
  }
  if (value instanceof ArrayBuffer) {
    const view = new Uint8Array(value);
    const out = new Array(view.length);
    for (let i = 0; i < view.length; i += 1) out[i] = view[i];
    return out;
  }
  if (value instanceof Date) {
    // An invalid Date would throw a bare RangeError from toISOString() after
    // upstream strict-serializable validation had already accepted it. Fail
    // closed with the canonical identity error instead (#5853).
    if (!Number.isFinite(value.getTime())) fail('identity-invalid-date');
    return value.toISOString();
  }
  const active = seen ?? new WeakSet();
  if (active.has(value)) fail('identity-cyclic-value');
  active.add(value);
  let out;
  try {
    if (Array.isArray(value)) {
      const mapFn = value.map;
      if (mapFn !== Array.prototype.map) {
        out = mapFn.call(value, (item) => jsonSafe(item, active));
      } else {
        const len = value.length;
        out = new Array(len);
        for (let i = 0; i < len; i += 1) {
          if (i in value) out[i] = jsonSafe(value[i], active);
        }
      }
    } else if (value instanceof Map) {
      const entries = canonicalMapEntries(value, active);
      const pairs = new Array(entries.length);
      for (let i = 0; i < entries.length; i += 1) {
        pairs[i] = [entries[i].keyParts.normalized, entries[i].valueParts.normalized];
      }
      out = { $map: pairs };
    } else if (value instanceof Set) {
      const entries = canonicalSetEntries(value, active);
      const items = new Array(entries.length);
      for (let i = 0; i < entries.length; i += 1) items[i] = entries[i].parts.normalized;
      out = { $set: items };
    } else {
      rejectUnsupportedCanonicalObject(value);
      out = {};
      const keys = sortKeysIfNeeded(Object.keys(value));
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        const raw = value[key];
        const normalized = jsonSafe(raw, active);
        if (normalized !== null || raw === null) {
          // Assignment creates the same own data descriptor for a fresh key,
          // without allocating a descriptor on every property. Inherited names
          // (including __proto__, setters and non-writable prototype properties)
          // still require DefineProperty: never invoke an inherited setter.
          if (key in out) {
            Object.defineProperty(out, key, {
              value: normalized,
              enumerable: true,
              configurable: true,
              writable: true,
            });
          } else out[key] = normalized;
        }
      }
    }
  } finally {
    active.delete(value);
  }
  return out;
}

function hasCustomToJson() {
  return typeof Object.prototype.toJSON === 'function'
    || typeof Array.prototype.toJSON === 'function'
    || typeof String.prototype.toJSON === 'function'
    || typeof Number.prototype.toJSON === 'function'
    || typeof Boolean.prototype.toJSON === 'function';
}

function hasLoneSurrogate(str) {
  for (let i = 0, n = str.length; i < n; i += 1) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= n) return true;
      const next = str.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isWasmJsonSafe(val) {
  if (val === null) return true;
  const t = typeof val;
  if (t === 'boolean') return true;
  if (t === 'string') return !hasLoneSurrogate(val);
  if (t === 'number') return Number.isSafeInteger(val) || (val >= -1e21 && val <= 1e21);
  if (t !== 'object') return false;
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i += 1) {
      if (!(i in val)) continue;
      if (!isWasmJsonSafe(val[i])) return false;
    }
    return true;
  }
  const keys = Object.keys(val);
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (hasLoneSurrogate(k)) return false;
    if (!isWasmJsonSafe(val[k])) return false;
  }
  return true;
}

const WASM_IDENTITY_MIN_STRING_LEN = 64;

function shouldUseWasmForSafeValue(safe) {
  if (safe === null) return false;
  const t = typeof safe;
  if (t === 'string') return safe.length >= WASM_IDENTITY_MIN_STRING_LEN;
  if (t !== 'object') return false;
  if (Array.isArray(safe)) return safe.length > 0;
  return Object.keys(safe).length > 0;
}

function isTrivialInlineDigestValue(value) {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string') return value.length < WASM_IDENTITY_MIN_STRING_LEN;
  if (t !== 'object') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isCanonicalPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

export function stableStringify(value) {
  const safe = jsonSafe(value);
  if (safe === undefined) return undefined;
  if (!hasCustomToJson() && shouldUseWasmForSafeValue(safe) && isWasmJsonSafe(safe)) {
    const wasmText = wasmStableStringify(safe);
    if (wasmText !== null) return wasmText;
  }
  return JSON.stringify(safe);
}

const FNV_OFFSET_LOW = 0x84222325;
const FNV_OFFSET_HIGH = 0xcbf29ce4;

export function stableDigest(value) {
  const customToJson = hasCustomToJson();
  if (value === undefined || (Array.isArray(value) && value.map !== Array.prototype.map) || customToJson) {
    const text = stableStringify(value);
    return fnv64Text(text) + fnv64Text(text, FNV_OFFSET_HIGH, FNV_OFFSET_LOW);
  }
  let target = value;
  if (!isTrivialInlineDigestValue(value) && getEngineMode() !== 'js') {
    const safe = jsonSafe(value);
    if (safe !== undefined && shouldUseWasmForSafeValue(safe) && isWasmJsonSafe(safe)) {
      const wasmHash = typeof safe === 'string'
        ? wasmStableDigest(JSON.stringify(safe))
        : wasmStableDigest(safe);
      if (wasmHash !== null) return wasmHash;
    }
    target = safe;
  }
  let aLow = FNV_OFFSET_LOW; let aHigh = FNV_OFFSET_HIGH;
  let bLow = FNV_OFFSET_HIGH; let bHigh = FNV_OFFSET_LOW;
  const feedCode = (code) => {
    aLow ^= code;
    const aCarry = ((aLow >>> 16) * 0x1b3 + (((aLow & 0xffff) * 0x1b3) >>> 16)) >>> 16;
    aHigh = (Math.imul(aHigh, 0x1b3) + (aLow << 8) + aCarry) | 0;
    aLow = Math.imul(aLow, 0x1b3);
    bLow ^= code;
    const bCarry = ((bLow >>> 16) * 0x1b3 + (((bLow & 0xffff) * 0x1b3) >>> 16)) >>> 16;
    bHigh = (Math.imul(bHigh, 0x1b3) + (bLow << 8) + bCarry) | 0;
    bLow = Math.imul(bLow, 0x1b3);
  };
  const feedStr = (str) => {
    let al = aLow, ah = aHigh, bl = bLow, bh = bHigh;
    for (let i = 0, n = str.length; i < n; i += 1) {
      const code = str.charCodeAt(i);
      al ^= code;
      const ac = ((al >>> 16) * 0x1b3 + (((al & 0xffff) * 0x1b3) >>> 16)) >>> 16;
      ah = (Math.imul(ah, 0x1b3) + (al << 8) + ac) | 0;
      al = Math.imul(al, 0x1b3);
      bl ^= code;
      const bc = ((bl >>> 16) * 0x1b3 + (((bl & 0xffff) * 0x1b3) >>> 16)) >>> 16;
      bh = (Math.imul(bh, 0x1b3) + (bl << 8) + bc) | 0;
      bl = Math.imul(bl, 0x1b3);
    }
    aLow = al; aHigh = ah; bLow = bl; bHigh = bh;
  };
  const feedJsonString = (str) => {
    const len = str.length;
    for (let i = 0; i < len; i += 1) {
      const code = str.charCodeAt(i);
      if (code < 0x20 || code === 0x22 || code === 0x5c || code > 0x7e) {
        feedStr(JSON.stringify(str));
        return;
      }
    }
    feedCode(0x22);
    feedStr(str);
    feedCode(0x22);
  };
  const feedByte = (byte) => {
    if (byte >= 100) {
      feedCode(0x30 + ((byte / 100) | 0));
      feedCode(0x30 + (((byte / 10) | 0) % 10));
      feedCode(0x30 + (byte % 10));
    } else if (byte >= 10) {
      feedCode(0x30 + ((byte / 10) | 0));
      feedCode(0x30 + (byte % 10));
    } else {
      feedCode(0x30 + byte);
    }
  };
  let seen = null;
  const streamValue = (cur) => {
    if (cur === null) { feedStr('null'); return; }
    const t = typeof cur;
    if (t === 'string') { feedJsonString(cur); return; }
    if (t === 'boolean') { feedStr(cur ? 'true' : 'false'); return; }
    if (t === 'number') {
      if (!Number.isFinite(cur)) { feedStr('null'); return; }
      feedStr(Object.is(cur, -0) ? '0' : String(cur));
      return;
    }
    if (t === 'bigint') {
      feedCode(0x22);
      feedStr(cur.toString());
      feedCode(0x22);
      return;
    }
    if (t === 'undefined' || t === 'function' || t === 'symbol') { feedStr('null'); return; }
    if (t !== 'object') { feedStr(JSON.stringify(String(cur))); return; }
    if (ArrayBuffer.isView(cur)) {
      const view = new Uint8Array(cur.buffer, cur.byteOffset, cur.byteLength);
      feedCode(0x5b);
      for (let i = 0; i < view.length; i += 1) {
        if (i !== 0) feedCode(0x2c);
        feedByte(view[i]);
      }
      feedCode(0x5d);
      return;
    }
    if (cur instanceof ArrayBuffer) {
      const view = new Uint8Array(cur);
      feedCode(0x5b);
      for (let i = 0; i < view.length; i += 1) {
        if (i !== 0) feedCode(0x2c);
        feedByte(view[i]);
      }
      feedCode(0x5d);
      return;
    }
    if (cur instanceof Date) {
      if (!Number.isFinite(cur.getTime())) fail('identity-invalid-date');
      feedStr(JSON.stringify(cur.toISOString()));
      return;
    }
    if (seen === null) seen = new WeakSet();
    if (seen.has(cur)) fail('identity-cyclic-value');
    seen.add(cur);
    try {
      if (Array.isArray(cur)) {
        const mapFn = cur.map;
        if (mapFn !== Array.prototype.map) {
          const mapped = mapFn.call(cur, (item) => jsonSafe(item, seen));
          const text = JSON.stringify(mapped);
          feedStr(text === undefined ? 'null' : text);
        } else {
          feedCode(0x5b);
          const len = cur.length;
          for (let i = 0; i < len; i += 1) {
            if (i !== 0) feedCode(0x2c);
            if (i in cur) streamValue(cur[i]);
            else feedStr('null');
          }
          feedCode(0x5d);
        }
      } else if (cur instanceof Map) {
        const entries = canonicalMapEntries(cur, seen);
        feedStr('{"$map":[');
        for (let i = 0; i < entries.length; i += 1) {
          if (i !== 0) feedCode(0x2c);
          feedCode(0x5b);
          feedStr(entries[i].keyNormText ?? 'null');
          feedCode(0x2c);
          feedStr(entries[i].valueNormText ?? 'null');
          feedCode(0x5d);
        }
        feedStr(']}');
      } else if (cur instanceof Set) {
        const entries = canonicalSetEntries(cur, seen);
        feedStr('{"$set":[');
        for (let i = 0; i < entries.length; i += 1) {
          if (i !== 0) feedCode(0x2c);
          feedStr(entries[i].normText ?? 'null');
        }
        feedStr(']}');
      } else {
        rejectUnsupportedCanonicalObject(cur);
        feedCode(0x7b);
        const keys = sortCanonicalJsonKeys(Object.keys(cur));
        let first = true;
        for (let i = 0; i < keys.length; i += 1) {
          const key = keys[i];
          const raw = cur[key];
          if (raw === undefined) continue;
          const rt = typeof raw;
          if (rt === 'function' || rt === 'symbol') continue;
          if (rt === 'number' && !Number.isFinite(raw)) continue;
          if (Array.isArray(raw)) {
            const mapFn = raw.map;
            if (mapFn !== Array.prototype.map) {
              if (seen.has(raw)) fail('identity-cyclic-value');
              seen.add(raw);
              let mapped;
              try { mapped = mapFn.call(raw, (item) => jsonSafe(item, seen)); } finally { seen.delete(raw); }
              if (mapped === null) continue;
              const text = JSON.stringify(mapped);
              if (text === undefined) continue;
              if (!first) feedCode(0x2c);
              first = false;
              feedJsonString(key);
              feedCode(0x3a);
              feedStr(text);
              continue;
            }
          }
          if (!first) feedCode(0x2c);
          first = false;
          feedJsonString(key);
          feedCode(0x3a);
          streamValue(raw);
        }
        feedCode(0x7d);
      }
    } finally {
      seen.delete(cur);
    }
  };
  streamValue(target);
  return fnv64Hex(aLow, aHigh) + fnv64Hex(bLow, bHigh);
}

// Byte-native equivalent of `stableDigest(Array.from(bytes))`. It reproduces the
// exact canonical decimal-JSON text of a byte array ("[b0,b1,...]") and folds it
// through the same dual FNV-1a-64 pair WITHOUT materializing the boxed number
// array, the intermediate jsonSafe copy, or the whole-buffer decimal JSON string.
// Optional [start,end) bounds the hashed span, and [maskStart,maskEnd) treats that
// span as zeroed without cloning, so masked / partial binary identity stays
// content-complete at O(1) working memory (#8969). Output is byte-for-byte equal to
// `stableDigest(Array.from(bytes))` for the same integer 0..255 elements.
export function stableDigestBytes(bytes, start = 0, end = bytes == null ? 0 : bytes.length, maskStart = -1, maskEnd = -1) {
  if (bytes == null || typeof bytes.length !== 'number') fail('identity-bytes-required');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > bytes.length || end < start) fail('identity-byte-range-invalid');
  let aLow = FNV_OFFSET_LOW; let aHigh = FNV_OFFSET_HIGH;
  let bLow = FNV_OFFSET_HIGH; let bHigh = FNV_OFFSET_LOW;
  const feed = (code) => {
    aLow ^= code;
    const aCarry = ((aLow >>> 16) * 0x1b3 + (((aLow & 0xffff) * 0x1b3) >>> 16)) >>> 16;
    aHigh = (Math.imul(aHigh, 0x1b3) + (aLow << 8) + aCarry) | 0;
    aLow = Math.imul(aLow, 0x1b3);
    bLow ^= code;
    const bCarry = ((bLow >>> 16) * 0x1b3 + (((bLow & 0xffff) * 0x1b3) >>> 16)) >>> 16;
    bHigh = (Math.imul(bHigh, 0x1b3) + (bLow << 8) + bCarry) | 0;
    bLow = Math.imul(bLow, 0x1b3);
  };
  feed(0x5b); // '['
  const last = end - 1;
  for (let index = start; index < end; index += 1) {
    const byte = (index >= maskStart && index < maskEnd) ? 0 : bytes[index];
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) fail('identity-byte-invalid');
    if (byte >= 100) {
      feed(0x30 + ((byte / 100) | 0));
      feed(0x30 + (((byte / 10) | 0) % 10));
      feed(0x30 + (byte % 10));
    } else if (byte >= 10) {
      feed(0x30 + ((byte / 10) | 0));
      feed(0x30 + (byte % 10));
    } else {
      feed(0x30 + byte);
    }
    if (index !== last) feed(0x2c); // ','
  }
  feed(0x5d); // ']'
  return fnv64Hex(aLow, aHigh) + fnv64Hex(bLow, bHigh);
}

function canonicalWitnessParts(value, seen = new WeakSet()) {
  return {
    normalized: jsonSafe(value, seen),
    witness: lossyTypeWitness(value, '', seen),
  };
}

function compareCanonicalWitnessParts(left, right) {
  return compareCanonicalText(stableStringify(left.normalized), stableStringify(right.normalized))
    || compareCanonicalText(stableStringify(left.witness), stableStringify(right.witness));
}

export function sameCanonicalIdentityValue(left, right) {
  return compareCanonicalWitnessParts(canonicalWitnessParts(left), canonicalWitnessParts(right)) === 0;
}

function canonicalMapEntries(value, seen = new WeakSet()) {
  const entries = [];
  for (const [key, entryValue] of value.entries()) {
    const keyParts = canonicalWitnessParts(key, seen);
    const valueParts = canonicalWitnessParts(entryValue, seen);
    entries.push({
      key,
      value: entryValue,
      keyParts,
      valueParts,
      keyNormText: JSON.stringify(keyParts.normalized),
      valueNormText: JSON.stringify(valueParts.normalized),
      keyWitnessText: JSON.stringify(keyParts.witness),
      valueWitnessText: JSON.stringify(valueParts.witness),
    });
  }
  entries.sort((left, right) => (
    compareCanonicalText(left.keyNormText, right.keyNormText)
    || compareCanonicalText(left.valueNormText, right.valueNormText)
    || compareCanonicalText(left.keyWitnessText, right.keyWitnessText)
    || compareCanonicalText(left.valueWitnessText, right.valueWitnessText)
  ));
  return entries;
}

function canonicalSetEntries(value, seen = new WeakSet()) {
  const entries = [];
  for (const entryValue of value) {
    const parts = canonicalWitnessParts(entryValue, seen);
    entries.push({
      value: entryValue,
      parts,
      normText: JSON.stringify(parts.normalized),
      witnessText: JSON.stringify(parts.witness),
    });
  }
  entries.sort((left, right) => (
    compareCanonicalText(left.normText, right.normText)
    || compareCanonicalText(left.witnessText, right.witnessText)
  ));
  return entries;
}

function typedId(prefix, payload) {
  return `${prefix}_${stableDigest({ schema: ID_SCHEMA_VERSION, payload })}`;
}

const CANONICAL_ARTIFACT_ID_PATTERN = /^artifact_[0-9a-f]{32}$/;

export function isCanonicalArtifactId(value) {
  return typeof value === 'string' && CANONICAL_ARTIFACT_ID_PATTERN.test(value);
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  fail('binary-id-bytes-required');
}

function exactArrayBuffer(value) {
  const bytes = bytesOf(value);
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
  const exact = new Uint8Array(bytes.byteLength);
  exact.set(bytes);
  return exact.buffer;
}

function hex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function createBinaryIdFromDigest(digest) {
  const normalized = nonEmpty(digest, 'binary-id-digest-required').toLowerCase().replace(/^sha256:/, '');
  if (normalized.length !== 64 || !HEX_RE.test(normalized)) fail('binary-id-invalid-sha256');
  return `bin_sha256_${normalized}`;
}

export async function createBinaryId(content) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail('binary-id-sha256-unavailable');
  const digest = await subtle.digest('SHA-256', exactArrayBuffer(content));
  return createBinaryIdFromDigest(hex(new Uint8Array(digest)));
}

export function createSliceId(input = {}) {
  const sourceRange = input.sourceRange == null ? null : input.sourceRange;
  if (sourceRange != null) validateCanonicalIdentityNumbers(sourceRange);
  const sourceRangeTypes = sourceRange == null ? null : lossyTypeWitness(sourceRange);
  return typedId('slice', {
    binaryId: nonEmpty(input.binaryId, 'slice-binary-id-required'),
    containerId: input.containerId == null ? null : nonEmpty(input.containerId, 'slice-container-id-invalid'),
    index: nonNegativeInteger(input.index, 0, 'slice-index-invalid'),
    architecture: input.architecture == null ? null : nonEmpty(input.architecture, 'slice-architecture-invalid'),
    sourceRange: sourceRange == null ? null : jsonSafe(sourceRange),
    ...(sourceRangeTypes ? { sourceRangeTypes } : {}),
  });
}

export function createImageId(input = {}) {
  return typedId('image', {
    binaryId: nonEmpty(input.binaryId, 'image-binary-id-required'),
    sliceId: input.sliceId == null ? null : nonEmpty(input.sliceId, 'image-slice-id-invalid'),
    loaderId: nonEmpty(input.loaderId ?? 'unknown', 'image-loader-id-required'),
    imageBase: input.imageBase == null ? null : canonicalAddress(input.imageBase),
  });
}

export function createArtifactId(input = {}) {
  return typedId('artifact', {
    binaryId: nonEmpty(input.binaryId, 'artifact-binary-id-required'),
    sliceId: input.sliceId == null ? null : nonEmpty(input.sliceId, 'artifact-slice-id-invalid'),
    loaderVersion: nonEmpty(input.loaderVersion, 'artifact-loader-version-required'),
    architectureSemanticVersion: nonEmpty(input.architectureSemanticVersion, 'artifact-architecture-semantic-version-required'),
    abiSemanticVersion: nonEmpty(input.abiSemanticVersion, 'artifact-abi-semantic-version-required'),
    semanticSchemaVersion: nonEmpty(input.semanticSchemaVersion, 'artifact-semantic-schema-version-required'),
    entityId: input.entityId == null ? null : nonEmpty(input.entityId, 'artifact-entity-id-invalid'),
    passId: nonEmpty(input.passId, 'artifact-pass-id-required'),
    passVersion: nonEmpty(input.passVersion ?? '1', 'artifact-pass-version-required'),
    optionsHash: input.optionsHash == null ? null : nonEmpty(input.optionsHash, 'artifact-options-hash-invalid'),
    inputArtifactIds: sortedStrings(input.inputArtifactIds, 'artifact-input-ids-invalid'),
  });
}

export function lossyTypeWitness(value, path = '', seen = new WeakSet(), out = []) {
  const type = typeof value;
  if (type === 'bigint') out.push([path, 'bigint']);
  else if (type === 'number') {
    if (Number.isNaN(value)) out.push([path, 'number:nan']);
    else if (value === Infinity) out.push([path, 'number:+infinity']);
    else if (value === -Infinity) out.push([path, 'number:-infinity']);
    else if (Object.is(value, -0)) out.push([path, 'number:-0']);
  } else if (type === 'undefined') out.push([path, 'undefined']);
  else if (type === 'function') out.push([path, 'function']);
  else if (type === 'symbol') out.push([path, 'symbol']);
  else if (value !== null && type === 'object') {
    if (seen.has(value)) return out.length ? out : null;
    seen.add(value);
    if (value instanceof Map) {
      out.push([path, 'map']);
      canonicalMapEntries(value, seen).forEach((entry, index) => {
        lossyTypeWitness(entry.key, `${path}.$map[${index}].<key>`, seen, out);
        lossyTypeWitness(entry.value, `${path}.$map[${index}].<val>`, seen, out);
      });
    } else if (value instanceof Set) {
      out.push([path, 'set']);
      canonicalSetEntries(value, seen).forEach((entry, index) => {
        lossyTypeWitness(entry.value, `${path}.$set[${index}]`, seen, out);
      });
    } else if (ArrayBuffer.isView(value)) out.push([path, 'bytes']);
    else if (value instanceof ArrayBuffer) out.push([path, 'bytes']);
    else if (value instanceof Date) out.push([path, 'date']);
    else if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const itemPath = `${path}[${index}]`;
        if (!Object.hasOwn(value, index)) out.push([itemPath, 'array-hole']);
        else lossyTypeWitness(value[index], itemPath, seen, out);
      }
    }
    else {
      rejectUnsupportedCanonicalObject(value);
      for (const key of Object.keys(value).sort()) lossyTypeWitness(value[key], `${path}.${key}`, seen, out);
    }
    seen.delete(value);
  }
  return path === '' ? (out.length ? out : null) : out;
}

export function createEntityId(input = {}) {
  const witness = lossyTypeWitness(input.identity);
  return typedId('entity', {
    binaryId: nonEmpty(input.binaryId, 'entity-binary-id-required'),
    sliceId: input.sliceId == null ? null : nonEmpty(input.sliceId, 'entity-slice-id-invalid'),
    kind: nonEmpty(input.kind, 'entity-kind-required'),
    identity: jsonSafe(input.identity),
    ...(witness ? { identityTypes: witness } : {}),
  });
}

export function createFunctionId(input = {}) {
  return typedId('function', {
    binaryId: nonEmpty(input.binaryId, 'function-binary-id-required'),
    sliceId: nonEmpty(input.sliceId, 'function-slice-id-required'),
    canonicalStartIdentity: normalizeIdentity(input.canonicalStartIdentity, 'function-start-identity-required'),
  });
}

export function createInstructionId(input = {}) {
  return typedId('instruction', {
    domain: 'native',
    binaryId: nonEmpty(input.binaryId, 'instruction-binary-id-required'),
    sliceId: nonEmpty(input.sliceId, 'instruction-slice-id-required'),
    virtualAddress: canonicalAddress(input.virtualAddress),
    decodeMode: nonEmpty(input.decodeMode ?? 'default', 'instruction-decode-mode-required'),
    decoderSemanticVersion: nonEmpty(input.decoderSemanticVersion, 'instruction-semantic-version-required'),
  });
}

export function createVmOperationId(input = {}) {
  return typedId('operation', {
    domain: 'vm',
    binaryId: nonEmpty(input.binaryId, 'operation-binary-id-required'),
    sliceId: input.sliceId == null ? null : nonEmpty(input.sliceId, 'operation-slice-id-invalid'),
    vm: nonEmpty(input.vm, 'operation-vm-required'),
    methodId: nonEmpty(input.methodId, 'operation-method-id-required'),
    operationOffset: normalizeIdentity(input.operationOffset, 'operation-offset-required'),
    semanticVersion: nonEmpty(input.semanticVersion, 'operation-semantic-version-required'),
  });
}

export function createBlockId(input = {}) {
  return typedId('block', {
    functionId: nonEmpty(input.functionId, 'block-function-id-required'),
    canonicalBlockIdentity: normalizeIdentity(input.canonicalBlockIdentity, 'block-canonical-identity-required'),
  });
}

export function createValueId(input = {}) {
  return typedId('value', {
    functionId: nonEmpty(input.functionId, 'value-function-id-required'),
    canonicalDefinitionIdentity: normalizeIdentity(input.canonicalDefinitionIdentity, 'value-definition-identity-required'),
  });
}

export function createMemoryRegionId(input = {}) {
  const functionId = input.functionId == null ? null : nonEmpty(input.functionId, 'memory-region-function-id-required');
  const binaryId = input.binaryId == null ? null : nonEmpty(input.binaryId, 'memory-region-binary-id-required');
  if (functionId == null && binaryId == null) fail('memory-region-scope-required');
  return typedId('memoryregion', {
    functionId,
    binaryId,
    regionKind: nonEmpty(input.regionKind, 'memory-region-kind-required'),
    canonicalRegionIdentity: normalizeIdentity(input.canonicalRegionIdentity, 'memory-region-identity-required'),
  });
}

export function createEvidenceId(input = {}) {
  const witness = lossyTypeWitness(input.identity);
  return typedId('evidence', {
    binaryId: input.binaryId == null ? null : nonEmpty(input.binaryId, 'evidence-binary-id-invalid'),
    kind: nonEmpty(input.kind ?? 'evidence', 'evidence-kind-required'),
    sourceId: input.sourceId == null ? null : nonEmpty(input.sourceId, 'evidence-source-id-invalid'),
    identity: jsonSafe(input.identity),
    ...(witness ? { identityTypes: witness } : {}),
  });
}

export function createRuntimeSessionId(input = {}) {
  return typedId('runtime', {
    binaryId: nonEmpty(input.binaryId, 'runtime-binary-id-required'),
    provider: nonEmpty(input.provider, 'runtime-provider-required'),
    targetIdentity: normalizeIdentity(input.targetIdentity, 'runtime-target-required'),
    sessionNonce: nonEmpty(input.sessionNonce ?? input.startedAt, 'runtime-session-nonce-required'),
  });
}

export function canonicalAddress(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('identity-unsafe-number-address');
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!text || !/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(text)) {
      fail('identity-invalid-address-string');
    }
    value = text;
  } else if (typeof value !== 'bigint') {
    fail('identity-invalid-address');
  }
  try {
    const n = typeof value === 'bigint' ? value : BigInt(value);
    if (n < 0n) fail('identity-negative-address');
    return `0x${n.toString(16)}`;
  } catch (error) {
    if (error instanceof TypeError && (error.message === 'identity-negative-address' || error.message === 'identity-unsafe-number-address' || error.message === 'identity-invalid-address-string')) throw error;
    fail('identity-invalid-address');
  }
}

export function validateCanonicalIdentityNumbers(value, seen = new WeakSet()) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('identity-non-finite-number');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) fail('identity-unsafe-number');
    return;
  }
  if (value == null || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (value instanceof Map) {
    for (const [k, v] of value.entries()) {
      validateCanonicalIdentityNumbers(k, seen);
      validateCanonicalIdentityNumbers(v, seen);
    }
  } else if (value instanceof Set) {
    for (const v of value.values()) {
      validateCanonicalIdentityNumbers(v, seen);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) validateCanonicalIdentityNumbers(item, seen);
  } else {
    rejectUnsupportedCanonicalObject(value);
    for (const key of Object.keys(value)) validateCanonicalIdentityNumbers(value[key], seen);
  }
  seen.delete(value);
}

export function normalizeIdentity(value, code) {
  if (value == null) fail(code);
  validateCanonicalIdentityNumbers(value);
  if (typeof value === 'bigint' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return nonEmpty(value, code);
  const witness = lossyTypeWitness(value);
  const normalized = jsonSafe(value);
  return witness ? { identity: normalized, identityTypes: witness } : normalized;
}

export function deepFreeze(value, seen = null) {
  if (!value || typeof value !== 'object') return value;
  if (Object.isFrozen(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  const active = seen ?? new WeakSet();
  if (active.has(value)) return value;
  active.add(value);
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) deepFreeze(value[keys[i]], active);
  const frozen = Object.freeze(value);
  return frozen;
}

export const IDENTITY_SCHEMA_VERSION = ID_SCHEMA_VERSION;
