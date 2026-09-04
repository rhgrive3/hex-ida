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
function decodePunycode(input) {
  const base = 36;
  const tmin = 1;
  const tmax = 26;
  const skew = 38;
  const damp = 700;
  const initialBias = 72;
  const initialN = 128;

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
    output.splice(i, 0, String.fromCodePoint(n));
    i++;
  }
  return output.join('');
}

/**
 * Parses a Rust v0 identifier (length-prefixed string, possibly with disambiguator).
 */
function parseV0Identifier(str, pos) {
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

  // Length integer
  const lenMatch = str.slice(p).match(/^(\d+)/);
  if (!lenMatch) return null;
  const len = Number(lenMatch[1]);
  p += lenMatch[1].length;
  if (p < str.length && str[p] === '_') {
    p++;
  }

  if (p + len > str.length) return null;
  const rawIdent = str.slice(p, p + len);
  let identifier = rawIdent;
  if (isUnicode) {
    try {
      const decoded = decodePunycode(rawIdent);
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
    const refState = { pos: br.value };
    return parseV0Const(str, refState, depth + 1);
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
  if (state.pos >= str.length || str[state.pos] !== '_') {
    return null;
  }
  state.pos++; // consume '_'
  if (hexStr === '') {
    return '0';
  }
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
    return c === 'R' ? `&${inner}` : `&mut ${inner}`;
  }
  if (c === 'P' || c === 'O') {
    state.pos++;
    const inner = parseV0Type(str, state, depth + 1);
    if (!inner) return null;
    return c === 'P' ? `*const ${inner}` : `*mut ${inner}`;
  }
  if (c === 'A') {
    state.pos++;
    const elemType = parseV0Type(str, state, depth + 1);
    if (!elemType) return null;
    const len = parseV0Const(str, state, depth + 1);
    if (len === null) return null;
    return `[${elemType}; ${len}]`;
  }
  if (c === 'B') {
    state.pos++;
    const br = parseV0Base62(str, state.pos);
    if (!br) return null;
    if (br.value < 0 || br.value >= state.pos - 1) return null;
    state.pos = br.nextPos;
    const refState = { pos: br.value };
    return parseV0Type(str, refState, depth + 1);
  }
  return parseV0Path(str, state, depth + 1);
}

function parseV0Path(str, state, depth = 0) {
  if (state.pos >= str.length) return null;
  if (depth > state.maxDepth) {
    state.depthExceeded = true;
    return null;
  }
  const tag = str[state.pos++];

  if (tag === 'C') {
    const ident = parseV0Identifier(str, state.pos);
    if (!ident) return null;
    state.pos = ident.nextPos;
    return ident.identifier;
  }

  if (tag === 'N') {
    if (state.pos >= str.length) return null;
    const ns = str[state.pos++]; // namespace character
    const parent = parseV0Path(str, state, depth + 1);
    if (!parent) return null;
    const ident = parseV0Identifier(str, state.pos);
    if (!ident) return parent;
    state.pos = ident.nextPos;
    let name = ident.identifier;
    if (!name) {
      if (ns === 'C') name = '{closure}';
      else if (ns === 'S') name = '{shim}';
      else name = `{${ns}}`;
    }
    return `${parent}::${name}`;
  }

  if (tag === 'M') {
    const implPath = parseV0Path(str, state, depth + 1);
    const typeName = parseV0Type(str, state, depth + 1);
    if (implPath && typeName) return `<${implPath}::${typeName}>`;
    return null;
  }

  if (tag === 'X') {
    const implPath = parseV0Path(str, state, depth + 1);
    const typeName = parseV0Type(str, state, depth + 1);
    const traitPath = parseV0Path(str, state, depth + 1);
    return `<${typeName || 'type'} as ${traitPath || 'trait'}>`;
  }

  if (tag === 'I') {
    const base = parseV0Path(str, state, depth + 1);
    if (!base) return null;
    const args = [];
    let gCount = 0;
    while (state.pos < str.length && str[state.pos] !== 'E' && gCount++ < 32) {
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
    return args.length > 0 ? `${base}<${args.join(', ')}>` : base;
  }

  if (tag === 'B') {
    const br = parseV0Base62(str, state.pos);
    if (!br) return null;
    if (br.value < 0 || br.value >= state.pos - 1) return null;
    state.pos = br.nextPos;
    const refState = { pos: br.value };
    return parseV0Path(str, refState, depth + 1);
  }

  const ident = parseV0Identifier(str, state.pos - 1);
  if (ident) {
    state.pos = ident.nextPos;
    return ident.identifier;
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
export function demangleRustV0(symbol, maxDepth = 32) {
  const s = String(symbol || '').replace(/^__?R/, '');
  if (!s || s === symbol) {
    return { original: symbol, demangled: symbol, parsed: false, reason: 'not-v0-symbol' };
  }

  const depthLimit = Number.isSafeInteger(maxDepth) && maxDepth >= 0 ? maxDepth : 32;
  const state = { pos: 0, maxDepth: depthLimit, depthExceeded: false };
  let demangled = null;

  try {
    demangled = parseV0Path(s, state, 0);
  } catch {
    return { original: symbol, demangled: symbol, parsed: false, reason: 'demangle-error' };
  }

  if (state.depthExceeded) {
    return { original: symbol, demangled: symbol, parsed: false, reason: 'v0-depth-limit-exceeded' };
  }

  if (!demangled) {
    return { original: symbol, demangled: symbol, parsed: false, reason: 'unrecognized-v0-structure' };
  }

  if (state.pos < s.length && !v0SuffixParses(s, state.pos, depthLimit)) {
    return { original: symbol, demangled: symbol, parsed: false, reason: 'unconsumed-v0-trailing-bytes' };
  }

  const components = demangled.split('::');
  return {
    original: symbol,
    demangled,
    parsed: true,
    components,
    crate: components[0] || null,
    generation: 'v0',
  };
}

/**
 * Checks the unconsumed remainder of a v0 symbol against the grammar suffix
 * productions: an optional instantiating crate path followed by an optional
 * vendor-specific suffix (`.` or `$...`). Anything else is not v0.
 */
function v0SuffixParses(s, pos, maxDepth) {
  if (pos >= s.length) return true;
  if (s[pos] === '.' || s[pos] === '$') return true;
  const state = { pos, maxDepth, depthExceeded: false };
  try {
    const crate = parseV0Path(s, state, 0);
    if (!crate || state.depthExceeded) return false;
    if (state.pos >= s.length) return true;
    return s[state.pos] === '.' || s[state.pos] === '$';
  } catch {
    return false;
  }
}

/**
 * Demangles a Rust legacy mangled symbol (starts with `_ZN...17h<16 hex digits>E`).
 */
export function demangleRustLegacy(symbol) {
  const original = String(symbol || '');
  const s = original.replace(/^_/, '');
  if (!s.startsWith('ZN')) {
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
export function demangleRustSymbol(symbol) {
  const text = String(symbol || '');
  if (text.startsWith('_R') || text.startsWith('__R')) {
    return demangleRustV0(text);
  }
  if (text.startsWith('_ZN') || text.startsWith('ZN')) {
    const leg = demangleRustLegacy(text);
    if (leg.parsed) return leg;
  }
  return { original: text, demangled: text, parsed: false, reason: 'not-rust-symbol' };
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
  }

  probe() {
    const rawSymbols = this.symbolsList == null ? [] : this.symbolsList;
    if (!Array.isArray(rawSymbols)) throw new TypeError('rust-metadata-symbols-must-be-array');
    const rustSymbols = [];
    const vtables = [];
    let unreadable = 0;
    let invalidEntries = 0;

    const isRustCandidateName = (name) =>
      typeof name === 'string' &&
      (name.startsWith('_R') || name.startsWith('__R') || name.startsWith('_ZN') || name.startsWith('ZN'));

    for (const sym of rawSymbols) {
      const name = sym.name || sym.symbol || String(sym);
      const dem = demangleRustSymbol(name);
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
          isVtable: dem.demangled.includes('::vtable') || dem.demangled.includes('vtable'),
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

    const complete = unreadable === 0 && invalidEntries === 0 && rustSymbols.length > 0;
    const identity = createLanguageMetadataIdentity({
      verdict: complete ? 'matched-authoritative' : 'matched-partial',
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
      detail: `Rust ${toolchainVersion || 'unknown'} (${rustSymbols.length} symbols)`,
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
