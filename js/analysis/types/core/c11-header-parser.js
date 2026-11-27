/**
 * Error-Tolerant C11 / POSIX Header Parser & DeferredHeaderTypeTable.
 * Spec: hex_ida_beyond_ida_design.md §10.2, §18.3
 * Supports: typedef, struct, union, enum, bitfields, pointer/const/restrict qualifiers,
 * function prototypes, #define 64-bit integer constants, #pragma pack, #include/comment stripping,
 * forward-declaration fixup, recursion depth guards, and panic-mode recovery.
 * INV-005: ZERO imports from js/targets/architecture/.
 */

import {
  TIL_PRIM,
  TIL_NS,
  HEX_KIND,
  HEX_SCALAR_AUX,
  SIG_FLAG,
  TYPE_QUAL,
  CALL_CONV,
  makeHexTypeId,
} from './til-lite-data.js';

export const DEFAULT_ABI_ADAPTER = Object.freeze({
  ptrSize: 8,
  ptrAlign: 8,
  longSize: 8,
  longAlign: 8,
  longDoubleSize: 16,
  longDoubleAlign: 16,
});

export const PARSER_MAX_DEPTH = 64;

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

// Built-in C11/POSIX primitive & implicit standard types
const BUILTIN_PRIMITIVES = new Map([
  ['void', { tilId: TIL_PRIM.VOID, size: 0, align: 1, signed: false }],
  ['bool', { tilId: TIL_PRIM.BOOL, size: 1, align: 1, signed: false }],
  ['_Bool', { tilId: TIL_PRIM.BOOL, size: 1, align: 1, signed: false }],
  ['BOOL', { tilId: TIL_PRIM.BOOL, size: 1, align: 1, signed: false }],
  ['char', { tilId: TIL_PRIM.I8, size: 1, align: 1, signed: true }],
  ['signed char', { tilId: TIL_PRIM.I8, size: 1, align: 1, signed: true }],
  ['unsigned char', { tilId: TIL_PRIM.U8, size: 1, align: 1, signed: false }],
  ['int8_t', { tilId: TIL_PRIM.I8, size: 1, align: 1, signed: true }],
  ['uint8_t', { tilId: TIL_PRIM.U8, size: 1, align: 1, signed: false }],
  ['__int8', { tilId: TIL_PRIM.I8, size: 1, align: 1, signed: true }],
  ['short', { tilId: TIL_PRIM.I16, size: 2, align: 2, signed: true }],
  ['short int', { tilId: TIL_PRIM.I16, size: 2, align: 2, signed: true }],
  ['signed short', { tilId: TIL_PRIM.I16, size: 2, align: 2, signed: true }],
  ['unsigned short', { tilId: TIL_PRIM.U16, size: 2, align: 2, signed: false }],
  ['unsigned short int', { tilId: TIL_PRIM.U16, size: 2, align: 2, signed: false }],
  ['int16_t', { tilId: TIL_PRIM.I16, size: 2, align: 2, signed: true }],
  ['uint16_t', { tilId: TIL_PRIM.U16, size: 2, align: 2, signed: false }],
  ['__int16', { tilId: TIL_PRIM.I16, size: 2, align: 2, signed: true }],
  ['int', { tilId: TIL_PRIM.I32, size: 4, align: 4, signed: true }],
  ['signed', { tilId: TIL_PRIM.I32, size: 4, align: 4, signed: true }],
  ['signed int', { tilId: TIL_PRIM.I32, size: 4, align: 4, signed: true }],
  ['unsigned', { tilId: TIL_PRIM.U32, size: 4, align: 4, signed: false }],
  ['unsigned int', { tilId: TIL_PRIM.U32, size: 4, align: 4, signed: false }],
  ['int32_t', { tilId: TIL_PRIM.I32, size: 4, align: 4, signed: true }],
  ['uint32_t', { tilId: TIL_PRIM.U32, size: 4, align: 4, signed: false }],
  ['__int32', { tilId: TIL_PRIM.I32, size: 4, align: 4, signed: true }],
  ['wchar_t', { tilId: TIL_PRIM.I32, size: 4, align: 4, signed: true }],
  ['long', { tilId: TIL_PRIM.I64, size: 8, align: 8, signed: true }],
  ['long int', { tilId: TIL_PRIM.I64, size: 8, align: 8, signed: true }],
  ['signed long', { tilId: TIL_PRIM.I64, size: 8, align: 8, signed: true }],
  ['unsigned long', { tilId: TIL_PRIM.U64, size: 8, align: 8, signed: false }],
  ['unsigned long int', { tilId: TIL_PRIM.U64, size: 8, align: 8, signed: false }],
  ['long long', { tilId: TIL_PRIM.I64, size: 8, align: 8, signed: true }],
  ['long long int', { tilId: TIL_PRIM.I64, size: 8, align: 8, signed: true }],
  ['signed long long', { tilId: TIL_PRIM.I64, size: 8, align: 8, signed: true }],
  ['unsigned long long', { tilId: TIL_PRIM.U64, size: 8, align: 8, signed: false }],
  ['unsigned long long int', { tilId: TIL_PRIM.U64, size: 8, align: 8, signed: false }],
  ['int64_t', { tilId: TIL_PRIM.I64, size: 8, align: 8, signed: true }],
  ['uint64_t', { tilId: TIL_PRIM.U64, size: 8, align: 8, signed: false }],
  ['__int64', { tilId: TIL_PRIM.I64, size: 8, align: 8, signed: true }],
  ['size_t', { tilId: TIL_PRIM.U64, size: 8, align: 8, signed: false }],
  ['ssize_t', { tilId: TIL_PRIM.I64, size: 8, align: 8, signed: true }],
  ['ptrdiff_t', { tilId: TIL_PRIM.I64, size: 8, align: 8, signed: true }],
  ['intptr_t', { tilId: TIL_PRIM.I64, size: 8, align: 8, signed: true }],
  ['uintptr_t', { tilId: TIL_PRIM.U64, size: 8, align: 8, signed: false }],
  ['off_t', { tilId: TIL_PRIM.I64, size: 8, align: 8, signed: true }],
  ['time_t', { tilId: TIL_PRIM.I64, size: 8, align: 8, signed: true }],
  ['pid_t', { tilId: TIL_PRIM.I32, size: 4, align: 4, signed: true }],
  ['uid_t', { tilId: TIL_PRIM.U32, size: 4, align: 4, signed: false }],
  ['gid_t', { tilId: TIL_PRIM.U32, size: 4, align: 4, signed: false }],
  ['mode_t', { tilId: TIL_PRIM.U32, size: 4, align: 4, signed: false }],
  ['socklen_t', { tilId: TIL_PRIM.U32, size: 4, align: 4, signed: false }],
  ['__int128', { tilId: TIL_PRIM.I128, size: 16, align: 16, signed: true }],
  ['unsigned __int128', { tilId: TIL_PRIM.U128, size: 16, align: 16, signed: false }],
  ['_Float16', { tilId: TIL_PRIM.F16, size: 2, align: 2, signed: true }],
  ['float', { tilId: TIL_PRIM.F32, size: 4, align: 4, signed: true }],
  ['double', { tilId: TIL_PRIM.F64, size: 8, align: 8, signed: true }],
  ['long double', { tilId: TIL_PRIM.F64, size: 8, align: 8, signed: true }],
  ['id', { tilId: TIL_PRIM.OBJC_ID, size: 8, align: 8, signed: false }],
  ['SEL', { tilId: TIL_PRIM.OBJC_SEL, size: 8, align: 8, signed: false }],
  ['Class', { tilId: TIL_PRIM.OBJC_ID, size: 8, align: 8, signed: false }],
  ['NSInteger', { tilId: TIL_PRIM.I64, size: 8, align: 8, signed: true }],
  ['NSUInteger', { tilId: TIL_PRIM.U64, size: 8, align: 8, signed: false }],
  ['CGFloat', { tilId: TIL_PRIM.F64, size: 8, align: 8, signed: true }],
]);

// ---------------------------------------------------------------------------
// Safe 64-bit BigInt integer constant expression evaluator with recursion cap
// ---------------------------------------------------------------------------
export function evalIntExpr(exprStr, envMap, maxDepth = PARSER_MAX_DEPTH) {
  if (!exprStr || typeof exprStr !== 'string') return null;
  const tokens = [];
  let i = 0;
  const s = exprStr.trim();
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X')) {
      let j = i + 2;
      while (j < s.length && /[0-9a-fA-F_]/.test(s[j])) j++;
      const digits = s.slice(i + 2, j).replace(/_/g, '');
      if (!digits) return null;
      const num = BigInt('0x' + digits);
      while (j < s.length && /[uUlL]/.test(s[j])) j++;
      tokens.push({ type: 'num', value: num });
      i = j;
      continue;
    }
    if (ch === '0' && (s[i + 1] === 'b' || s[i + 1] === 'B')) {
      let j = i + 2;
      while (j < s.length && /[01_]/.test(s[j])) j++;
      const digits = s.slice(i + 2, j).replace(/_/g, '');
      if (!digits) return null;
      const num = BigInt('0b' + digits);
      while (j < s.length && /[uUlL]/.test(s[j])) j++;
      tokens.push({ type: 'num', value: num });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9]/.test(s[j])) j++;
      if (s[j] === '.' || s[j] === 'e' || s[j] === 'E') return null; // float, not int
      const raw = s.slice(i, j);
      const num = raw.length > 1 && raw[0] === '0' && /^[0-7]+$/.test(raw)
        ? BigInt('0o' + raw)
        : BigInt(raw);
      while (j < s.length && /[uUlL]/.test(s[j])) j++;
      tokens.push({ type: 'num', value: num });
      i = j;
      continue;
    }
    if (ch === "'" && i + 2 < s.length && s[i + 2] === "'") {
      tokens.push({ type: 'num', value: BigInt(s.charCodeAt(i + 1)) });
      i += 3;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      const ident = s.slice(i, j);
      if (envMap && envMap.has(ident)) {
        const v = envMap.get(ident);
        tokens.push({ type: 'num', value: typeof v === 'bigint' ? v : BigInt(v) });
      } else {
        return null;
      }
      i = j;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '<<' || two === '>>') {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if ('+-*/%&|^~()'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    return null;
  }
  if (tokens.length === 0) return null;

  let pos = 0;
  const peek = () => tokens[pos] || null;
  const consume = () => tokens[pos++];

  function parseBitOr(depth) {
    if (depth > maxDepth) throw new Error('expr max depth exceeded');
    let left = parseBitXor(depth);
    while (peek()?.value === '|') { consume(); left = left | parseBitXor(depth); }
    return left;
  }
  function parseBitXor(depth) {
    let left = parseBitAnd(depth);
    while (peek()?.value === '^') { consume(); left = left ^ parseBitAnd(depth); }
    return left;
  }
  function parseBitAnd(depth) {
    let left = parseShift(depth);
    while (peek()?.value === '&') { consume(); left = left & parseShift(depth); }
    return left;
  }
  function parseShift(depth) {
    let left = parseAdd(depth);
    while (peek()?.value === '<<' || peek()?.value === '>>') {
      const op = consume().value;
      const right = parseAdd(depth);
      if (right < 0n || right > 128n) throw new Error('shift out of range');
      left = op === '<<' ? (left << right) : (left >> right);
    }
    return left;
  }
  function parseAdd(depth) {
    let left = parseMul(depth);
    while (peek()?.value === '+' || peek()?.value === '-') {
      const op = consume().value;
      const right = parseMul(depth);
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  function parseMul(depth) {
    let left = parseUnary(depth);
    while (peek()?.value === '*' || peek()?.value === '/' || peek()?.value === '%') {
      const op = consume().value;
      const right = parseUnary(depth);
      if (op === '*') left *= right;
      else if (op === '/') left = right === 0n ? 0n : left / right;
      else left = right === 0n ? 0n : left % right;
    }
    return left;
  }
  function parseUnary(depth) {
    if (depth > maxDepth) throw new Error('expr max depth exceeded');
    const t = peek();
    if (!t) throw new Error('unexpected end');
    if (t.value === '+') { consume(); return parseUnary(depth + 1); }
    if (t.value === '-') { consume(); return -parseUnary(depth + 1); }
    if (t.value === '~') { consume(); return ~parseUnary(depth + 1); }
    if (t.value === '(') {
      consume();
      const v = parseBitOr(depth + 1);
      if (peek()?.value !== ')') throw new Error('unclosed paren');
      consume();
      return v;
    }
    if (t.type === 'num') { consume(); return t.value; }
    throw new Error('bad token');
  }

  try {
    const res = parseBitOr(0);
    if (pos !== tokens.length) return null;
    if (res >= MIN_SAFE_BIGINT && res <= MAX_SAFE_BIGINT) {
      return Number(res);
    }
    return res;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stage 1: Comment Stripping & Preprocessor Handling
// ---------------------------------------------------------------------------
export function preprocessC11Header(source) {
  const text = String(source || '').replace(/\r\n?/g, '\n');
  let stripped = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      stripped += ch;
      i++;
      while (i < n) {
        const c = text[i];
        stripped += c;
        i++;
        if (c === '\\' && i < n) {
          stripped += text[i];
          i++;
        } else if (c === quote) {
          break;
        }
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') stripped += '\n';
        i++;
      }
      i += 2;
      stripped += ' ';
      continue;
    }
    stripped += ch;
    i++;
  }

  const rawLines = stripped.split('\n');
  const defines = new Map();
  const includes = [];
  const outLines = [];

  for (let ln = 0; ln < rawLines.length; ln++) {
    let line = rawLines[ln];
    while (line.endsWith('\\') && ln + 1 < rawLines.length) {
      line = line.slice(0, -1) + ' ' + rawLines[++ln];
    }
    const trim = line.trim();
    if (!trim.startsWith('#')) {
      outLines.push(line);
      continue;
    }

    const incMatch = /^#\s*include\s*([<"])([^>"]+)[>"]/i.exec(trim);
    if (incMatch) {
      includes.push({ path: incMatch[2], system: incMatch[1] === '<', line: ln + 1 });
      outLines.push('');
      continue;
    }

    const defMatch = /^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*))?$/.exec(trim);
    if (defMatch && !/^#\s*define\s+[A-Za-z_][A-Za-z0-9_]*\(/.test(trim)) {
      const name = defMatch[1];
      const rhs = (defMatch[2] || '').trim();
      if (rhs) {
        const val = evalIntExpr(rhs, defines);
        if (val !== null) {
          defines.set(name, val);
        }
      }
      outLines.push('');
      continue;
    }

    const packMatch = /^#\s*pragma\s+pack\s*\(([^)]*)\)/.exec(trim);
    if (packMatch) {
      const arg = packMatch[1].trim();
      if (/^push\s*,\s*(\d+)$/.test(arg)) {
        const m = /^push\s*,\s*(\d+)$/.exec(arg);
        outLines.push(`__hex_pragma_pack_push__(${m[1]});`);
      } else if (arg === 'push') {
        outLines.push('__hex_pragma_pack_push__(0);');
      } else if (arg === 'pop') {
        outLines.push('__hex_pragma_pack_pop__();');
      } else if (/^\d+$/.test(arg)) {
        outLines.push(`__hex_pragma_pack__(${arg});`);
      } else if (arg === '') {
        outLines.push('__hex_pragma_pack__(0);');
      } else {
        outLines.push('');
      }
      continue;
    }

    outLines.push('');
  }

  return {
    code: outLines.join('\n'),
    defines,
    includes,
  };
}

// ---------------------------------------------------------------------------
// Stage 2: Tokenizer
// ---------------------------------------------------------------------------
function tokenizeC11(code) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const n = code.length;

  while (i < n) {
    const ch = code[i];
    if (ch === '\n') { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }

    if (ch === '"' || ch === "'") {
      const q = ch;
      let j = i + 1;
      while (j < n && code[j] !== q) {
        if (code[j] === '\\') j++;
        j++;
      }
      tokens.push({ type: 'str', value: code.slice(i, j + 1), line });
      i = j + 1;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i;
      if (ch === '0' && (code[j + 1] === 'x' || code[j + 1] === 'X' || code[j + 1] === 'b' || code[j + 1] === 'B')) {
        j += 2;
        while (j < n && /[0-9a-fA-F_]/.test(code[j])) j++;
      } else {
        while (j < n && /[0-9._eE]/.test(code[j])) j++;
      }
      while (j < n && /[uUlLfF]/.test(code[j])) j++;
      tokens.push({ type: 'num', value: code.slice(i, j), line });
      i = j;
      continue;
    }

    if (/[A-Za-z_$@]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(code[j])) j++;
      tokens.push({ type: 'ident', value: code.slice(i, j), line });
      i = j;
      continue;
    }

    if (ch === '.' && code[i + 1] === '.' && code[i + 2] === '.') {
      tokens.push({ type: 'punct', value: '...', line });
      i += 3;
      continue;
    }

    const two = code.slice(i, i + 2);
    if (two === '<<' || two === '>>' || two === '::' || two === '->') {
      tokens.push({ type: 'punct', value: two, line });
      i += 2;
      continue;
    }

    tokens.push({ type: 'punct', value: ch, line });
    i++;
  }
  return tokens;
}

const SKIP_QUALIFIERS = new Set([
  'volatile', 'restrict', '__restrict', '__restrict__',
  'inline', '__inline', '__inline__', '__forceinline',
  'static', 'extern', 'register', 'auto', '_Atomic',
  '__extension__', '__cdecl', '__stdcall', '__fastcall',
  '_Nullable', '_Nonnull', '_Null_unspecified', '__nullable', '__nonnull',
  '__kindof', 'API_AVAILABLE', 'NS_ASSUME_NONNULL_BEGIN', 'NS_ASSUME_NONNULL_END',
]);

const TYPE_SPEC_KEYWORDS = new Set([
  'void', 'bool', '_Bool', 'char', 'short', 'int', 'long',
  'signed', 'unsigned', 'float', 'double', '__int8', '__int16',
  '__int32', '__int64', '__int128', '_Float16',
]);

// ---------------------------------------------------------------------------
// Stage 3 & 4: Recursive-Descent Parser + 2-Pass Layout Calculation
// ---------------------------------------------------------------------------
export function parseLocalTypesHeader(source, options = {}) {
  const abi = { ...DEFAULT_ABI_ADAPTER, ...(options.abiAdapter || {}) };
  const maxDepth = options.maxDepth ?? PARSER_MAX_DEPTH;
  const { code, defines, includes } = preprocessC11Header(source);
  const tokens = tokenizeC11(code);

  const structs = new Map();
  const unions = new Map();
  const enums = new Map();
  const typedefs = new Map();
  const functions = [];
  const objcClasses = [];
  const diagnostics = [];

  const enumValueEnv = new Map(defines);
  const packStack = [0];
  let anonCounter = 0;
  let pos = 0;

  const peek = (offset = 0) => tokens[pos + offset] || null;
  const consume = () => tokens[pos++];
  const match = (val) => {
    if (peek()?.value === val) { pos++; return true; }
    return false;
  };
  const currentPack = () => packStack[packStack.length - 1] || 0;

  function skipBalanced(openCh, closeCh) {
    if (peek()?.value !== openCh) return;
    consume();
    let depth = 1;
    while (pos < tokens.length && depth > 0) {
      const v = consume().value;
      if (v === openCh) depth++;
      else if (v === closeCh) depth--;
    }
  }

  function skipAttributes() {
    while (pos < tokens.length) {
      const t = peek();
      if (!t) break;
      if (t.value === '__attribute__' || t.value === '__declspec' || t.value === '__asm__' || t.value === '__asm' || t.value === '_Alignas' || t.value === 'alignas') {
        consume();
        if (peek()?.value === '(') skipBalanced('(', ')');
        continue;
      }
      if (SKIP_QUALIFIERS.has(t.value)) {
        consume();
        if (t.value === 'API_AVAILABLE' && peek()?.value === '(') skipBalanced('(', ')');
        continue;
      }
      break;
    }
  }

  function panicRecover() {
    let braceDepth = 0;
    while (pos < tokens.length) {
      const v = consume().value;
      if (v === '{') braceDepth++;
      else if (v === '}') {
        if (braceDepth <= 0) break;
        braceDepth--;
      } else if (v === ';' && braceDepth === 0) {
        break;
      }
    }
  }

  function collectExprUntil(stopValues) {
    const parts = [];
    let parenDepth = 0;
    while (pos < tokens.length) {
      const t = peek();
      if (parenDepth === 0 && stopValues.has(t.value)) break;
      consume();
      if (t.value === '(') parenDepth++;
      else if (t.value === ')') parenDepth = Math.max(0, parenDepth - 1);
      parts.push(t.value);
    }
    return parts.join(' ');
  }

  function parseEnumSpecifier() {
    consume(); // 'enum'
    skipAttributes();
    let name = null;
    if (peek()?.type === 'ident') {
      name = consume().value;
    }
    skipAttributes();
    if (match(':')) {
      while (pos < tokens.length && peek()?.value !== '{' && peek()?.value !== ';') consume();
    }

    if (peek()?.value === '{') {
      consume(); // '{'
      const enumName = name || `__anon_enum_${++anonCounter}`;
      const items = [];
      let nextVal = 0n;
      while (pos < tokens.length && peek()?.value !== '}') {
        skipAttributes();
        if (peek()?.value === '}') break;
        const itemTok = consume();
        if (itemTok.type !== 'ident') {
          while (pos < tokens.length && peek()?.value !== ',' && peek()?.value !== '}') consume();
          match(',');
          continue;
        }
        let val = nextVal;
        if (match('=')) {
          const expr = collectExprUntil(new Set([',', '}']));
          const evaluated = evalIntExpr(expr, enumValueEnv, maxDepth);
          if (evaluated !== null) val = typeof evaluated === 'bigint' ? evaluated : BigInt(evaluated);
        }
        const jsVal = val >= MIN_SAFE_BIGINT && val <= MAX_SAFE_BIGINT ? Number(val) : val;
        items.push({ name: itemTok.value, value: jsVal });
        enumValueEnv.set(itemTok.value, jsVal);
        nextVal = val + 1n;
        match(',');
      }
      match('}');
      const nonZero = items.filter((it) => BigInt(it.value) > 0n);
      const isBitmask = nonZero.length >= 2 && nonZero.every((it) => {
        const b = BigInt(it.value);
        return (b & (b - 1n)) === 0n;
      });
      const def = { name: enumName, items, isBitmask, size: 4, align: 4 };
      enums.set(enumName, def);
      return { kind: 'enum', name: enumName, ptrDepth: 0, isConst: false };
    }
    return { kind: 'enum', name: name || 'int', ptrDepth: 0, isConst: false };
  }

  function parseStructOrUnionSpecifier(tagKind, depth = 0) {
    const startTok = consume(); // 'struct' or 'union'
    skipAttributes();
    let isPacked = false;
    let name = null;
    if (peek()?.type === 'ident') {
      name = consume().value;
    }
    skipAttributes();

    const targetMap = tagKind === 'union' ? unions : structs;
    if (peek()?.value === '{') {
      if (depth >= maxDepth) {
        diagnostics.push({
          line: startTok?.line || 0,
          message: `Maximum struct/union nesting depth (${maxDepth}) exceeded`,
        });
        skipBalanced('{', '}');
        return { kind: tagKind, name: name || `__overflow_${tagKind}_${++anonCounter}`, ptrDepth: 0, isConst: false };
      }

      consume(); // '{'
      const structName = name || `__anon_${tagKind}_${++anonCounter}`;
      const fields = [];
      while (pos < tokens.length && peek()?.value !== '}') {
        skipAttributes();
        if (peek()?.value === '}') break;
        if (peek()?.value === ';') { consume(); continue; }
        if (peek()?.value === '__hex_pragma_pack__' || peek()?.value === '__hex_pragma_pack_push__' || peek()?.value === '__hex_pragma_pack_pop__') {
          handlePragmaPackToken();
          continue;
        }

        const baseType = parseTypeSpecifier(depth + 1);
        if (!baseType) {
          panicRecover();
          continue;
        }

        if (peek()?.value === ';') {
          consume();
          fields.push({
            name: '',
            anonymous: true,
            type: baseType,
            arrayLen: null,
            bitWidth: null,
          });
          continue;
        }

        while (pos < tokens.length) {
          const decl = parseDeclarator(baseType, depth + 1);
          let bitWidth = null;
          if (match(':')) {
            const expr = collectExprUntil(new Set([',', ';']));
            const w = evalIntExpr(expr, enumValueEnv, maxDepth);
            bitWidth = w !== null ? Number(w) : 1;
          }
          fields.push({
            name: decl.name || '',
            anonymous: !decl.name,
            type: decl.type,
            arrayLen: decl.arrayLen,
            bitWidth,
          });
          if (!match(',')) break;
        }
        match(';');
      }
      match('}');

      if (peek()?.value === '__attribute__') {
        const start = pos;
        consume();
        if (peek()?.value === '(') {
          const attrStart = pos;
          skipBalanced('(', ')');
          const attrText = tokens.slice(attrStart, pos).map((t) => t.value).join('');
          if (attrText.includes('packed')) isPacked = true;
        } else {
          pos = start;
        }
      }

      const def = {
        kind: tagKind,
        name: structName,
        fields,
        pack: isPacked ? 1 : currentPack(),
        layoutState: 'defined',
        size: 0,
        align: 1,
        members: [],
      };
      targetMap.set(structName, def);
      return { kind: tagKind, name: structName, ptrDepth: 0, isConst: false };
    }

    if (name && !targetMap.has(name)) {
      targetMap.set(name, {
        kind: tagKind,
        name,
        fields: [],
        pack: currentPack(),
        layoutState: 'partial',
        size: 0,
        align: 1,
        members: [],
      });
    }
    return { kind: tagKind, name: name || 'void', ptrDepth: 0, isConst: false };
  }

  function parseTypeSpecifier(depth = 0) {
    skipAttributes();
    let isConst = false;
    const specWords = [];

    while (pos < tokens.length) {
      skipAttributes();
      const t = peek();
      if (!t) break;
      if (t.value === 'const' || t.value === '__const') {
        isConst = true;
        consume();
        continue;
      }
      if (t.value === 'struct' || t.value === 'union') {
        const res = parseStructOrUnionSpecifier(t.value, depth);
        res.isConst = res.isConst || isConst;
        return res;
      }
      if (t.value === 'enum') {
        const res = parseEnumSpecifier();
        res.isConst = res.isConst || isConst;
        return res;
      }
      if (TYPE_SPEC_KEYWORDS.has(t.value)) {
        specWords.push(consume().value);
        continue;
      }
      if (specWords.length === 0 && t.type === 'ident') {
        let name = consume().value;
        while (peek()?.value === '::' && peek(1)?.type === 'ident') {
          consume();
          name += '::' + consume().value;
        }
        if (peek()?.value === '<') {
          skipBalanced('<', '>');
        }
        return { kind: 'named', name, ptrDepth: 0, isConst };
      }
      break;
    }

    if (specWords.length > 0) {
      const joined = specWords.join(' ');
      return { kind: 'primitive', name: joined, ptrDepth: 0, isConst };
    }
    return null;
  }

  function parseDeclarator(baseType, depth = 0) {
    let ptrDepth = baseType.ptrDepth || 0;
    let isConst = Boolean(baseType.isConst);
    let isFuncPtr = false;
    let funcParams = null;

    while (pos < tokens.length) {
      skipAttributes();
      if (peek()?.value === '*') {
        consume();
        ptrDepth++;
        while (peek()?.value === 'const' || peek()?.value === 'volatile' || peek()?.value === 'restrict' || peek()?.value === '__restrict') {
          consume();
        }
        continue;
      }
      if (peek()?.value === 'const') {
        isConst = true;
        consume();
        continue;
      }
      break;
    }

    let name = '';
    if (peek()?.value === '(' && (peek(1)?.value === '*' || peek(1)?.value === '^')) {
      consume();
      consume();
      skipAttributes();
      if (peek()?.type === 'ident') {
        name = consume().value;
      }
      while (pos < tokens.length && peek()?.value !== ')') consume();
      match(')');
      isFuncPtr = true;
      if (peek()?.value === '(') {
        funcParams = parseParamList(depth + 1);
      }
    } else if (peek()?.type === 'ident') {
      name = consume().value;
    }

    let arrayLen = null;
    while (peek()?.value === '[') {
      consume();
      if (peek()?.value === ']') {
        consume();
        arrayLen = 0;
      } else {
        const expr = collectExprUntil(new Set([']']));
        match(']');
        const val = evalIntExpr(expr, enumValueEnv, maxDepth);
        const dim = val !== null && Number(val) > 0 ? Number(val) : 1;
        arrayLen = arrayLen === null ? dim : arrayLen * dim;
      }
    }

    const finalType = {
      ...baseType,
      ptrDepth: isFuncPtr ? Math.max(1, ptrDepth) : ptrDepth,
      isConst,
      isFuncPtr,
      funcParams,
    };
    return { name, type: finalType, arrayLen };
  }

  function parseParamList(depth = 0) {
    match('(');
    const params = [];
    let isVariadic = false;
    if (peek()?.value === ')') {
      consume();
      return { params, isVariadic };
    }
    if (peek()?.value === 'void' && peek(1)?.value === ')') {
      consume();
      consume();
      return { params, isVariadic };
    }

    while (pos < tokens.length && peek()?.value !== ')') {
      skipAttributes();
      if (peek()?.value === '...') {
        consume();
        isVariadic = true;
        match(',');
        continue;
      }
      const pBase = parseTypeSpecifier(depth);
      if (!pBase) {
        while (pos < tokens.length && peek()?.value !== ',' && peek()?.value !== ')') consume();
        match(',');
        continue;
      }
      const decl = parseDeclarator(pBase, depth);
      if (decl.arrayLen !== null) {
        decl.type = { ...decl.type, ptrDepth: decl.type.ptrDepth + 1 };
      }
      params.push({ name: decl.name || `arg${params.length}`, type: decl.type });
      if (!match(',')) break;
    }
    match(')');
    return { params, isVariadic };
  }

  function handlePragmaPackToken() {
    const cmd = consume().value;
    match('(');
    let val = 0;
    if (peek()?.type === 'num') {
      val = parseInt(consume().value, 10) || 0;
    }
    match(')');
    match(';');
    if (cmd === '__hex_pragma_pack_push__') {
      packStack.push(val || currentPack());
    } else if (cmd === '__hex_pragma_pack_pop__') {
      if (packStack.length > 1) packStack.pop();
    } else if (cmd === '__hex_pragma_pack__') {
      packStack[packStack.length - 1] = val;
    }
  }

  function parseObjcInterface() {
    consume();
    const name = peek()?.type === 'ident' ? consume().value : '';
    let superName = null;
    if (match(':')) {
      if (peek()?.type === 'ident') superName = consume().value;
    }
    if (peek()?.value === '(') skipBalanced('(', ')');
    if (peek()?.value === '<') skipBalanced('<', '>');
    if (peek()?.value === '{') skipBalanced('{', '}');

    const properties = [];
    const methods = [];
    while (pos < tokens.length && peek()?.value !== '@end') {
      const t = peek();
      if (t.value === '@property') {
        consume();
        if (peek()?.value === '(') skipBalanced('(', ')');
        const pType = parseTypeSpecifier(0);
        const decl = pType ? parseDeclarator(pType, 0) : { name: '', type: null };
        match(';');
        if (decl.name) properties.push({ name: decl.name, type: decl.type });
        continue;
      }
      if (t.value === '-' || t.value === '+') {
        const isClass = consume().value === '+';
        let retType = { kind: 'primitive', name: 'id', ptrDepth: 0, isConst: false };
        if (match('(')) {
          retType = parseTypeSpecifier(0) || retType;
          while (pos < tokens.length && peek()?.value !== ')') {
            if (peek()?.value === '*') retType.ptrDepth++;
            consume();
          }
          match(')');
        }
        let selector = '';
        const params = [];
        while (pos < tokens.length && peek()?.value !== ';') {
          if (peek()?.type === 'ident') {
            selector += consume().value;
            if (match(':')) {
              selector += ':';
              let pType = { kind: 'primitive', name: 'id', ptrDepth: 0, isConst: false };
              if (match('(')) {
                pType = parseTypeSpecifier(0) || pType;
                while (pos < tokens.length && peek()?.value !== ')') {
                  if (peek()?.value === '*') pType.ptrDepth++;
                  consume();
                }
                match(')');
              }
              const pName = peek()?.type === 'ident' ? consume().value : `arg${params.length}`;
              params.push({ name: pName, type: pType });
              continue;
            }
          } else {
            consume();
          }
        }
        match(';');
        if (selector) {
          methods.push({ isClass, selector, retType, params });
        }
        continue;
      }
      consume();
    }
    match('@end');
    if (name) objcClasses.push({ name, superName, properties, methods });
  }

  while (pos < tokens.length) {
    skipAttributes();
    const t = peek();
    if (!t) break;

    if (t.value === ';') { consume(); continue; }

    if (t.value === '__hex_pragma_pack__' || t.value === '__hex_pragma_pack_push__' || t.value === '__hex_pragma_pack_pop__') {
      handlePragmaPackToken();
      continue;
    }

    if (t.value === 'extern' && peek(1)?.type === 'str') {
      consume();
      consume();
      if (peek()?.value === '{') {
        consume();
        continue;
      }
      continue;
    }
    if (t.value === '}') {
      consume();
      continue;
    }

    if (t.value === 'namespace') {
      consume();
      if (peek()?.type === 'ident') consume();
      if (peek()?.value === '{') consume();
      continue;
    }

    if (t.value === '@interface') {
      parseObjcInterface();
      continue;
    }
    if (t.value.startsWith('@')) {
      consume();
      while (pos < tokens.length && peek()?.value !== ';' && peek()?.value !== '@end') consume();
      match(';');
      match('@end');
      continue;
    }

    if (t.value === 'typedef') {
      consume();
      const baseType = parseTypeSpecifier(0);
      if (!baseType) {
        diagnostics.push({ line: t.line, message: 'Malformed typedef base type' });
        panicRecover();
        continue;
      }
      while (pos < tokens.length) {
        const decl = parseDeclarator(baseType, 0);
        if (decl.name) {
          typedefs.set(decl.name, {
            ...decl.type,
            arrayLen: decl.arrayLen,
          });
        }
        if (!match(',')) break;
      }
      match(';');
      continue;
    }

    const startLine = t.line;
    const baseType = parseTypeSpecifier(0);
    if (!baseType) {
      diagnostics.push({ line: startLine, message: `Unexpected token '${t.value}'` });
      panicRecover();
      continue;
    }

    if (match(';')) {
      continue;
    }

    const decl = parseDeclarator(baseType, 0);
    if (peek()?.value === '(') {
      const { params, isVariadic } = parseParamList(0);
      skipAttributes();
      if (peek()?.value === '{') {
        skipBalanced('{', '}');
      } else {
        match(';');
      }
      if (decl.name) {
        functions.push({
          name: decl.name,
          retType: decl.type,
          params,
          isVariadic,
          line: startLine,
        });
      }
      continue;
    }

    if (!match(';')) {
      panicRecover();
    }
  }

  // -------------------------------------------------------------------------
  // Pass 2: Resolve typedefs & compute struct/union layouts (with bitfields)
  // -------------------------------------------------------------------------
  const resolvedLayoutCache = new Map();

  function resolveTypeSizeAlign(typeRef, visiting = new Set()) {
    if (!typeRef || visiting.size > maxDepth) return { size: abi.ptrSize, align: abi.ptrAlign };
    if (typeRef.ptrDepth > 0 || typeRef.isFuncPtr) {
      return { size: abi.ptrSize, align: abi.ptrAlign };
    }
    if (typeRef.kind === 'enum') {
      return { size: 4, align: 4 };
    }
    if (typeRef.kind === 'primitive') {
      const prim = BUILTIN_PRIMITIVES.get(typeRef.name);
      if (prim) return { size: prim.size, align: prim.align };
      return { size: 4, align: 4 };
    }
    if (typeRef.kind === 'struct' || typeRef.kind === 'union') {
      const key = `${typeRef.kind}:${typeRef.name}`;
      if (visiting.has(key)) return { size: 0, align: 1 };
      const def = typeRef.kind === 'union' ? unions.get(typeRef.name) : structs.get(typeRef.name);
      if (!def || def.layoutState === 'partial') return { size: 0, align: 1 };
      computeCompositeLayout(def, visiting);
      return { size: def.size, align: def.align };
    }
    if (typeRef.kind === 'named') {
      const prim = BUILTIN_PRIMITIVES.get(typeRef.name);
      if (prim) return { size: prim.size, align: prim.align };
      if (typedefs.has(typeRef.name) && !visiting.has(`td:${typeRef.name}`)) {
        const nextVisit = new Set(visiting);
        nextVisit.add(`td:${typeRef.name}`);
        const target = typedefs.get(typeRef.name);
        const res = resolveTypeSizeAlign(target, nextVisit);
        if (target.arrayLen && target.arrayLen > 0) {
          return { size: res.size * target.arrayLen, align: res.align };
        }
        return res;
      }
      if (structs.has(typeRef.name)) {
        return resolveTypeSizeAlign({ kind: 'struct', name: typeRef.name, ptrDepth: 0 }, visiting);
      }
      if (unions.has(typeRef.name)) {
        return resolveTypeSizeAlign({ kind: 'union', name: typeRef.name, ptrDepth: 0 }, visiting);
      }
      if (enums.has(typeRef.name)) {
        return { size: 4, align: 4 };
      }
    }
    return { size: abi.ptrSize, align: abi.ptrAlign };
  }

  function alignUp(offset, align) {
    if (align <= 1) return offset;
    return Math.ceil(offset / align) * align;
  }

  function computeCompositeLayout(def, visiting = new Set()) {
    const key = `${def.kind}:${def.name}`;
    if (resolvedLayoutCache.has(key)) return;
    if (visiting.has(key) || visiting.size > maxDepth) return;
    visiting.add(key);

    const members = [];
    const packLimit = def.pack > 0 ? def.pack : Infinity;
    let offset = 0;
    let maxAlign = 1;
    let maxUnionSize = 0;

    let bfActive = false;
    let bfUnitOffset = 0;
    let bfUnitSize = 0;
    let bfBitCursor = 0;

    for (const f of def.fields) {
      const { size: elemSize, align: rawAlign } = resolveTypeSizeAlign(f.type, visiting);
      const effAlign = Math.max(1, Math.min(rawAlign, packLimit));
      maxAlign = Math.max(maxAlign, effAlign);

      if (f.bitWidth !== null && f.bitWidth !== undefined) {
        const unitSize = Math.max(1, elemSize || 4);
        const unitBits = unitSize * 8;
        if (f.bitWidth === 0) {
          bfActive = false;
          offset = alignUp(offset, effAlign);
          continue;
        }
        if (def.kind === 'union') {
          members.push({
            name: f.name,
            offset: 0,
            size: unitSize,
            type: f.type,
            bfLsb: 0,
            bfWidth: f.bitWidth,
          });
          maxUnionSize = Math.max(maxUnionSize, unitSize);
          continue;
        }
        if (!bfActive || bfUnitSize !== unitSize || bfBitCursor + f.bitWidth > unitBits) {
          offset = alignUp(offset, effAlign);
          bfUnitOffset = offset;
          bfUnitSize = unitSize;
          bfBitCursor = 0;
          bfActive = true;
          offset += unitSize;
        }
        members.push({
          name: f.name,
          offset: bfUnitOffset,
          size: unitSize,
          type: f.type,
          bfLsb: bfBitCursor,
          bfWidth: f.bitWidth,
        });
        bfBitCursor += f.bitWidth;
        continue;
      }

      bfActive = false;

      const fieldSize = f.arrayLen === null
        ? elemSize
        : f.arrayLen === 0
          ? 0
          : elemSize * f.arrayLen;

      if (def.kind === 'union') {
        members.push({
          name: f.name,
          offset: 0,
          size: fieldSize,
          type: f.type,
          arrayLen: f.arrayLen,
          bfLsb: 0,
          bfWidth: 0,
        });
        maxUnionSize = Math.max(maxUnionSize, fieldSize);
      } else {
        offset = alignUp(offset, effAlign);
        members.push({
          name: f.name,
          offset,
          size: fieldSize,
          type: f.type,
          arrayLen: f.arrayLen,
          bfLsb: 0,
          bfWidth: 0,
        });
        offset += fieldSize;
      }
    }

    const totalRaw = def.kind === 'union' ? maxUnionSize : offset;
    def.align = maxAlign;
    def.size = alignUp(totalRaw, maxAlign);
    def.members = members;
    resolvedLayoutCache.set(key, true);
  }

  for (const def of structs.values()) {
    if (def.layoutState === 'defined') computeCompositeLayout(def);
  }
  for (const def of unions.values()) {
    if (def.layoutState === 'defined') computeCompositeLayout(def);
  }

  return {
    structs,
    unions,
    enums,
    typedefs,
    functions,
    objcClasses,
    defines,
    includes,
    diagnostics,
  };
}

export const parseC11Header = parseLocalTypesHeader;

// ---------------------------------------------------------------------------
// Convert Parsed Header -> TIL1 IR
// ---------------------------------------------------------------------------
export function compileParsedHeaderToIr(parsed, {
  packId = 'local-header',
  baseTid = TIL_NS.LOCAL_MIN,
  localTidRelative = false,
} = {}) {
  let nextTid = baseTid;
  const typeNameToTid = new Map();
  const types = [];
  const structLayouts = [];
  const enumDefs = [];

  function allocTid(name, desc) {
    if (typeNameToTid.has(name)) return typeNameToTid.get(name);
    const tid = nextTid++;
    typeNameToTid.set(name, tid);
    types.push({ tid, name, ...desc });
    return tid;
  }

  for (const [name, s] of parsed.structs.entries()) {
    allocTid(name, {
      kind: HEX_KIND.STRUCT,
      bits: Math.min(255, (s.size || 0) * 8),
      qualifiers: 0,
      pointeeTid: 0,
    });
  }
  for (const [name, u] of parsed.unions.entries()) {
    allocTid(name, {
      kind: HEX_KIND.UNION,
      bits: Math.min(255, (u.size || 0) * 8),
      qualifiers: 0,
      pointeeTid: 0,
    });
  }
  for (const [name, e] of parsed.enums.entries()) {
    const tid = allocTid(name, {
      kind: HEX_KIND.SCALAR,
      bits: 32,
      qualifiers: TYPE_QUAL.SIGNED | (e.isBitmask ? TYPE_QUAL.BITMASK : TYPE_QUAL.ENUM),
      pointeeTid: TIL_PRIM.I32,
    });
    enumDefs.push({ tid, name, isBitmask: e.isBitmask, items: e.items });
  }

  function typeRefToHexTypeId(typeRef, depth = 0) {
    if (!typeRef || depth > 12) return makeHexTypeId({ baseTilId: TIL_PRIM.VOID });
    const ptrDepth = typeRef.ptrDepth || 0;
    const isConst = Boolean(typeRef.isConst);
    if (typeRef.isFuncPtr) {
      return makeHexTypeId({ baseTilId: TIL_PRIM.VOID, ptrDepth: Math.max(1, ptrDepth), isConst, kindTag: HEX_KIND.FUNC_PTR });
    }
    if (typeRef.kind === 'primitive') {
      const prim = BUILTIN_PRIMITIVES.get(typeRef.name);
      return makeHexTypeId({ baseTilId: prim ? prim.tilId : TIL_PRIM.I32, ptrDepth, isConst });
    }
    if (typeRef.kind === 'struct' || typeRef.kind === 'union') {
      const tid = typeNameToTid.get(typeRef.name) ?? TIL_PRIM.VOID;
      const kindTag = typeRef.kind === 'union' ? HEX_KIND.UNION : HEX_KIND.STRUCT;
      return makeHexTypeId({ baseTilId: tid, ptrDepth, isConst, kindTag });
    }
    if (typeRef.kind === 'enum') {
      const tid = typeNameToTid.get(typeRef.name) ?? TIL_PRIM.I32;
      const e = parsed.enums.get(typeRef.name);
      const auxMeta = e?.isBitmask ? HEX_SCALAR_AUX.BITMASK : HEX_SCALAR_AUX.ENUM;
      return makeHexTypeId({ baseTilId: tid, ptrDepth, isConst, kindTag: HEX_KIND.SCALAR, auxMeta });
    }
    if (typeRef.kind === 'named') {
      const prim = BUILTIN_PRIMITIVES.get(typeRef.name);
      if (prim) return makeHexTypeId({ baseTilId: prim.tilId, ptrDepth, isConst });
      if (typeNameToTid.has(typeRef.name)) {
        const tid = typeNameToTid.get(typeRef.name);
        const kindTag = parsed.unions.has(typeRef.name)
          ? HEX_KIND.UNION
          : parsed.structs.has(typeRef.name)
            ? HEX_KIND.STRUCT
            : HEX_KIND.SCALAR;
        return makeHexTypeId({ baseTilId: tid, ptrDepth, isConst, kindTag });
      }
      if (parsed.typedefs.has(typeRef.name)) {
        const target = parsed.typedefs.get(typeRef.name);
        const merged = {
          ...target,
          ptrDepth: (target.ptrDepth || 0) + ptrDepth,
          isConst: Boolean(target.isConst || isConst),
        };
        return typeRefToHexTypeId(merged, depth + 1);
      }
    }
    return makeHexTypeId({ baseTilId: TIL_PRIM.VOID, ptrDepth, isConst });
  }

  for (const [name, td] of parsed.typedefs.entries()) {
    if (!typeNameToTid.has(name)) {
      const hex = typeRefToHexTypeId(td);
      allocTid(name, {
        kind: (hex >>> 21) & 0x07,
        bits: 64,
        qualifiers: td.isConst ? TYPE_QUAL.CONST : 0,
        pointeeTid: hex & 0xFFFF,
      });
    }
  }

  for (const [name, s] of parsed.structs.entries()) {
    if (s.layoutState !== 'defined') continue;
    const tid = typeNameToTid.get(name);
    structLayouts.push({
      tid,
      name,
      totalSize: s.size,
      members: s.members.map((m) => ({
        offset: m.offset,
        name: m.name,
        hexType: typeRefToHexTypeId(m.type),
        size: m.size,
        bfLsb: m.bfLsb || 0,
        bfWidth: m.bfWidth || 0,
      })),
    });
  }

  const functions = parsed.functions.map((f) => ({
    name: f.name,
    retHexType: typeRefToHexTypeId(f.retType),
    paramHexTypes: f.params.map((p) => typeRefToHexTypeId(p.type)),
    flags: f.isVariadic ? SIG_FLAG.VARIADIC : 0,
    fmtArgIdx: 0xFF,
    callConv: CALL_CONV.AAPCS64,
  }));

  const selectors = [];
  for (const cls of parsed.objcClasses) {
    for (const m of cls.methods) {
      const sign = m.isClass ? '+' : '-';
      const selfType = makeHexTypeId({ baseTilId: TIL_PRIM.OBJC_ID, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ });
      const selType = makeHexTypeId({ baseTilId: TIL_PRIM.OBJC_SEL });
      selectors.push({
        name: `${sign}${cls.name}:${m.selector}`,
        retHexType: typeRefToHexTypeId(m.retType),
        paramHexTypes: [selfType, selType, ...m.params.map((p) => typeRefToHexTypeId(p.type))],
        flags: m.isClass ? SIG_FLAG.OBJC_CLASS_METHOD : 0,
        fmtArgIdx: 0xFF,
        callConv: CALL_CONV.AAPCS64,
      });
    }
  }

  return {
    packId,
    isCore: false,
    localTidRelative,
    types,
    functions,
    selectors,
    enums: enumDefs,
    structLayouts,
  };
}

// ---------------------------------------------------------------------------
// §10.2 DeferredHeaderTypeTable (for large headers / il2cpp.h)
// ---------------------------------------------------------------------------
export class DeferredHeaderTypeTable {
  constructor(parsedHeader) {
    this.parsed = parsedHeader;
    this.ir = compileParsedHeaderToIr(parsedHeader, {
      packId: 'deferred-header',
      baseTid: TIL_NS.LOCAL_MIN,
      localTidRelative: false,
    });
    this.funcMap = new Map();
    for (const f of this.ir.functions) this.funcMap.set(f.name, f);
    this.typeMap = new Map();
    for (const t of this.ir.types) this.typeMap.set(t.name, t);
  }

  lookupFunction(name) {
    const f = this.funcMap.get(name);
    if (!f) return null;
    return {
      ...f,
      arity: f.paramHexTypes.length,
      formatFamily: (f.flags >>> 2) & 0x07,
      sigIndex: 0,
    };
  }

  lookupType(name) {
    return this.typeMap.get(name) || null;
  }

  selectForSlot3(symbolHints = new Set(), { maxTypes = 8192, maxFunctions = 4096 } = {}) {
    const hints = symbolHints instanceof Set ? symbolHints : new Set(symbolHints);
    const matchedFuncs = [];
    const restFuncs = [];
    for (const f of this.ir.functions) {
      if (hints.has(f.name) || hints.has(`_${f.name}`)) matchedFuncs.push(f);
      else restFuncs.push(f);
    }
    const selectedFuncs = [...matchedFuncs, ...restFuncs].slice(0, maxFunctions);
    const selectedTypes = this.ir.types.slice(0, maxTypes);
    return {
      ...this.ir,
      types: selectedTypes,
      functions: selectedFuncs,
    };
  }
}
