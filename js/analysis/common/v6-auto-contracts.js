// Zero-dependency shared contracts for v6 background auto-analysis and beginner UX.
// Read-only single source of truth shared across analysis modules, beginner UI, and workbench wiring.

const HEX_VA_RE = /^0[xX][0-9a-fA-F]+$/;
const DEC_VA_RE = /^[0-9]+$/;
const STRIPPED_NAME_RE = /^(?:sub|FUN|func|fn|loc|unk)_[0-9a-fA-F]+$/;
const UNNAMED_NAME_RE = /^unnamed_/i;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const ENCODED_TRAVERSAL_RE = /%2e\.|\.%2e|%2e%2e|%5c/i;
const SCHEME_PREFIX_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HTTP_HOST_PREFIX_RE = /^https?:\/\/[^/]/i;
const WHITESPACE_RE = /\s/;

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Normalize a 64-bit virtual address into canonical lowercase hex (`"0x..."`).
 * Rejects negative numbers, unsafe integers, ambiguous non-0x hex strings, 0b/0o literals, and invalid types.
 * @param {bigint|number|string} va
 * @returns {string|null}
 */
export function normalizeVaHex(va) {
  if (typeof va === 'bigint') {
    return va >= 0n ? `0x${va.toString(16)}` : null;
  }
  if (typeof va === 'number') {
    if (!Number.isSafeInteger(va) || va < 0) return null;
    return `0x${BigInt(va).toString(16)}`;
  }
  if (typeof va === 'string') {
    const s = va.trim();
    if (!s) return null;
    if (!HEX_VA_RE.test(s) && !DEC_VA_RE.test(s)) return null;
    try {
      const b = BigInt(s);
      return b >= 0n ? `0x${b.toString(16)}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Safely convert a BigInt or numeric byte size to a non-negative safe integer.
 * @param {bigint|number|null|undefined} size
 * @param {number} [fallback=0]
 * @returns {number}
 */
export function toSafeByteSize(size, fallback = 0) {
  if (typeof size === 'bigint') {
    return size >= 0n && size <= MAX_SAFE_BIGINT ? Number(size) : fallback;
  }
  if (typeof size === 'number' && Number.isFinite(size) && size >= 0 && size <= Number.MAX_SAFE_INTEGER) {
    const floored = Math.floor(size);
    return Number.isSafeInteger(floored) ? floored : fallback;
  }
  return fallback;
}

/**
 * Determine whether a function name is missing or an auto-generated stripped placeholder.
 * Real symbols and user-assigned names return false.
 * @param {string|null|undefined} name
 * @returns {boolean}
 */
export function isStrippedFunctionName(name) {
  if (name == null || typeof name !== 'string') return true;
  const trimmed = name.trim();
  if (trimmed === '') return true;
  return STRIPPED_NAME_RE.test(trimmed) || UNNAMED_NAME_RE.test(trimmed);
}

/**
 * Validate that an asset/manifest/pack URL is safe (no whitespace, control chars,
 * path traversal, protocol-relative URLs, embedded credentials, or non-HTTP(S) schemes).
 * @param {string} url
 * @param {{ allowRelative?: boolean }} [opts]
 * @returns {boolean}
 */
export function isSafeAssetUrl(url, { allowRelative = true } = {}) {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (url !== url.trim() || WHITESPACE_RE.test(url)) return false;
  if (CONTROL_CHAR_RE.test(url)) return false;
  if (url.includes('\\') || url.includes('..') || ENCODED_TRAVERSAL_RE.test(url)) return false;
  if (url.startsWith('//')) return false;

  if (SCHEME_PREFIX_RE.test(url)) {
    if (!HTTP_HOST_PREFIX_RE.test(url)) return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      if (!parsed.hostname) return false;
      if (parsed.username !== '' || parsed.password !== '') return false;
      return true;
    } catch {
      return false;
    }
  }

  return allowRelative === true;
}

export const AUTO_ANALYSIS_STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  DONE: 'done',
  SKIPPED: 'skipped',
  OFFLINE: 'offline',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  MEMORY_LIMIT: 'memory_limit',
  UNSUPPORTED_ARCH: 'unsupported_arch',
  ABORTED: 'aborted',
  STALE: 'stale',
  ERROR: 'error',
});

export const PATCH_RISK_LEVEL = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  UNKNOWN: 'UNKNOWN',
});

export const GLOSSARY_KEYS = Object.freeze([
  'cff',
  'mba',
  'pac',
  'til',
  'hexsig',
  'demangle',
  'stripped',
  'xref',
  'cfg',
  'ssa',
  'stack_frame',
  'calling_convention',
  'prologue',
  'epilogue',
  'plt_got',
  'vtable',
  'stl_container',
  'syscall',
  'entrypoint',
  'branch',
  'register',
  'pointer',
  'patch',
  'decompile',
]);

const _glossaryKeySet = new Set(GLOSSARY_KEYS);

export const GLOSSARY_KEY_SET = Object.freeze({
  size: _glossaryKeySet.size,
  has(key) {
    return _glossaryKeySet.has(key);
  },
  [Symbol.iterator]() {
    return _glossaryKeySet[Symbol.iterator]();
  },
  values() {
    return _glossaryKeySet.values();
  },
  keys() {
    return _glossaryKeySet.keys();
  },
  entries() {
    return _glossaryKeySet.entries();
  },
  forEach(callback, thisArg) {
    _glossaryKeySet.forEach(callback, thisArg);
  },
});

function createReadOnlyKeySet(keys) {
  const keySet = new Set(keys);
  return Object.freeze({
    size: keySet.size,
    has(key) {
      return keySet.has(key);
    },
    [Symbol.iterator]() {
      return keySet[Symbol.iterator]();
    },
    values() {
      return keySet.values();
    },
    keys() {
      return keySet.keys();
    },
    entries() {
      return keySet.entries();
    },
    forEach(callback, thisArg) {
      keySet.forEach(callback, thisArg);
    },
  });
}

export const EXTENDED_GLOSSARY_KEYS = Object.freeze([
  'rtti',
  'typeinfo',
  'virtual_tree',
  'semantic_name',
  'primary_owner',
]);

export const EXTENDED_GLOSSARY_KEY_SET = createReadOnlyKeySet(EXTENDED_GLOSSARY_KEYS);

export const ALL_GLOSSARY_KEYS = Object.freeze([
  ...GLOSSARY_KEYS,
  ...EXTENDED_GLOSSARY_KEYS,
]);

export const ALL_GLOSSARY_KEY_SET = createReadOnlyKeySet(ALL_GLOSSARY_KEYS);

/**
 * Invoke an optional callback while isolating any thrown error.
 * @param {Function|null|undefined} fn
 * @param {...unknown} args
 * @returns {unknown}
 */
export function safeInvokeCallback(fn, ...args) {
  if (typeof fn !== 'function') return undefined;
  try {
    return fn(...args);
  } catch {
    return undefined;
  }
}
