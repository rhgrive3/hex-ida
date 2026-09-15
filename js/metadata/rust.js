/**
 * HEX-C3-03 — Rust Language & Runtime Metadata Provider.
 *
 * Implements toolchain-aware Rust metadata extraction, v0 and legacy symbol
 * demangling, trait/vtable parsing, and type layout safety enforcement.
 *
 * Core Rust ABI & Layout Safety Rule:
 * Rust has NO stable ABI for `repr(Rust)` types. Struct field ordering in `repr(Rust)`
 * is compiler-version and target dependent. Only `repr(C)`, primitives, or DWARF-verified
 * types may be considered layout-stable.
 */

import {
  LanguageMetadataProvider,
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataPage,
  createLanguageMetadataResult,
} from './provider.js';

export const RUST_PROVIDER_ID = 'metadata.rust';
export const RUST_PROVIDER_VERSION = '1.0.0';

/**
 * Basic Rust v0 type codes (RFC 2603).
 */
const RUST_V0_BASIC_TYPES = Object.freeze({
  a: 'i8',
  b: 'bool',
  c: 'char',
  d: 'f64',
  e: 'str',
  f: 'f32',
  h: 'u8',
  i: 'isize',
  j: 'usize',
  l: 'i32',
  m: 'u32',
  n: 'i128',
  o: 'u128',
  p: '_',
  s: 'i16',
  t: 'u16',
  u: '()',
  v: '...',
  x: 'i64',
  y: 'u64',
  z: '!',
});

/** Rust v0 demangling resource ceilings (#8766, #8655). */
const RUST_V0_DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;
const RUST_V0_DEFAULT_MAX_OPS = 2_000_000;
const RUST_V0_DEFAULT_MAX_SCALARS = 8_192;
const RUST_V0_DEFAULT_MAX_ENCODED_BYTES = 65_536;
const RUST_V0_DEFAULT_MAX_SPLICE_WORK = 2_000_000;

function positiveBudget(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function createDemangleBudget(overrides = {}, ceilings = null) {
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const configured = {
    maxOutputChars: positiveBudget(o.maxOutputChars, RUST_V0_DEFAULT_MAX_OUTPUT_CHARS),
    maxOps: positiveBudget(o.maxOps, RUST_V0_DEFAULT_MAX_OPS),
    maxScalars: positiveBudget(o.maxScalars, RUST_V0_DEFAULT_MAX_SCALARS),
    maxEncodedBytes: positiveBudget(o.maxEncodedBytes, RUST_V0_DEFAULT_MAX_ENCODED_BYTES),
    maxSpliceWork: positiveBudget(o.maxSpliceWork, RUST_V0_DEFAULT_MAX_SPLICE_WORK),
  };
  const cap = (key) => {
    const ceiling = ceilings?.[key];
    return Number.isSafeInteger(ceiling) && ceiling >= 0
      ? Math.min(configured[key], ceiling)
      : configured[key];
  };
  return {
    ops: 0,
    outputChars: 0,
    scalars: 0,
    encodedBytes: 0,
    spliceWork: 0,
    maxOutputChars: cap('maxOutputChars'),
    maxOps: cap('maxOps'),
    maxScalars: cap('maxScalars'),
    maxEncodedBytes: cap('maxEncodedBytes'),
    maxSpliceWork: cap('maxSpliceWork'),
    exceeded: false,
  };
}

function v0ChargeOutput(state, length) {
  const b = state.budget;
  if (!Number.isSafeInteger(length) || length < 0 || length > b.maxOutputChars - b.outputChars) {
    b.exceeded = true;
    return false;
  }
  b.outputChars += length;
  return true;
}

function v0ChargeOp(state) {
  const b = state.budget;
  if (b.ops >= b.maxOps) {
    b.exceeded = true;
    return false;
  }
  b.ops += 1;
  return true;
}

function v0ChargePunycode(state, { encodedBytes = 0, scalars = 0, spliceWork = 0 } = {}) {
  if (!state || !state.budget) return true;
  const b = state.budget;
  if (![encodedBytes, scalars, spliceWork].every((value) => Number.isSafeInteger(value) && value >= 0)
      || encodedBytes > b.maxEncodedBytes - b.encodedBytes
      || scalars > b.maxScalars - b.scalars
      || spliceWork > b.maxSpliceWork - b.spliceWork) {
    b.exceeded = true;
    return false;
  }
  b.encodedBytes += encodedBytes;
  b.scalars += scalars;
  b.spliceWork += spliceWork;
  return true;
}

function v0ResolveBackref(str, state, kind, offset, depth) {
  const key = `${kind}:${offset}`;
  const hit = state.memo.get(key);
  if (hit && depth + 1 + hit.span <= state.maxDepth) {
    return v0ChargeOutput(state, hit.text.length) ? hit.text : null;
  }
  const childDepth = depth + 1;
  const refState = {
    pos: offset,
    maxDepth: state.maxDepth,
    depthExceeded: false,
    budget: state.budget,
    memo: state.memo,
    maxSeenDepth: childDepth,
  };
  const text = kind === 'type'
    ? parseV0Type(str, refState, childDepth)
    : kind === 'const'
      ? parseV0Const(str, refState, childDepth)
      : parseV0Path(str, refState, childDepth);
  if (refState.depthExceeded) state.depthExceeded = true;
  return text;
}

function v0MemoizeRender(state, kind, entryPos, depth, text) {
  if (!state.depthExceeded && !state.budget.exceeded) {
    state.memo.set(`${kind}:${entryPos}`, { text, span: Math.max(0, state.maxSeenDepth - depth) });
  }
  return text;
}

/** Charge an already materialized leaf render. */
function v0CacheRender(state, kind, entryPos, depth, text) {
  if (typeof text !== 'string') return text;
  if (!v0ChargeOutput(state, text.length)) return null;
  return v0MemoizeRender(state, kind, entryPos, depth, text);
}

/**
 * Reserve the exact output charge before allocating a composed render. This is
 * the hard pre-allocation gate for joins/templates: if the composition cannot
 * fit, its builder is never invoked (#8766 review blocker).
 */
function v0CacheComposedRender(state, kind, entryPos, depth, length, build) {
  if (!v0ChargeOutput(state, length)) return null;
  const text = build();
  if (typeof text !== 'string' || text.length !== length) {
    state.budget.exceeded = true;
    return null;
  }
  return v0MemoizeRender(state, kind, entryPos, depth, text);
}

/**
 * Parses a Rust v0 base-62 integer.
 */
function parseV0Base62(str, pos) {
  let val = 0;
  let i = pos;
  if (i < str.length && str[i] === '_') return { value: 0, nextPos: i + 1 };
  while (i < str.length) {
    const c = str.charCodeAt(i);
    let digit = -1;
    if (c >= 0x30 && c <= 0x39) digit = c - 0x30; // 0-9 -> 0-9
    else if (c >= 0x61 && c <= 0x7a) digit = c - 0x61 + 10; // a-z -> 10-35
    else if (c >= 0x41 && c <= 0x5a) digit = c - 0x41 + 36; // A-Z -> 36-61
    else if (c === 0x5f) { // '_' delimiter
      return { value: val + 1, nextPos: i + 1 };
    } else break;
    val = val * 62 + digit;
    i++;
  }
  return null;
}

/**
 * Decodes a Punycode string (RFC 3492) as used in Rust v0 mangling.
 * In Rust v0, the delimiter is '_' instead of '-'.
 */
function decodePunycode(input, state) {
  const base = 36;
  const tmin = 1;
  const tmax = 26;
  const skew = 38;
  const damp = 700;
  const initialBias = 72;
  const initialN = 128;

  if (!v0ChargePunycode(state, { encodedBytes: input.length })) return null;

  function adapt(delta, numpoints, firsttime) {
    let d = firsttime ? Math.floor(delta / damp) : Math.floor(delta / 2);
    d += Math.floor(d / numpoints);
    let k = 0;
    while (d > Math.floor(((base - tmin) * tmax) / 2)) {
      d = Math.floor(d / (base - tmin));
      k += base;
    }
    return k + Math.floor(((base - tmin + 1) * d) / (d + skew));
  }

  const output = [];
  let n = initialN;
  let i = 0;
  let bias = initialBias;

  const delimIndex = input.lastIndexOf('_');
  let pos = 0;
  if (delimIndex !== -1) {
    for (let j = 0; j < delimIndex; j++) {
      const code = input.charCodeAt(j);
      if (code >= 0x80) return null;
      output.push(String.fromCharCode(code));
    }
    pos = delimIndex + 1;
    if (!v0ChargePunycode(state, { scalars: output.length })) return null;
  }

  while (pos < input.length) {
    const oldi = i;
    let w = 1;
    let k = base;
    while (true) {
      if (pos >= input.length) return null;
      const c = input.charCodeAt(pos++);
      let digit = -1;
      if (c >= 0x30 && c <= 0x39) digit = c - 0x30 + 26;
      else if (c >= 0x61 && c <= 0x7a) digit = c - 0x61;
      else if (c >= 0x41 && c <= 0x5a) digit = c - 0x41;
      else return null;

      i += digit * w;
      const t = k <= bias ? tmin : k >= bias + tmax ? tmax : k - bias;
      if (digit < t) break;
      w *= (base - t);
      k += base;
    }
    const outLen = output.length + 1;
    bias = adapt(i - oldi, outLen, oldi === 0);
    n += Math.floor(i / outLen);
    if (n > 0x10ffff) return null;
    i = i % outLen;
    if (!v0ChargePunycode(state, { scalars: 1, spliceWork: outLen })) return null;
    output.splice(i, 0, String.fromCodePoint(n));
    i++;
  }
  return output.join('');
}

/**
 * Parses a Rust v0 identifier (length-prefixed string, possibly with disambiguator).
 */
function parseV0Identifier(str, pos, state) {
  let isDisambiguated = false;
  let p = pos;
  if (p < str.length && str[p] === 's') {
    isDisambiguated = true;
    p++;
    const dis = parseV0Base62(str, p);
    if (!dis) return null;
    p = dis.nextPos;
  }

  let isUnicode = false;
  if (p < str.length && str[p] === 'u') {
    isUnicode = true;
    p++;
  }

  /*
   * v0 decimal-number: the value zero is encoded as the single byte `0` and
   * must never be concatenated with a following digit (rustc v0 spec warns
   * about exactly this). `_RC03foo` is `C` + length 0 + trailing `3foo`, not
   * `C` + length 3 (#5875).
   */
  let len;
  if (p < str.length && str[p] === '0') {
    len = 0;
    p += 1;
  } else {
    const lenMatch = str.slice(p).match(/^[1-9][0-9]*/);
    if (!lenMatch) return null;
    len = Number(lenMatch[0]);
    p += lenMatch[0].length;
  }
  if (p < str.length && str[p] === '_') {
    p++;
  }

  if (p + len > str.length) return null;
  const rawIdent = str.slice(p, p + len);
  let identifier = rawIdent;
  if (isUnicode) {
    try {
      const decoded = decodePunycode(rawIdent, state);
      if (decoded === null) return null;
      identifier = decoded;
    } catch {
      return null;
    }
  }

  return {
    identifier,
    isDisambiguated,
    nextPos: p + len,
  };
}

/**
 * Parses a Rust v0 const value (`<type> <const-data> | p | <backref>`), where
 * `<const-data>` is `[n] <hex>* _` and `p` is a standalone placeholder.
 */
function parseV0Const(str, state, depth = 0) {
  if (state.pos >= str.length || depth > 32) return null;
  if (depth > state.maxSeenDepth) state.maxSeenDepth = depth;
  if (!v0ChargeOp(state)) return null;
  if (str[state.pos] === 'p') {
    state.pos++;
    return '_';
  }
  if (str[state.pos] === 'B') {
    state.pos++;
    const br = parseV0Base62(str, state.pos);
    if (!br) return null;
    if (br.value < 0 || br.value >= state.pos - 1) return null;
    state.pos = br.nextPos;
    return v0ResolveBackref(str, state, 'const', br.value, depth);
  }
  const constType = parseV0Type(str, state, depth + 1);
  if (!constType) return null;
  let isNegative = false;
  if (state.pos < str.length && str[state.pos] === 'n') {
    isNegative = true;
    state.pos++;
  }
  let hexStr = '';
  while (state.pos < str.length && /[0-9a-fA-F]/.test(str[state.pos])) {
    hexStr += str[state.pos++];
  }
  if (state.pos >= str.length || str[state.pos] !== '_') return null;
  state.pos++;
  if (hexStr === '') return '0';
  try {
    const val = BigInt('0x' + hexStr);
    return isNegative ? `-${val.toString()}` : val.toString();
  } catch {
    return null;
  }
}

function parseV0Type(str, state, depth = 0) {
  if (state.pos >= str.length) return null;
  if (depth > state.maxDepth) {
    state.depthExceeded = true;
    return null;
  }
  if (depth > state.maxSeenDepth) state.maxSeenDepth = depth;
  if (!v0ChargeOp(state)) return null;
  const entryPos = state.pos;
  const c = str[state.pos];
  if (RUST_V0_BASIC_TYPES[c]) {
    state.pos++;
    return RUST_V0_BASIC_TYPES[c];
  }
  if (c === 'R' || c === 'Q') {
    state.pos++;
    if (state.pos < str.length && str[state.pos] === 'L') {
      state.pos++;
      const lt = parseV0Base62(str, state.pos);
      if (!lt) return null;
      state.pos = lt.nextPos;
    }
    const inner = parseV0Type(str, state, depth + 1);
    if (!inner) return null;
    const prefix = c === 'R' ? '&' : '&mut ';
    return v0CacheComposedRender(state, 'type', entryPos, depth, prefix.length + inner.length, () => `${prefix}${inner}`);
  }
  if (c === 'P' || c === 'O') {
    state.pos++;
    const inner = parseV0Type(str, state, depth + 1);
    if (!inner) return null;
    const prefix = c === 'P' ? '*const ' : '*mut ';
    return v0CacheComposedRender(state, 'type', entryPos, depth, prefix.length + inner.length, () => `${prefix}${inner}`);
  }
  if (c === 'A') {
    state.pos++;
    const elemType = parseV0Type(str, state, depth + 1);
    if (!elemType) return null;
    const len = parseV0Const(str, state, depth + 1);
    if (len === null) return null;
    const renderLength = 1 + elemType.length + 2 + len.length + 1;
    return v0CacheComposedRender(state, 'type', entryPos, depth, renderLength, () => `[${elemType}; ${len}]`);
  }
  if (c === 'B') {
    state.pos++;
    const br = parseV0Base62(str, state.pos);
    if (!br) return null;
    if (br.value < 0 || br.value >= state.pos - 1) return null;
    state.pos = br.nextPos;
    return v0ResolveBackref(str, state, 'type', br.value, depth);
  }
  return parseV0Path(str, state, depth + 1);
}

/** Parse the Rust v0 `impl-path = disambiguator? path` production. */
function parseV0ImplPath(str, state, depth = 0) {
  if (state.pos < str.length && str[state.pos] === 's') {
    state.pos++;
    const dis = parseV0Base62(str, state.pos);
    if (!dis) return null;
    state.pos = dis.nextPos;
  }
  return parseV0Path(str, state, depth);
}

function parseV0Path(str, state, depth = 0) {
  if (state.pos >= str.length) return null;
  if (depth > state.maxDepth) {
    state.depthExceeded = true;
    return null;
  }
  if (depth > state.maxSeenDepth) state.maxSeenDepth = depth;
  if (!v0ChargeOp(state)) return null;
  const entryPos = state.pos;
  const tag = str[state.pos++];

  if (tag === 'C') {
    const ident = parseV0Identifier(str, state.pos, state);
    if (!ident) return null;
    state.pos = ident.nextPos;
    return v0CacheRender(state, 'path', entryPos, depth, ident.identifier);
  }

  if (tag === 'N') {
    if (state.pos >= str.length) return null;
    const ns = str[state.pos++];
    const parent = parseV0Path(str, state, depth + 1);
    if (!parent) return null;
    const ident = parseV0Identifier(str, state.pos, state);
    if (!ident) return null;
    state.pos = ident.nextPos;
    let name = ident.identifier;
    if (!name) {
      if (ns === 'C') name = '{closure}';
      else if (ns === 'S') name = '{shim}';
      else name = `{${ns}}`;
    }
    const renderLength = parent.length + 2 + name.length;
    return v0CacheComposedRender(state, 'path', entryPos, depth, renderLength, () => `${parent}::${name}`);
  }

  if (tag === 'M') {
    const implPath = parseV0ImplPath(str, state, depth + 1);
    const typeName = parseV0Type(str, state, depth + 1);
    if (!implPath || !typeName) return null;
    const renderLength = 1 + implPath.length + 2 + typeName.length + 1;
    return v0CacheComposedRender(state, 'path', entryPos, depth, renderLength, () => `<${implPath}::${typeName}>`);
  }

  if (tag === 'X') {
    const implPath = parseV0ImplPath(str, state, depth + 1);
    if (!implPath) return null;
    const typeName = parseV0Type(str, state, depth + 1);
    if (!typeName) return null;
    const traitPath = parseV0Path(str, state, depth + 1);
    if (!traitPath) return null;
    const renderLength = 1 + typeName.length + 4 + traitPath.length + 1;
    return v0CacheComposedRender(state, 'path', entryPos, depth, renderLength, () => `<${typeName} as ${traitPath}>`);
  }

  if (tag === 'I') {
    const base = parseV0Path(str, state, depth + 1);
    if (!base) return null;
    const args = [];
    let gCount = 0;
    while (state.pos < str.length && str[state.pos] !== 'E' && gCount++ < 32) {
      if (state.budget.exceeded) return null;
      if (str[state.pos] === 'L') {
        state.pos++;
        const lt = parseV0Base62(str, state.pos);
        if (!lt) return null;
        state.pos = lt.nextPos;
      } else if (str[state.pos] === 'K') {
        state.pos++;
        const c = parseV0Const(str, state, depth + 1);
        if (c === null) return null;
        args.push(c);
      } else {
        const t = parseV0Type(str, state, depth + 1);
        if (!t) return null;
        args.push(t);
      }
    }
    if (state.pos >= str.length || str[state.pos] !== 'E') return null;
    state.pos++;
    if (args.length === 0) return v0CacheRender(state, 'path', entryPos, depth, base);
    let argsLength = (args.length - 1) * 2;
    for (const arg of args) argsLength += arg.length;
    const renderLength = base.length + 1 + argsLength + 1;
    return v0CacheComposedRender(state, 'path', entryPos, depth, renderLength, () => `${base}<${args.join(', ')}>`);
  }

  if (tag === 'B') {
    const br = parseV0Base62(str, state.pos);
    if (!br) return null;
    if (br.value < 0 || br.value >= state.pos - 1) return null;
    state.pos = br.nextPos;
    return v0ResolveBackref(str, state, 'path', br.value, depth);
  }

  const ident = parseV0Identifier(str, state.pos - 1, state);
  if (ident) {
    state.pos = ident.nextPos;
    return v0CacheRender(state, 'path', entryPos, depth, ident.identifier);
  }

  return null;
}

/**
 * Demangles a Rust v0 mangled symbol (starts with `_R` or `__R`).
 *
 * A symbol is only `parsed: true` when the whole input is consumed by the v0
 * grammar: the leading path plus an optional instantiating crate path and an
 * optional vendor-specific suffix starting with `.` or `$`. Unrecognized
 * trailing bytes leave the symbol unparsed instead of silently succeeding.
 */
export function demangleRustV0(symbol, maxDepth = 32, budgetOverrides, budgetCeilings = null) {
  if (typeof symbol !== 'string') {
    return { original: symbol, demangled: '', parsed: false, reason: 'not-primitive-string' };
  }
  const s = symbol.replace(/^__?R/, '');
  if (!s || s === symbol) {
    return { original: symbol, demangled: symbol, parsed: false, reason: 'not-v0-symbol' };
  }

  const depthLimit = Number.isSafeInteger(maxDepth) && maxDepth >= 0 ? maxDepth : 32;
  const state = {
    pos: 0,
    maxDepth: depthLimit,
    depthExceeded: false,
    budget: createDemangleBudget(budgetOverrides, budgetCeilings),
    memo: new Map(),
    maxSeenDepth: 0,
  };
  const stats = () => ({
    ops: state.budget.ops,
    outputChars: state.budget.outputChars,
    scalars: state.budget.scalars,
    encodedBytes: state.budget.encodedBytes,
    spliceWork: state.budget.spliceWork,
  });
  let demangled = null;

  try {
    demangled = parseV0Path(s, state, 0);
  } catch {
    return { original: symbol, demangled: symbol, parsed: false, reason: 'demangle-error', stats: stats() };
  }

  if (state.budget.exceeded) {
    return { original: symbol, demangled: symbol, parsed: false, reason: 'v0-resource-budget-exceeded', resourceLimited: true, stats: stats() };
  }
  if (state.depthExceeded) {
    return { original: symbol, demangled: symbol, parsed: false, reason: 'v0-depth-limit-exceeded', stats: stats() };
  }
  if (!demangled) {
    return { original: symbol, demangled: symbol, parsed: false, reason: 'unrecognized-v0-structure', stats: stats() };
  }
  if (state.pos < s.length && !v0SuffixParses(s, state.pos, depthLimit, state.budget, state.memo)) {
    return {
      original: symbol,
      demangled: symbol,
      parsed: false,
      reason: state.budget.exceeded ? 'v0-resource-budget-exceeded' : 'unconsumed-v0-trailing-bytes',
      resourceLimited: state.budget.exceeded || undefined,
      stats: stats(),
    };
  }

  const components = demangled.split('::');
  return {
    original: symbol,
    demangled,
    parsed: true,
    components,
    crate: components[0] || null,
    generation: 'v0',
    stats: stats(),
  };
}

/** Checks an optional v0 instantiating-crate/vendor suffix. */
function v0SuffixParses(s, pos, maxDepth, budget, memo) {
  if (pos >= s.length) return true;
  if (s[pos] === '.' || s[pos] === '$') return true;
  const state = { pos, maxDepth, depthExceeded: false, budget, memo, maxSeenDepth: 0 };
  try {
    const crate = parseV0Path(s, state, 0);
    if (!crate || state.depthExceeded || budget.exceeded) return false;
    if (state.pos >= s.length) return true;
    return s[state.pos] === '.' || s[state.pos] === '$';
  } catch {
    return false;
  }
}

/** Normalize the canonical legacy prefix and its single Mach-O decoration. */
export function stripLegacyRustPrefix(text) {
  if (typeof text !== 'string') return null;
  if (text.startsWith('__ZN')) return text.slice(2);
  if (text.startsWith('_ZN')) return text.slice(1);
  if (text.startsWith('ZN')) return text;
  return null;
}

/** Recognize supported Rust symbol prefixes without coercing metadata. */
export function isRustCandidateSymbol(text) {
  if (typeof text !== 'string') return false;
  return text.startsWith('_R') || text.startsWith('__R') || stripLegacyRustPrefix(text) != null;
}

/**
 * Demangles a Rust legacy symbol, including the single Mach-O decoration.
 */
export function demangleRustLegacy(symbol) {
  const original = String(symbol || '');
  const s = stripLegacyRustPrefix(original);
  if (s == null) {
    return { original, demangled: original, parsed: false, reason: 'not-legacy-rust-symbol' };
  }

  const components = [];
  let i = 2;
  let hash = null;
  let terminated = false;

  while (i < s.length) {
    if (s[i] === 'E') {
      i++;
      terminated = true;
      break;
    }
    const match = s.slice(i).match(/^(\d+)/);
    if (!match) break;
    const len = Number(match[1]);
    i += match[1].length;
    if (i + len > s.length) break;

    const part = s.slice(i, i + len);
    i += len;

    // Check if this part is the trailing Rust hash (e.g. `17h<16 hex digits>`)
    const hashMatch = part.match(/^17h([0-9a-f]{16})$/i) || part.match(/^h([0-9a-f]{16})$/i);
    if (hashMatch) {
      hash = hashMatch[1];
    } else {
      // Decode $ characters
      const clean = part
        .replace(/\$SP\$/g, '@')
        .replace(/\$BP\$/g, '*')
        .replace(/\$RF\$/g, '&')
        .replace(/\$LT\$/g, '<')
        .replace(/\$GT\$/g, '>')
        .replace(/\$LP\$/g, '(')
        .replace(/\$RP\$/g, ')')
        .replace(/\$C\$/g, ',')
        .replace(/\$u20\$/g, ' ')
        .replace(/\$u27\$/g, "'");
      components.push(clean);
    }
  }

  if (!terminated || components.length === 0) {
    return { original, demangled: original, parsed: false, reason: 'unrecognized-legacy-structure' };
  }
  if (i !== s.length) {
    return { original, demangled: original, parsed: false, reason: 'unconsumed-legacy-trailing-bytes' };
  }

  const demangled = components.join('::');
  return {
    original,
    demangled,
    parsed: true,
    components,
    hash,
    crate: components[0] || null,
    generation: 'legacy',
  };
}

/**
 * Demangles any Rust symbol (v0 or legacy).
 */
export function demangleRustSymbol(symbol, budgetOverrides, budgetCeilings = null) {
  if (typeof symbol !== 'string') {
    return { original: symbol, demangled: '', parsed: false, reason: 'not-primitive-string' };
  }
  const text = symbol;
  if (text.startsWith('_R') || text.startsWith('__R')) {
    return demangleRustV0(text, 32, budgetOverrides, budgetCeilings);
  }
  if (stripLegacyRustPrefix(text) != null) {
    const leg = demangleRustLegacy(text);
    if (leg.parsed) return leg;
  }
  return { original: text, demangled: text, parsed: false, reason: 'not-rust-symbol' };
}

/**
 * Vtable authority is structural, not lexical (issue #5881).
 *
 * Rust v0/legacy mangling cannot distinguish a user function named `vtable`
 * (`_RNvC3foo6vtable` -> `foo::vtable`) from a compiler-generated vtable
 * static, and any demangled path merely *containing* "vtable"
 * (`foo::vtable_helper`) is an ordinary symbol. A name substring therefore
 * never promotes a symbol to vtable evidence: `isVtable` is accepted only as
 * explicit upstream structural evidence carried on the symbol record (for
 * example a symbol-table kind or a data-section classification). Symbols
 * without that evidence stay plain symbol evidence, which fails closed.
 */
export function isRustVtableSymbol(sym) {
  return sym?.isVtable === true || sym?.vtable === true;
}

/**
 * Searches a comment or note buffer for rustc compiler version.
 */
export function findRustcVersion(buffer) {
  if (!buffer || buffer.length === 0) return null;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(
    buffer.subarray(0, Math.min(buffer.length, 1024 * 1024))
  );
  const match = text.match(/\brustc version (1\.\d+\.\d+(?:-[a-zA-Z0-9_.-]+)?(?:\s*\([0-9a-f]+\s+\d{4}-\d{2}-\d{2}\))?)/i)
    || text.match(/\brustc\s+(1\.\d+\.\d+(?:-[a-zA-Z0-9_.-]+)?)/i);
  return match ? match[1] : null;
}

/**
 * Determines whether a Rust type layout is stable across compiler versions.
 * ONLY repr(C), primitives, or DWARF-verified types are layout-stable.
 */
export function isRustLayoutStable(typeDescriptor) {
  if (!typeDescriptor || typeof typeDescriptor !== 'object') return false;
  if (typeDescriptor.repr === 'C' || typeDescriptor.repr === 'transparent') return true;
  if (typeDescriptor.isPrimitive === true) return true;
  if (typeDescriptor.dwarfVerified === true) return true;
  // Standard repr(Rust) structs are explicitly NOT stable
  return false;
}

function normalizeRustAddress(value) {
  let parsed;
  if (typeof value === 'bigint') {
    if (value < 0n) throw new TypeError('rust-metadata-invalid-address');
    parsed = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('rust-metadata-invalid-address');
    parsed = BigInt(value);
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!/^(?:0[xX][0-9a-fA-F]+|\d+)$/.test(text)) throw new TypeError('rust-metadata-invalid-address');
    try { parsed = BigInt(text); } catch { throw new TypeError('rust-metadata-invalid-address'); }
  } else if (value == null) {
    return null;
  } else {
    throw new TypeError('rust-metadata-invalid-address');
  }
  return `0x${parsed.toString(16)}`;
}

/**
 * Rust Language & Runtime Metadata Provider.
 */
export class RustMetadataProvider extends LanguageMetadataProvider {
  constructor({
    symbols = [],
    commentBuffer = null,
    sections = [],
    binaryIdentity = null,
    architecture = 'x86_64',
    platform = 'linux',
    options = {},
  } = {}) {
    super({ id: RUST_PROVIDER_ID, version: RUST_PROVIDER_VERSION, ecosystem: 'rust' });
    this.symbolsList = symbols;
    this.commentBuffer = commentBuffer;
    this.sections = sections;
    this.binaryIdentity = binaryIdentity;
    this.architecture = architecture;
    this.platform = platform;
    this.options = options;
    this.cachedParsed = null;
    const dm = options && typeof options === 'object' && options.rustDemangle && typeof options.rustDemangle === 'object'
      ? options.rustDemangle
      : {};
    this.demangleBudget = {
      maxOutputChars: positiveBudget(dm.maxOutputChars, RUST_V0_DEFAULT_MAX_OUTPUT_CHARS),
      maxOps: positiveBudget(dm.maxOps, RUST_V0_DEFAULT_MAX_OPS),
      maxScalars: positiveBudget(dm.maxScalars, RUST_V0_DEFAULT_MAX_SCALARS),
      maxEncodedBytes: positiveBudget(dm.maxEncodedBytes, RUST_V0_DEFAULT_MAX_ENCODED_BYTES),
      maxSpliceWork: positiveBudget(dm.maxSpliceWork, RUST_V0_DEFAULT_MAX_SPLICE_WORK),
    };
    this.aggregateMax = {
      ops: positiveBudget(dm.aggregateMaxOps, RUST_V0_DEFAULT_MAX_OPS * 10),
      scalars: positiveBudget(dm.aggregateMaxScalars, RUST_V0_DEFAULT_MAX_SCALARS * 20),
      encodedBytes: positiveBudget(dm.aggregateMaxEncodedBytes, RUST_V0_DEFAULT_MAX_ENCODED_BYTES * 20),
      spliceWork: positiveBudget(dm.aggregateMaxSpliceWork, RUST_V0_DEFAULT_MAX_SPLICE_WORK * 10),
      outputChars: positiveBudget(dm.aggregateMaxOutputChars, RUST_V0_DEFAULT_MAX_OUTPUT_CHARS * 10),
    };
  }

  probe() {
    const rawSymbols = this.symbolsList == null ? [] : this.symbolsList;
    if (!Array.isArray(rawSymbols)) throw new TypeError('rust-metadata-symbols-must-be-array');
    const rustSymbols = [];
    const vtables = [];
    let unreadable = 0;
    let invalidEntries = 0;
    let resourceLimited = 0;

    const isRustCandidateName = isRustCandidateSymbol;
    const demangleCache = new Map();
    const perSymbol = this.demangleBudget;
    const aggMax = this.aggregateMax;
    const aggregate = { ops: 0, scalars: 0, encodedBytes: 0, spliceWork: 0, outputChars: 0 };
    const remainingAggregate = () => ({
      maxOps: Math.max(0, aggMax.ops - aggregate.ops),
      maxScalars: Math.max(0, aggMax.scalars - aggregate.scalars),
      maxEncodedBytes: Math.max(0, aggMax.encodedBytes - aggregate.encodedBytes),
      maxSpliceWork: Math.max(0, aggMax.spliceWork - aggregate.spliceWork),
      maxOutputChars: Math.max(0, aggMax.outputChars - aggregate.outputChars),
    });

    for (const sym of rawSymbols) {
      const name = typeof sym?.name === 'string' ? sym.name
        : typeof sym?.symbol === 'string' ? sym.symbol
        : null;
      if (name === null) {
        // Identity evidence must be primitive strings: a structured name can
        // never be laundered into canonical symbol evidence (#5375).
        invalidEntries++;
        continue;
      }
      let dem = demangleCache.get(name);
      if (dem === undefined) {
        dem = demangleRustSymbol(name, perSymbol, remainingAggregate());
        if (dem && dem.stats) {
          aggregate.ops += dem.stats.ops;
          aggregate.scalars += dem.stats.scalars;
          aggregate.encodedBytes += dem.stats.encodedBytes;
          aggregate.spliceWork += dem.stats.spliceWork;
          aggregate.outputChars += dem.stats.outputChars;
        }
        demangleCache.set(name, dem);
      }
      if (dem.resourceLimited && !dem.parsed && isRustCandidateName(name)) resourceLimited++;
      if (dem.parsed) {
        let address;
        try {
          address = normalizeRustAddress(sym.address ?? sym.addr ?? null);
        } catch {
          invalidEntries++;
          continue;
        }
        const normalized = {
          name: dem.demangled,
          original: dem.original,
          address,
          sizeBytes: sym.size ?? sym.sizeBytes ?? null,
          crate: dem.crate,
          generation: dem.generation,
          isVtable: isRustVtableSymbol(sym),
        };
        rustSymbols.push(normalized);
        if (normalized.isVtable) vtables.push(normalized);
      } else if (isRustCandidateName(dem.original)) {
        // A symbol the Rust grammar itself claims (v0 / legacy candidate prefix)
        // but the demangler cannot parse is an unreadable Rust record. Ordinary
        // C/C++ symbols are not Rust candidates and never count here.
        unreadable++;
      }
    }

    const toolchainVersion = findRustcVersion(this.commentBuffer);
    const hasEvidence = rustSymbols.length > 0 || toolchainVersion != null || unreadable > 0 || invalidEntries > 0;

    if (!hasEvidence) {
      return createLanguageMetadataResult({
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'rust',
        identity: createLanguageMetadataIdentity({
          verdict: 'identity-unavailable',
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'rust',
          binaryIdentity: this.binaryIdentity,
          architecture: this.architecture,
          platform: this.platform,
          method: 'rust-symbol-probe',
          detail: 'no rust symbols or compiler signatures found',
        }),
        sections: this.sections.map((s) => s.name || s.section || String(s)),
        completeness: { present: false, declared: 0, scanned: 0, parsed: 0, complete: true },
      });
    }

    this.cachedParsed = { rustSymbols, vtables };

    const complete = unreadable === 0 && invalidEntries === 0 && resourceLimited === 0 && rustSymbols.length > 0;
    const hasIdentityBinding = this.binaryIdentity != null;
    const identity = createLanguageMetadataIdentity({
      verdict: complete
        ? (hasIdentityBinding ? 'matched-authoritative' : 'identity-unavailable')
        : 'matched-partial',
      providerId: this.id,
      providerVersion: this.version,
      ecosystem: 'rust',
      toolchainVersion: toolchainVersion || 'rustc-unknown',
      binaryIdentity: this.binaryIdentity,
      expected: this.binaryIdentity,
      observed: this.binaryIdentity,
      architecture: this.architecture,
      platform: this.platform,
      method: 'rust-symbol-demangle',
      detail: hasIdentityBinding
        ? `Rust ${toolchainVersion || 'unknown'} (${rustSymbols.length} symbols)`
        : `Rust ${toolchainVersion || 'unknown'} without binary identity binding (${rustSymbols.length} symbols)`,
      coverage: complete ? null : {
        recordKinds: ['symbol', 'type'],
        addresses: rustSymbols.map((s) => s.address).filter((value) => value != null),
      },
    });

    return createLanguageMetadataResult({
      providerId: this.id,
      providerVersion: this.version,
      ecosystem: 'rust',
      identity,
      sections: this.sections.map((s) => s.name || s.section || String(s)),
      counts: {
        symbols: rustSymbols.length,
        vtables: vtables.length,
      },
      completeness: {
        present: true,
        declared: rawSymbols.length,
        scanned: rawSymbols.length,
        parsed: rustSymbols.length,
        complete,
        unreadableEntries: unreadable,
        capped: resourceLimited > 0,
        invalidEntries,
      },
    });
  }

  symbols() {
    if (!this.cachedParsed) {
      this.probe();
    }
    const symbols = this.cachedParsed?.rustSymbols || [];
    const records = symbols.map((sym) =>
      createLanguageMetadataRecord({
        kind: 'symbol',
        entityId: `sym@${sym.address ?? sym.name}`,
        name: sym.name,
        address: sym.address,
        sizeBytes: sym.sizeBytes,
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'rust',
        buildIdentity: this.binaryIdentity,
        descriptor: {
          isFunction: !sym.isVtable,
          crate: sym.crate,
          generation: sym.generation,
          originalMangled: sym.original,
        },
      })
    );
    return createLanguageMetadataPage({ records });
  }

  vtables() {
    if (!this.cachedParsed) {
      this.probe();
    }
    const vtables = this.cachedParsed?.vtables || [];
    const records = vtables.map((vt) =>
      createLanguageMetadataRecord({
        kind: 'vtable',
        entityId: `vtable@${vt.address ?? vt.name}`,
        name: vt.name,
        address: vt.address,
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'rust',
        buildIdentity: this.binaryIdentity,
        descriptor: { vtable: true },
      })
    );
    return createLanguageMetadataPage({ records });
  }
}
