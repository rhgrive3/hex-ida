/**
 * Symbol Demangler (C++ Itanium, Rust v0, Rust Legacy, Apple Swift) — WASM-first with 1:1 JS fallback.
 * INV-005 compliant: ZERO imports from js/targets/architecture/.
 * Uses dedicated demangler I/O buffers (never touches shared engine scratch or type arena).
 * Telemetry contract: recordWasmCall('symbol_demangle') / recordFallback('symbol_demangle:<reason>').
 */

import { getHexEngineExports, isWasmBulkMemorySupported } from '../../../core/hex-engine-wasm.js';
import { getEngineMode, recordWasmCall, recordFallback } from '../../../core/hex-engine-bridge.js';

export const DEMANGLE_KIND = Object.freeze({
  NONE: 0,
  ITANIUM_CPP: 1,
  RUST_V0: 2,
  RUST_LEGACY: 3,
  SWIFT: 4,
  MSVC_CPP: 5,
});

const DOMAIN = 'symbol_demangle';
const MAX_INPUT_BYTES = 2048;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

const RUST_LEGACY_HASH_RE = /17h[0-9a-f]{16}E$/;

export function detectMangleKind(name) {
  if (typeof name !== 'string' || name.length < 3) return DEMANGLE_KIND.NONE;
  if (name.startsWith('?') && name.length >= 4) return DEMANGLE_KIND.MSVC_CPP;
  if (
    name.startsWith('$s') || name.startsWith('$S') || name.startsWith('$e') ||
    name.startsWith('_$s') || name.startsWith('_$S') || name.startsWith('_$e') ||
    name.startsWith('_T0') || name.startsWith('__T0')
  ) {
    return DEMANGLE_KIND.SWIFT;
  }
  if (name.startsWith('_R') || name.startsWith('__R')) return DEMANGLE_KIND.RUST_V0;

  // Match C++ is_rust_legacy_symbol: after optional Darwin '_' strip, "_ZN" + non-empty path + "17h<16hex>E" (>= 24 chars)
  const stripped = name.startsWith('__ZN') ? name.slice(1) : name;
  if (stripped.startsWith('_ZN') && stripped.length >= 24 && RUST_LEGACY_HASH_RE.test(stripped)) {
    return DEMANGLE_KIND.RUST_LEGACY;
  }

  if (name.startsWith('_Z') || name.startsWith('__Z')) return DEMANGLE_KIND.ITANIUM_CPP;
  return DEMANGLE_KIND.NONE;
}

// ---------------------------------------------------------------------------
// JS Fallback Demangler (used when HEX_ENGINE=js or WASM export unavailable)
// ---------------------------------------------------------------------------
const RUST_LEGACY_ESCAPES = Object.freeze({
  LT: '<',
  GT: '>',
  C: ',',
  SP: '@',
  BP: '*',
  RF: '&',
  LP: '(',
  RP: ')',
  u20: ' ',
  u22: '"',
  u27: "'",
  u2b: '+',
  u3b: ';',
  u5b: '[',
  u5d: ']',
  u7b: '{',
  u7d: '}',
  u7e: '~',
  u21: '!',
  u3d: '=',
  u2d: '-',
  u2f: '/',
  u3a: ':',
});

const ITANIUM_PRIMITIVES = Object.freeze({
  v: 'void',
  b: 'bool',
  c: 'char',
  a: 'signed char',
  h: 'unsigned char',
  s: 'short',
  t: 'unsigned short',
  i: 'int',
  j: 'unsigned int',
  l: 'long',
  m: 'unsigned long',
  x: 'long long',
  y: 'unsigned long long',
  f: 'float',
  d: 'double',
  e: 'long double',
});

function decodeRustLegacyEscapes(raw) {
  const stripped = raw.replace(/::h[0-9a-f]{16}$/, '');
  return stripped
    .replace(/\.\./g, '::')
    .replace(/\$([A-Za-z0-9_]{1,8})\$/g, (m, tok) =>
      Object.prototype.hasOwnProperty.call(RUST_LEGACY_ESCAPES, tok) ? RUST_LEGACY_ESCAPES[tok] : m
    );
}

function demangleRustLegacyJs(sym) {
  const s = sym.startsWith('__Z') ? sym.slice(1) : sym;
  if (!s.startsWith('_ZN') || s.length < 24 || !s.endsWith('E')) return null;
  let i = 3;
  const parts = [];
  while (i < s.length - 1) {
    let n = 0;
    const startDigits = i;
    while (i < s.length - 1 && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) {
      n = n * 10 + (s.charCodeAt(i) - 48);
      i++;
    }
    if (i === startDigits || n <= 0 || i + n > s.length - 1) return null;
    parts.push(s.slice(i, i + n));
    i += n;
  }
  if (parts.length < 2) return null;
  return decodeRustLegacyEscapes(parts.join('::'));
}

function demangleRustV0Js(sym) {
  const s = sym.startsWith('__R') ? sym.slice(1) : sym;
  if (!s.startsWith('_R')) return null;
  let pos = 2;
  let depth = 0;

  const parseDecimal = () => {
    let n = 0;
    const start = pos;
    while (pos < s.length && s.charCodeAt(pos) >= 48 && s.charCodeAt(pos) <= 57) {
      n = n * 10 + (s.charCodeAt(pos) - 48);
      pos++;
    }
    return pos > start ? n : -1;
  };

  const parseDisambiguator = () => {
    if (pos < s.length && s[pos] === 's') {
      pos++;
      while (pos < s.length && s[pos] !== '_') pos++;
      if (pos < s.length && s[pos] === '_') pos++;
    }
  };

  const parseIdent = () => {
    parseDisambiguator();
    if (pos < s.length && s[pos] === 'u') pos++;
    const len = parseDecimal();
    if (len < 0) return null;
    if (pos < s.length && s[pos] === '_') pos++;
    if (pos + len > s.length) return null;
    const id = s.slice(pos, pos + len);
    pos += len;
    return id;
  };

  const parsePath = () => {
    if (++depth > 40 || pos >= s.length) return null;
    const tag = s[pos++];
    if (tag === 'C') {
      return parseIdent();
    }
    if (tag === 'N') {
      if (pos >= s.length) return null;
      pos++;
      const parent = parsePath();
      const ident = parseIdent();
      if (!parent || ident === null) return null;
      return ident ? `${parent}::${ident}` : parent;
    }
    return null;
  };

  const result = parsePath();
  return result || null;
}

function demangleItaniumBasicJs(sym) {
  const s = sym.startsWith('__Z') ? sym.slice(1) : sym;
  if (!s.startsWith('_Z')) return null;
  let pos = 2;
  let prefix = '';

  if (s.startsWith('_ZTV')) {
    prefix = 'vtable for ';
    pos = 4;
  } else if (s.startsWith('_ZTI')) {
    prefix = 'typeinfo for ';
    pos = 4;
  } else if (s.startsWith('_ZThn')) {
    pos = 5;
    while (pos < s.length && s[pos] !== '_') pos++;
    if (pos >= s.length) return null;
    pos++;
    prefix = 'non-virtual thunk to ';
  }

  const readLenIdent = () => {
    let n = 0;
    const start = pos;
    while (pos < s.length && s.charCodeAt(pos) >= 48 && s.charCodeAt(pos) <= 57) {
      n = n * 10 + (s.charCodeAt(pos) - 48);
      pos++;
    }
    if (pos === start || n <= 0 || pos + n > s.length) return null;
    const out = s.slice(pos, pos + n);
    pos += n;
    return out;
  };

  const parts = [];
  if (pos < s.length && s[pos] === 'N') {
    pos++;
    while (pos < s.length && s[pos] !== 'E') {
      if (s[pos] === 'K' || s[pos] === 'V' || s[pos] === 'R') {
        pos++;
        continue;
      }
      if (s[pos] === 'S' && pos + 1 < s.length && s[pos + 1] === 't') {
        parts.push('std');
        pos += 2;
        continue;
      }
      const id = readLenIdent();
      if (!id) return null;
      parts.push(id);
    }
    if (pos < s.length && s[pos] === 'E') pos++;
  } else {
    const id = readLenIdent();
    if (!id) return null;
    parts.push(id);
  }

  const baseName = `${prefix}${parts.join('::')}`;
  if (prefix.startsWith('vtable') || prefix.startsWith('typeinfo') || pos >= s.length) {
    return baseName;
  }

  const params = [];
  while (pos < s.length) {
    const ch = s[pos++];
    if (ch === 'v' && params.length === 0 && pos === s.length) break;
    if (Object.prototype.hasOwnProperty.call(ITANIUM_PRIMITIVES, ch)) {
      params.push(ITANIUM_PRIMITIVES[ch]);
    } else {
      return baseName;
    }
  }
  return `${baseName}(${params.join(', ')})`;
}

function demangleSwiftBasicJs(sym) {
  const s = sym.startsWith('_') ? sym.slice(1) : sym;
  const body = s.startsWith('$s') || s.startsWith('$S') || s.startsWith('$e')
    ? s.slice(2)
    : (s.startsWith('T0') ? s.slice(2) : null);
  if (!body) return null;
  let i = 0;
  const parts = [];
  while (i < body.length && parts.length < 16) {
    const m = /^(\d+)/.exec(body.slice(i));
    if (!m) break;
    const len = parseInt(m[1], 10);
    i += m[1].length;
    if (!Number.isFinite(len) || len <= 0 || len > 512 || i + len > body.length) return null;
    parts.push(body.slice(i, i + len));
    i += len;
    if (body[i] === 'C' || body[i] === 'V' || body[i] === 'O' || body[i] === 'P') i++;
  }
  if (parts.length === 0) return null;
  const tail = body.slice(i);
  const suffix = (tail.includes('Ya') ? ' async' : '') + (tail.includes('K') ? ' throws' : '');
  return parts.join('.') + suffix;
}

export function demangleSymbolJsFallback(name) {
  const kind = detectMangleKind(name);
  if (kind === DEMANGLE_KIND.NONE) return null;
  if (kind === DEMANGLE_KIND.SWIFT) return demangleSwiftBasicJs(name);
  if (kind === DEMANGLE_KIND.RUST_LEGACY) return demangleRustLegacyJs(name);
  if (kind === DEMANGLE_KIND.RUST_V0) return demangleRustV0Js(name);
  if (kind === DEMANGLE_KIND.ITANIUM_CPP) return demangleItaniumBasicJs(name);
  return null;
}

// ---------------------------------------------------------------------------
// Unified WASM-first Entry Point (Dedicated Fixed I/O Buffers — Zero Scratch Mutation)
// ---------------------------------------------------------------------------
export function demangleSymbol(name, opts = null) {
  if (typeof name !== 'string' || name.length < 3) return null;
  const kind = detectMangleKind(name);
  if (kind === DEMANGLE_KIND.NONE) return null;

  const mode = getEngineMode(opts);
  if (mode === 'js') {
    recordFallback(`${DOMAIN}:wasm_disabled`);
    return demangleSymbolJsFallback(name);
  }

  const ex = (opts && opts._wasmExports) || (isWasmBulkMemorySupported() ? getHexEngineExports(opts) : null);
  const hasDedicatedIo =
    ex &&
    ex.memory &&
    typeof ex.hex_demangle_symbol === 'function' &&
    typeof ex.hex_demangle_in_buf_ptr === 'function' &&
    typeof ex.hex_demangle_in_buf_cap === 'function' &&
    typeof ex.hex_demangle_out_buf_ptr === 'function' &&
    typeof ex.hex_demangle_out_buf_cap === 'function' &&
    typeof ex.hex_demangle_out_len_ptr === 'function';

  if (!hasDedicatedIo) {
    recordFallback(`${DOMAIN}:${isWasmBulkMemorySupported() ? 'exports_missing' : 'no_bulk_memory'}`);
    return demangleSymbolJsFallback(name);
  }

  const encoded = textEncoder.encode(name);
  const inCap = ex.hex_demangle_in_buf_cap() >>> 0;
  const maxIn = Math.min(inCap || MAX_INPUT_BYTES, MAX_INPUT_BYTES);
  if (encoded.length === 0 || encoded.length > maxIn) {
    recordFallback(`${DOMAIN}:input_too_large`);
    return null;
  }

  try {
    const inPtr = ex.hex_demangle_in_buf_ptr() >>> 0;
    const outPtr = ex.hex_demangle_out_buf_ptr() >>> 0;
    const outCap = ex.hex_demangle_out_buf_cap() >>> 0;
    const outLenPtr = ex.hex_demangle_out_len_ptr() >>> 0;
    if (!inPtr || !outPtr || !outLenPtr || outCap < 2) {
      recordFallback(`${DOMAIN}:oom`);
      return demangleSymbolJsFallback(name);
    }

    new Uint8Array(ex.memory.buffer).set(encoded, inPtr);
    const status = ex.hex_demangle_symbol(inPtr, encoded.length, outPtr, outCap, outLenPtr);

    if (status === 0) {
      const written = new DataView(ex.memory.buffer).getUint32(outLenPtr, true);
      if (written === 0 || written >= outCap) {
        recordFallback(`${DOMAIN}:invalid_arg`);
        return null;
      }
      recordWasmCall(DOMAIN);
      return textDecoder.decode(new Uint8Array(ex.memory.buffer, outPtr, written));
    }

    // Non-zero WASM status: always record telemetry (never silently fail)
    recordFallback(`${DOMAIN}:wasm_status_${status}`);
    if (status === 2) {
      const written = new DataView(ex.memory.buffer).getUint32(outLenPtr, true);
      if (written > 0 && written < outCap) {
        return textDecoder.decode(new Uint8Array(ex.memory.buffer, outPtr, written));
      }
    }
    return null;
  } catch {
    recordFallback(`${DOMAIN}:wasm_exception`);
    return demangleSymbolJsFallback(name);
  }
}
