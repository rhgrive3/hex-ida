/**
 * Symbol Demangler (C++ Itanium, Rust v0, Rust Legacy) — WASM-first with 1:1 JS fallback.
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
});

const DOMAIN = 'symbol_demangle';
const MAX_INPUT_BYTES = 2048;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

const RUST_LEGACY_HASH_RE = /17h[0-9a-f]{16}E$/;

export function detectMangleKind(name) {
  if (typeof name !== 'string' || name.length < 3) return DEMANGLE_KIND.NONE;
  if (
    name.startsWith('_$s') ||
    name.startsWith('$s') ||
    name.startsWith('_$S') ||
    name.startsWith('$S')
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


// ---------------------------------------------------------------------------
// Deterministic Swift 5 Demangler (DoS-hardened: bounded length, depth, steps)
// ---------------------------------------------------------------------------
const MAX_SWIFT_DEPTH = 32;
const MAX_SWIFT_STEPS = 512;

const SWIFT_STDLIB_TYPES = Object.freeze({
  i: 'Swift.Int',
  u: 'Swift.UInt',
  b: 'Swift.Bool',
  S: 'Swift.String',
  d: 'Swift.Double',
  f: 'Swift.Float',
  a: 'Swift.Array',
  D: 'Swift.Dictionary',
  q: 'Swift.Optional',
  p: 'Swift.UnsafeMutablePointer',
  P: 'Swift.UnsafePointer',
  v: 'Swift.UnsafeMutableRawPointer',
  V: 'Swift.UnsafeRawPointer',
});

const SWIFT_NOMINAL_TAGS = new Set(['V', 'C', 'O', 'P', 'a']);

function isAsciiDigit(code) {
  return code >= 48 && code <= 57;
}

function isValidSwiftIdent(ident) {
  if (!ident || ident.length === 0) return false;
  for (let i = 0; i < ident.length; i++) {
    const c = ident.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

function readSwiftLenIdent(s, pos) {
  if (pos >= s.length || !isAsciiDigit(s.charCodeAt(pos))) return null;
  let n = 0;
  let p = pos;
  while (p < s.length && isAsciiDigit(s.charCodeAt(p))) {
    n = n * 10 + (s.charCodeAt(p) - 48);
    if (n > MAX_INPUT_BYTES) return null;
    p++;
  }
  if (n <= 0 || p + n > s.length) return null;
  const text = s.slice(p, p + n);
  if (!isValidSwiftIdent(text)) return null;
  return { text, nextPos: p + n };
}

function parseSwiftTypeAt(s, pos, ctx, state, depth = 0) {
  if (depth > MAX_SWIFT_DEPTH || ++state.steps > MAX_SWIFT_STEPS || pos >= s.length) return null;

  let baseType = null;
  let nextPos = pos;
  const ch = s[pos];

  if (ch === 'y') {
    baseType = '()';
    nextPos = pos + 1;
  } else if (ch === 'S' && pos + 1 < s.length) {
    const c2 = s[pos + 1];
    if (Object.prototype.hasOwnProperty.call(SWIFT_STDLIB_TYPES, c2)) {
      baseType = SWIFT_STDLIB_TYPES[c2];
      nextPos = pos + 2;
      // Generic stdlib application: e.g. SaySiG -> Swift.Array<Swift.Int>, SDySSSiG -> Swift.Dictionary<Swift.String, Swift.Int>
      if ((c2 === 'a' || c2 === 'D' || c2 === 'q' || c2 === 'p' || c2 === 'P') && nextPos < s.length && s[nextPos] === 'y') {
        const genArgs = [];
        let gp = nextPos + 1;
        while (gp < s.length && s[gp] !== 'G') {
          if (++state.steps > MAX_SWIFT_STEPS) return null;
          const argRes = parseSwiftTypeAt(s, gp, ctx, state, depth + 1);
          if (!argRes) {
            genArgs.length = 0;
            break;
          }
          genArgs.push(argRes.type);
          gp = argRes.nextPos;
          if (gp < s.length && s[gp] === '_') gp++;
        }
        if (genArgs.length > 0 && gp < s.length && s[gp] === 'G') {
          baseType = `${baseType}<${genArgs.join(', ')}>`;
          nextPos = gp + 1;
        }
      }
    } else {
      return null;
    }
  } else if (ch === 'A' && pos + 1 < s.length) {
    const c2 = s[pos + 1];
    if (c2 === 'C' && ctx.currentType) {
      baseType = ctx.currentType;
      nextPos = pos + 2;
    } else if (c2 === 'A' && ctx.moduleName) {
      const idRes = readSwiftLenIdent(s, pos + 2);
      if (idRes && idRes.nextPos < s.length && SWIFT_NOMINAL_TAGS.has(s[idRes.nextPos])) {
        baseType = `${ctx.moduleName}.${idRes.text}`;
        nextPos = idRes.nextPos + 1;
      } else {
        baseType = ctx.moduleName;
        nextPos = pos + 2;
      }
    } else {
      return null;
    }
  } else if (ch === 's' && pos + 1 < s.length && isAsciiDigit(s.charCodeAt(pos + 1))) {
    const idRes = readSwiftLenIdent(s, pos + 1);
    if (!idRes) return null;
    let p = idRes.nextPos;
    if (p < s.length && SWIFT_NOMINAL_TAGS.has(s[p])) {
      p++;
      baseType = `Swift.${idRes.text}`;
      nextPos = p;
    } else {
      return null;
    }
  } else if (isAsciiDigit(s.charCodeAt(pos))) {
    const modRes = readSwiftLenIdent(s, pos);
    if (!modRes) return null;
    const typeRes = readSwiftLenIdent(s, modRes.nextPos);
    if (!typeRes || typeRes.nextPos >= s.length || !SWIFT_NOMINAL_TAGS.has(s[typeRes.nextPos])) {
      return null;
    }
    const parts = [modRes.text, typeRes.text];
    let p = typeRes.nextPos + 1;
    while (p < s.length && isAsciiDigit(s.charCodeAt(p))) {
      if (++state.steps > MAX_SWIFT_STEPS) return null;
      const nested = readSwiftLenIdent(s, p);
      if (!nested || nested.nextPos >= s.length || !SWIFT_NOMINAL_TAGS.has(s[nested.nextPos])) break;
      parts.push(nested.text);
      p = nested.nextPos + 1;
    }
    baseType = parts.join('.');
    nextPos = p;
  } else {
    return null;
  }

  // Postfix modifiers: Sg (Optional), z (inout)
  while (nextPos < s.length) {
    if (++state.steps > MAX_SWIFT_STEPS) return null;
    if (s[nextPos] === 'S' && nextPos + 1 < s.length && s[nextPos + 1] === 'g') {
      baseType = `Swift.Optional<${baseType}>`;
      nextPos += 2;
    } else if (s[nextPos] === 'z') {
      baseType = `inout ${baseType}`;
      nextPos += 1;
    } else {
      break;
    }
  }

  return { type: baseType, nextPos };
}

function expandSwiftShortRepeats(sig) {
  // Expand compact Swift stdlib repeats like S2i -> SiSi, S3S -> SSSSSS (bounded)
  let out = '';
  let i = 0;
  let steps = 0;
  while (i < sig.length) {
    if (++steps > MAX_SWIFT_STEPS || out.length > MAX_INPUT_BYTES) return null;
    if (
      sig[i] === 'S' &&
      i + 2 < sig.length &&
      sig.charCodeAt(i + 1) >= 50 &&
      sig.charCodeAt(i + 1) <= 57 &&
      Object.prototype.hasOwnProperty.call(SWIFT_STDLIB_TYPES, sig[i + 2])
    ) {
      const count = sig.charCodeAt(i + 1) - 48;
      const code = sig[i + 2];
      out += `S${code}`.repeat(count);
      i += 3;
    } else {
      out += sig[i++];
    }
  }
  return out;
}

function parseSwiftTypeSequence(s, startPos, ctx, state) {
  const types = [];
  let pos = startPos;
  while (pos < s.length) {
    if (++state.steps > MAX_SWIFT_STEPS) return null;
    if (s[pos] === '_' || s[pos] === 't') {
      pos++;
      continue;
    }
    const res = parseSwiftTypeAt(s, pos, ctx, state, 0);
    if (!res) return null;
    types.push(res.type);
    pos = res.nextPos;
  }
  return types;
}

function parseSwiftFuncSig(rawSig, ctx, state) {
  const expanded = expandSwiftShortRepeats(rawSig);
  if (expanded === null) return null;

  let sig = expanded;
  let isThrows = false;
  if (sig.endsWith('K')) {
    isThrows = true;
    sig = sig.slice(0, -1);
  }
  if (!sig) return null;

  const tryParseRetAndParams = (body, labels) => {
    const retRes = parseSwiftTypeAt(body, 0, ctx, state, 0);
    if (!retRes) return null;
    const rest = body.slice(retRes.nextPos);
    let params = [];
    if (rest === 'y') {
      params = [];
    } else if (rest.length > 0) {
      const seq = parseSwiftTypeSequence(rest, 0, ctx, state);
      if (!seq) return null;
      params = seq;
    } else {
      return null;
    }
    return { retType: retRes.type, params, labels, isThrows };
  };

  // Case 1: Explicit label list ending with '_' (e.g. 6amount_ySi, 1a1b_SiSi_t)
  if (isAsciiDigit(sig.charCodeAt(0))) {
    let lp = 0;
    const labels = [];
    let validLabels = true;
    while (lp < sig.length && sig[lp] !== '_') {
      if (++state.steps > MAX_SWIFT_STEPS) return null;
      const idRes = readSwiftLenIdent(sig, lp);
      if (!idRes) {
        validLabels = false;
        break;
      }
      labels.push(idRes.text);
      lp = idRes.nextPos;
    }
    if (validLabels && labels.length > 0 && lp < sig.length && sig[lp] === '_') {
      const parsed = tryParseRetAndParams(sig.slice(lp + 1), labels);
      if (parsed) return parsed;
    }
  }

  // Case 2: Empty label list marker 'y' followed by return type + params (e.g. yySi -> ret=(), param=Int)
  if (sig[0] === 'y' && sig.length >= 3) {
    const parsed = tryParseRetAndParams(sig.slice(1), []);
    if (parsed) return parsed;
  }

  // Case 3: No label list (e.g. yy -> () -> (), Siy -> () -> Int)
  return tryParseRetAndParams(sig, []);
}

function formatSwiftParams(params, labels) {
  if (!params || params.length === 0) return '';
  return params
    .map((ty, idx) => {
      const lbl = labels && idx < labels.length ? labels[idx] : null;
      return lbl ? `${lbl}: ${ty}` : ty;
    })
    .join(', ');
}

function demangleSwift5Js(sym) {
  if (typeof sym !== 'string' || sym.length < 3 || sym.length > MAX_INPUT_BYTES) return null;
  let s;
  if (sym.startsWith('_$s') || sym.startsWith('_$S')) {
    s = sym.slice(3);
  } else if (sym.startsWith('$s') || sym.startsWith('$S')) {
    s = sym.slice(2);
  } else {
    return null;
  }
  if (!s) return null;

  const state = { steps: 0 };
  let pos = 0;

  // 1. Parse module name
  let moduleName = null;
  if (s[pos] === 's' && pos + 1 < s.length && (isAsciiDigit(s.charCodeAt(pos + 1)) || SWIFT_NOMINAL_TAGS.has(s[pos + 1]))) {
    moduleName = 'Swift';
    pos += 1;
  } else if (s.startsWith('So') && s.length > 2) {
    moduleName = '__C';
    pos += 2;
  } else if (s.startsWith('SC') && s.length > 2) {
    moduleName = '__C_Synthesized';
    pos += 2;
  } else if (isAsciiDigit(s.charCodeAt(pos))) {
    const modRes = readSwiftLenIdent(s, pos);
    if (!modRes) return null;
    moduleName = modRes.text;
    pos = modRes.nextPos;
  } else {
    return null;
  }

  // 2. Parse nominal type chain and optional member name
  const path = [moduleName];
  let hasNominal = false;
  let memberName = null;

  while (pos < s.length) {
    if (++state.steps > MAX_SWIFT_STEPS) return null;
    if (!isAsciiDigit(s.charCodeAt(pos))) break;
    const idRes = readSwiftLenIdent(s, pos);
    if (!idRes) return null;
    const nextCh = idRes.nextPos < s.length ? s[idRes.nextPos] : '';
    if (SWIFT_NOMINAL_TAGS.has(nextCh)) {
      path.push(idRes.text);
      hasNominal = true;
      pos = idRes.nextPos + 1;
    } else {
      memberName = idRes.text;
      pos = idRes.nextPos;
      break;
    }
  }

  const baseName = path.join('.');
  const fullName = memberName ? `${baseName}.${memberName}` : baseName;
  const ctx = { moduleName, currentType: hasNominal ? baseName : null };
  const rest = s.slice(pos);

  // 3. Bare nominal type (e.g. _$s10Foundation4DataV -> Foundation.Data)
  if (rest.length === 0) {
    return hasNominal && !memberName ? baseName : null;
  }

  // 4. Type metadata / descriptor / witness table suffixes (no memberName)
  if (!memberName && hasNominal) {
    if (rest === 'Ma') return `type metadata accessor for ${baseName}`;
    if (rest === 'Mn') return `nominal type descriptor for ${baseName}`;
    if (rest === 'Ml') return `lazy protocol witness table accessor for ${baseName}`;
    if (rest === 'Mf') return `full type metadata for ${baseName}`;
    if (rest === 'N') return `type metadata for ${baseName}`;
    if (rest === 'WP') return `protocol witness table for ${baseName}`;
    if (rest === 'fd') return `${baseName}.deinit`;
    if (rest === 'fD') return `${baseName}.__deallocating_deinit`;

  }

  // 4a. Protocol conformance witness table / lazy accessor (handles both AA<Proto>PWP and <Mod><Proto>PWP)
  if (hasNominal && (rest.endsWith('WP') || rest.endsWith('Wl'))) {
    const isLazy = rest.endsWith('Wl');
    const protoPart = (memberName ? `${memberName.length}${memberName}` : '') + rest.slice(0, -2);
    const protoRes = parseSwiftTypeAt(protoPart, 0, ctx, state, 0);
    if (protoRes && protoRes.nextPos === protoPart.length) {
      const prefix = isLazy
        ? 'lazy protocol witness table accessor for'
        : 'protocol witness table for';
      return `${prefix} ${baseName} : ${protoRes.type}`;
    }
  }

  // 4b. Initializers: fC (allocating init) / fc (init), with or without argument labels
  if (hasNominal && (rest.endsWith('fC') || rest.endsWith('fc'))) {
    const isAlloc = rest.endsWith('fC');
    let initSig = (memberName ? `${memberName.length}${memberName}` : '') + rest.slice(0, -2);
    if (initSig.endsWith('c')) initSig = initSig.slice(0, -1);
    const parsed = initSig ? parseSwiftFuncSig(initSig, ctx, state) : null;
    const initName = isAlloc ? '__allocating_init' : 'init';
    if (parsed) {
      const paramsStr = formatSwiftParams(parsed.params, parsed.labels);
      const throwsStr = parsed.isThrows ? ' throws' : '';
      return `${baseName}.${initName}(${paramsStr})${throwsStr}`;
    }
    if (!initSig || initSig === 'ACy' || initSig === 'yACy') {
      return `${baseName}.${initName}()`;
    }
    return null;
  }

  // 5. Property / getter / setter / modify / materializeForSet
  if (memberName && rest.length >= 2) {
    const tail2 = rest.slice(-2);
    if (tail2 === 'vg' || tail2 === 'vs' || tail2 === 'vM' || tail2 === 'vm' || tail2 === 'vp') {
      const typePart = rest.slice(0, -2);
      if (!typePart) return null;
      const expandedType = expandSwiftShortRepeats(typePart);
      if (!expandedType) return null;
      const tyRes = parseSwiftTypeAt(expandedType, 0, ctx, state, 0);
      if (!tyRes || tyRes.nextPos !== expandedType.length) return null;
      if (tail2 === 'vg') return `${fullName}.getter : ${tyRes.type}`;
      if (tail2 === 'vs') return `${fullName}.setter : ${tyRes.type}`;
      if (tail2 === 'vM') return `${fullName}.modify : ${tyRes.type}`;
      if (tail2 === 'vm') return `${fullName}.materializeForSet : ${tyRes.type}`;
      return `${fullName} : ${tyRes.type}`;
    }
  }

  // 6. Functions & methods (F / FZ)
  if (memberName && (rest.endsWith('F') || rest.endsWith('FZ'))) {
    const isStatic = rest.endsWith('FZ');
    const sigPart = rest.slice(0, isStatic ? -2 : -1);
    const parsed = parseSwiftFuncSig(sigPart, ctx, state);
    if (!parsed) return null;
    const paramsStr = formatSwiftParams(parsed.params, parsed.labels);
    const throwsStr = parsed.isThrows ? ' throws' : '';
    const staticPrefix = isStatic ? 'static ' : '';
    return `${staticPrefix}${fullName}(${paramsStr})${throwsStr} -> ${parsed.retType}`;
  }

  return null;
}

export function demangleSymbolJsFallback(name) {
  const kind = detectMangleKind(name);
  if (kind === DEMANGLE_KIND.NONE) return null;
  if (kind === DEMANGLE_KIND.RUST_LEGACY) return demangleRustLegacyJs(name);
  if (kind === DEMANGLE_KIND.RUST_V0) return demangleRustV0Js(name);
  if (kind === DEMANGLE_KIND.ITANIUM_CPP) return demangleItaniumBasicJs(name);
  if (kind === DEMANGLE_KIND.SWIFT) return demangleSwift5Js(name);
  return null;
}

// ---------------------------------------------------------------------------
// Unified WASM-first Entry Point (Dedicated Fixed I/O Buffers — Zero Scratch Mutation)
// ---------------------------------------------------------------------------
export function demangleSymbol(name, opts = null) {
  if (typeof name !== 'string' || name.length < 3) return null;
  const kind = detectMangleKind(name);
  if (kind === DEMANGLE_KIND.NONE) return null;
  if (kind === DEMANGLE_KIND.SWIFT) {
    if (name.length > MAX_INPUT_BYTES) return null;
    return demangleSwift5Js(name);
  }

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
