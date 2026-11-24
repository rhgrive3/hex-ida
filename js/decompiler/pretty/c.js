import { effectOf } from '../ast/nodes.js';

const PREC = { select: 2, oror: 3, '||': 3, andand: 4, '&&': 4, or: 5, '|': 5, xor: 6, '^': 6, and: 7, '&': 7, eq: 8, ne: 8, lt: 9, le: 9, gt: 9, ge: 9, shl: 10, lshr: 10, ashr: 10, shr: 10, add: 11, sub: 11, fadd: 11, fsub: 11, mul: 12, smull: 12, umull: 12, div: 12, fmul: 12, fdiv: 12, sdiv: 12, udiv: 12, mod: 12, rem: 12, smod: 12, umod: 12, srem: 12, urem: 12, unary: 13, primary: 15 };
const OP_TEXT = { add: '+', sub: '-', fadd: '+', fsub: '-', mul: '*', smull: '*', umull: '*', fmul: '*', and: '&', or: '|', xor: '^', andand: '&&', oror: '||', shl: '<<', lshr: '>>', ashr: '>>', shr: '>>', div: '/', fdiv: '/', sdiv: '/', udiv: '/', mod: '%', rem: '%', smod: '%', umod: '%', srem: '%', urem: '%', eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' };
const INTEGER_ONLY_BINARY_OPS = new Set([
  'and', 'or', 'xor',
  'shl', 'lshr', 'ashr', 'shr', 'ror',
  'mul', 'smull', 'umull', 'div', 'udiv', 'sdiv',
  'mod', 'rem', 'umod', 'smod', 'urem', 'srem',
]);

function hasPointerVarName(name, pointerVarNames) {
  if (!name || !pointerVarNames) return false;
  if (pointerVarNames instanceof Set) return pointerVarNames.has(name);
  if (Array.isArray(pointerVarNames)) return pointerVarNames.includes(name);
  return false;
}

export function exprIsPointerTyped(node, pointerVarNames, memo = new Map(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 128) return false;
  if (memo.has(node)) return memo.get(node);
  memo.set(node, false);
  let result = false;
  switch (node.kind) {
    case 'var': {
      if (node.stringLiteral === true || node.isPointer === true || node.type?.kind === 'pointer') {
        result = true;
      } else if (typeof node.name === 'string') {
        if (hasPointerVarName(node.name, pointerVarNames)) result = true;
        else if (node.name.startsWith('&')) result = true;
        else if (node.name.startsWith('"') && node.name.endsWith('"')) result = true;
        else if (/^\(\s*(?:const\s+|volatile\s+|struct\s+|union\s+|enum\s+)?[A-Za-z_][A-Za-z0-9_\s]*\*+\s*\)/.test(node.name)) result = true;
      }
      break;
    }
    case 'cast': {
      result = node.type?.kind === 'pointer'
        || (typeof node.type === 'string' && node.type.includes('*'))
        || (typeof node.cType === 'string' && node.cType.includes('*'));
      break;
    }
    case 'unary':
      result = node.op === 'addr' || node.op === 'addrof';
      break;
    case 'binary': {
      if (node.op === 'add') {
        const l = exprIsPointerTyped(node.left, pointerVarNames, memo, depth + 1);
        const r = exprIsPointerTyped(node.right, pointerVarNames, memo, depth + 1);
        result = l !== r;
      } else if (node.op === 'sub') {
        const l = exprIsPointerTyped(node.left, pointerVarNames, memo, depth + 1);
        const r = exprIsPointerTyped(node.right, pointerVarNames, memo, depth + 1);
        result = l && !r;
      }
      break;
    }
    case 'select':
      result = exprIsPointerTyped(node.whenTrue, pointerVarNames, memo, depth + 1)
        || exprIsPointerTyped(node.whenFalse, pointerVarNames, memo, depth + 1);
      break;
    default:
      result = node.isPointer === true || node.type?.kind === 'pointer';
      break;
  }
  memo.set(node, result);
  return result;
}

function printPointerAsUintptr(node, opts) {
  return `(uintptr_t)(${printExpression(node, 0, opts)})`;
}

export function integerText(v, bits = 64, signed = null) {
  const n = BigInt(v);
  const width = Math.max(1, Number(bits || 64));
  const sv = BigInt.asIntN(width, n);
  if (signed === true && sv >= -9n && sv <= 99n) return sv.toString();
  if (width <= 64) {
    if (n >= 0n && n <= 99n) return n.toString();
    if (sv < 0n && signed === true) return sv.toString();
    return `0x${BigInt.asUintN(width, n).toString(16).toUpperCase()}`;
  }

  // C has no portable integer-literal suffix for __int128.  Build the value
  // from 64-bit chunks so the printed program preserves every source bit.
  // A signed width below 128 must first be sign-extended into the 128-bit
  // pattern: zero-extending a negative width-bit value would print a positive
  // __int128 and silently lose the sign (#5249). Unsigned keeps zero
  // extension.
  const pattern = signed === true
    ? BigInt.asUintN(128, sv)
    : BigInt.asUintN(width, n);
  const lo = pattern & ((1n << 64n) - 1n);
  const hi = pattern >> 64n;
  const wide = `(((unsigned __int128)0x${hi.toString(16).toUpperCase()}ULL << 64) | 0x${lo.toString(16).toUpperCase()}ULL)`;
  return signed === true ? `((__int128)${wide})` : wide;
}

function floatText(value, bits = 64) {
  const n = Number(value);
  if (Number.isNaN(n)) return 'NAN';
  if (n === Infinity) return 'INFINITY';
  if (n === -Infinity) return '-INFINITY';
  let text = Object.is(n, -0) ? '-0.0' : String(n);
  if (!/[.eE]/.test(text)) text += '.0';
  return Number(bits || 64) <= 32 ? text + 'f' : text;
}

function wrap(text, p, parent) { return p < parent ? `(${text})` : text; }

function normalizedIntegerWidth(bits) {
  const width = Number(bits || 64);
  if (!Number.isFinite(width) || width <= 0) return 64;
  return Math.max(1, Math.min(128, Math.trunc(width)));
}

function exactUnsignedType(bits) {
  const width = normalizedIntegerWidth(bits);
  if (width <= 8) return 'uint8_t';
  if (width <= 16) return 'uint16_t';
  if (width <= 32) return 'uint32_t';
  if (width <= 64) return 'uint64_t';
  return 'unsigned __int128';
}

function exactSignedType(bits) {
  const width = normalizedIntegerWidth(bits);
  if (width <= 8) return 'int8_t';
  if (width <= 16) return 'int16_t';
  if (width <= 32) return 'int32_t';
  if (width <= 64) return 'int64_t';
  return '__int128';
}

function moduloArithmeticExpression(n, opts, parentPrec = 0) {
  if (!['add','sub','mul','shl'].includes(n.op)) return null;
  const bits = normalizedIntegerWidth(n.bits || n.left?.bits || n.right?.bits || 64);
  // Issue #969: machine add/sub/mul/shl wrap at the operation width. Plain C says
  // that only for unsigned types whose rank is not promoted away, so print the
  // wrapping view exactly where C would otherwise be undefined -- and nowhere else.
  const unsignedNaturalWidth = bits === 32 || bits === 64;
  if (n.signed !== true && n.op !== 'shl' && unsignedNaturalWidth) return null;
  // Arithmetic type: wide enough that integer promotion cannot reintroduce `int`.
  const arithmetic = bits <= 32 ? 'uint32_t' : bits <= 64 ? 'uint64_t' : 'unsigned __int128';
  const leftIsPtr = exprIsPointerTyped(n.left, opts?.pointerVarNames);
  const rightIsPtr = exprIsPointerTyped(n.right, opts?.pointerVarNames);
  const leftText = leftIsPtr ? printPointerAsUintptr(n.left, opts) : printExpression(n.left, PREC.unary, opts);
  const rightShlText = rightIsPtr ? printPointerAsUintptr(n.right, opts) : printExpression(n.right, PREC.shl + 1, opts);
  const rightBinText = rightIsPtr ? printPointerAsUintptr(n.right, opts) : printExpression(n.right, PREC.unary, opts);
  const raw = n.op === 'shl'
    ? `(${arithmetic})${leftText} << ${rightShlText}`
    : `(${arithmetic})${leftText} ${OP_TEXT[n.op]} (${arithmetic})${rightBinText}`;
  const exactWidth = bits === 32 || bits === 64 || bits === 8 || bits === 16 || bits === 128;
  const needsTruncation = !(exactWidth && arithmetic === exactUnsignedType(bits));
  const truncated = needsTruncation ? `(${exactUnsignedType(bits)})(${raw})` : `(${raw})`;
  if (n.signed === true) return wrap(`(${exactSignedType(bits)})${truncated}`, PREC.unary, parentPrec);
  return needsTruncation ? wrap(truncated, PREC.unary, parentPrec) : truncated;
}

// Machine integer division (AArch64 SDIV/UDIV and every other architecture
// that defines it) writes 0 when the divisor is 0. Plain C division by zero is
// undefined, so printing `/` changes the meaning; guard the divisor with a
// select that restores the architectural result (#4689). The constant-zero
// divisor is already folded by the truth evaluator and never reaches a
// printed division, so this guard only fires where the divisor is unknown.
function guardedDivision(n, opts, parentPrec = 0) {
  if (!['sdiv', 'udiv'].includes(n.op)) return null;
  const bits = normalizedIntegerWidth(n.bits || n.left?.bits || n.right?.bits || 64);
  const signed = n.op === 'sdiv' && n.compareSigned !== false ? true : false;
  // A divisor statically known to be 0 makes the whole quotient the
  // architectural 0; printing any division there would be UB-in-C.
  const divisor = n.right;
  if (divisor?.kind === 'const' && divisor.value === 0n) return '0';
  if (divisor?.kind === 'const') return null;
  const divType = signed ? exactSignedType(bits) : exactUnsignedType(bits);
  const matchesUnsignedVar = (node) => !signed && node?.kind === 'var'
    && node.bits != null && normalizedIntegerWidth(node.bits) === bits
    && node.signed === false;
  const leftIsPtr = exprIsPointerTyped(n.left, opts?.pointerVarNames);
  const rightIsPtr = exprIsPointerTyped(n.right, opts?.pointerVarNames);
  const castLeft = leftIsPtr
    ? `(${divType})${printPointerAsUintptr(n.left, opts)}`
    : ((hasIntegerView(n.left, bits, signed) || matchesUnsignedVar(n.left))
      ? printExpression(n.left, PREC.sdiv, opts)
      : `(${divType})${printExpression(n.left, PREC.unary, opts)}`);
  const rawRight = rightIsPtr ? printPointerAsUintptr(n.right, opts) : printExpression(n.right, PREC.unary, opts);
  const castRight = rightIsPtr
    ? `(${divType})${rawRight}`
    : ((hasIntegerView(n.right, bits, signed) || matchesUnsignedVar(n.right))
      ? printExpression(n.right, PREC.sdiv + 1, opts)
      : `(${divType})${rawRight}`);
  const divEffect = effectOf(divisor);
  if (divisor?.kind === 'call' || (divEffect !== 'pure' && divEffect !== 'read')) {
    return wrap(`(${divType})({ ${divType} __div = (${divType})${rawRight}; __div == 0 ? 0 : ${castLeft} / __div; })`, PREC.unary, parentPrec);
  }
  return wrap(`(${divType})(${castRight} == 0 ? 0 : ${castLeft} / ${castRight})`, PREC.unary, parentPrec);
}

function integerWidth(...nodes) {
  for (const n of nodes) {
    const bits = Number(n?.bits || 0);
    if (Number.isInteger(bits) && bits > 0) return bits;
  }
  return 64;
}

function hasIntegerView(n, bits, signed) {
  return Number(n?.bits || 0) === Number(bits) && n?.signed === signed;
}

function printIntegerView(n, bits, signed, parentPrec, opts, forceCast = false) {
  // Recovered AST signedness is the declaration/view contract available to the
  // C printer.  Omit a site cast only when it already proves the exact same
  // width and signedness; otherwise make the machine view explicit locally.
  if (hasIntegerView(n, bits, signed)) return printExpression(n, parentPrec, opts);
  if (n?.kind === 'const') {
    const valText = integerText(n.value, bits, signed);
    if (forceCast) {
      const type = signed ? exactSignedType(bits) : exactUnsignedType(bits);
      return wrap(`(${type})${valText}`, PREC.unary, parentPrec);
    }
    return valText;
  }
  const text = printExpression(n, PREC.unary, opts);
  // A literal already states its own value; a cast on it adds no signedness
  // information and only costs readability (#861/#862 need the *variable* view).
  if (!forceCast && /^-?(?:0[xX][0-9A-Fa-f]+|\d+)$/.test(text)) return text;
  const type = signed ? exactSignedType(bits) : exactUnsignedType(bits);
  return wrap(`(${type})${text}`, PREC.unary, parentPrec);
}

function hasTopLevelBitwiseOp(text) {
  if (typeof text !== 'string' || !/[&|^]/.test(text)) return false;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) {
      if (ch === '&') {
        if (text[i + 1] === '&') { i += 1; continue; }
        const prev = text.slice(0, i).trimEnd();
        if (prev.length > 0 && /[A-Za-z0-9_)\]]$/.test(prev)) return true;
      } else if (ch === '|') {
        if (text[i + 1] === '|') { i += 1; continue; }
        return true;
      } else if (ch === '^') {
        return true;
      }
    }
  }
  return false;
}

function parenthesizeBitwiseOperand(text) {
  return hasTopLevelBitwiseOp(text) ? `(${text})` : text;
}

function compareOperands(n, p, opts) {
  // A floating-domain comparison compares the operands' values as-is; the
  // integer signed/unsigned views would assert a different domain and change
  // the meaning of the comparison (#5247).
  if (n.comparisonDomain === 'floating') {
    return [printExpression(n.left, p, opts), printExpression(n.right, p + 1, opts)];
  }
  let leftText;
  let rightText;
  if (n.compareSigned !== true && n.compareSigned !== false) {
    leftText = printExpression(n.left, p, opts);
    rightText = printExpression(n.right, p + 1, opts);
  } else {
    const bits = integerWidth(n.left, n.right);
    leftText = printIntegerView(n.left, bits, n.compareSigned, p, opts);
    rightText = printIntegerView(n.right, bits, n.compareSigned, p + 1, opts);
  }
  return [parenthesizeBitwiseOperand(leftText), parenthesizeBitwiseOperand(rightText)];
}

function printIntegerBinaryOperand(n, bits, signed, p, opts, forceCast = false) {
  if (exprIsPointerTyped(n, opts?.pointerVarNames)) {
    const uintptrText = printPointerAsUintptr(n, opts);
    if (!signed && normalizedIntegerWidth(bits) === 64) return wrap(uintptrText, PREC.unary, p);
    const type = signed ? exactSignedType(bits) : exactUnsignedType(bits);
    return wrap(`(${type})${uintptrText}`, PREC.unary, p);
  }
  return printIntegerView(n, bits, signed, p, opts, forceCast);
}

function signedBinaryOperands(n, p, opts) {
  const bits = integerWidth(n, n.left, n.right);
  switch (n.op) {
    case 'lshr': {
      const rightText = exprIsPointerTyped(n.right, opts?.pointerVarNames)
        ? printPointerAsUintptr(n.right, opts)
        : printExpression(n.right, p + 1, opts);
      return [printIntegerBinaryOperand(n.left, bits, false, p, opts), rightText];
    }
    case 'ashr': {
      const rightText = exprIsPointerTyped(n.right, opts?.pointerVarNames)
        ? printPointerAsUintptr(n.right, opts)
        : printExpression(n.right, p + 1, opts);
      return [printIntegerBinaryOperand(n.left, bits, true, p, opts), rightText];
    }
    case 'udiv':
      return [printIntegerBinaryOperand(n.left, bits, false, p, opts, true), printIntegerBinaryOperand(n.right, bits, false, p + 1, opts, false)];
    case 'umod': case 'urem':
      return [printIntegerBinaryOperand(n.left, bits, false, p, opts), printIntegerBinaryOperand(n.right, bits, false, p + 1, opts)];
    case 'sdiv': case 'smod': case 'srem':
      return [printIntegerBinaryOperand(n.left, bits, true, p, opts), printIntegerBinaryOperand(n.right, bits, true, p + 1, opts)];
    case 'smull':
    case 'umull': {
      const isSigned = n.op === 'smull';
      const castPrefix = isSigned ? '(int64_t)(int32_t)' : '(uint64_t)(uint32_t)';
      const formatOp = (operand) => {
        const inner = exprIsPointerTyped(operand, opts?.pointerVarNames)
          ? printPointerAsUintptr(operand, opts)
          : printExpression(operand, PREC.unary, opts);
        return wrap(`${castPrefix}${inner}`, PREC.unary, p);
      };
      return [formatOp(n.left), formatOp(n.right)];
    }
    default:
      return null;
  }
}

function sanitizeCallableIdent(name, fallback = 'unknown_call') {
  const raw = String(name || '').trim();
  if (!raw) return fallback;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return raw;
  if (/^[A-Za-z_][A-Za-z0-9_]*(?:(?:->|\.)[A-Za-z_][A-Za-z0-9_]*)+$/.test(raw)) return raw;
  if (/^\(\s*(?:\*|\([A-Za-z_0-9\s*]+\s*\(\*\))/.test(raw)) return raw;
  const clean = raw
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, '_$1');
  return clean || fallback;
}

export function printExpression(n, parentPrec = 0, opts = {}) {
  if (!n) return 'unknown';
  switch (n.kind) {
    case 'const': return integerText(n.value, n.bits, n.signed);
    case 'float-const': return floatText(n.value, n.bits);
    case 'var': return n.name || 'value';
    case 'field': {
      const rawBase = printExpression(n.base, PREC.primary, opts);
      const baseText = /^\s*&/.test(rawBase) ? `(${rawBase})` : rawBase;
      return `${baseText}->${n.name || `field_${BigInt(n.offset || 0).toString(16).toUpperCase()}`}`;
    }
    case 'index': {
      const idxText = printExpression(n.index, 0, opts);
      const mustCast = opts.indexBaseIsPointer !== true;
      if (!mustCast) {
        return `${printExpression(n.base, PREC.primary, opts)}[${idxText}]`;
      }
      const elemBits = [8, 16, 32, 64, 128].includes(Number(n.bits)) ? Number(n.bits) : 8;
      const elemType = (typeof n.elemType === 'string' && n.elemType)
        ? n.elemType
        : (n.isFloat
          ? (elemBits === 32 ? 'float' : 'double')
          : (elemBits === 128 ? 'uint128' : `${n.signed === true ? 'int' : 'uint'}${elemBits}_t`));
      return `((${elemType} *)(uintptr_t)(${printExpression(n.base, 0, opts)}))[${idxText}]`;
    }
    case 'load': return n.location?.text || n.location?.name || `memory_${String(n.location?.key || 'unknown').replace(/[^A-Za-z0-9_]/g, '_')}`;
    case 'call': return `${sanitizeCallableIdent(n.callee, 'unknown_call')}(${(n.args || []).map((a) => printExpression(a, 0, opts)).join(', ')})`;
    case 'intrinsic': {
      if (n.name === 'madd' && n.args?.length === 3) {
        const text = `${printExpression(n.args[0], PREC.mul, opts)} * ${printExpression(n.args[1], PREC.mul, opts)} + ${printExpression(n.args[2], PREC.add + 1, opts)}`;
        return wrap(text, PREC.add, parentPrec);
      }
      if (n.name === 'msub' && n.args?.length === 3) {
        const text = `${printExpression(n.args[2], PREC.sub, opts)} - ${printExpression(n.args[0], PREC.mul, opts)} * ${printExpression(n.args[1], PREC.mul, opts)}`;
        return wrap(text, PREC.sub, parentPrec);
      }
      return `${sanitizeCallableIdent(n.name, 'unknown_intrinsic')}(${(n.args || []).map((a) => printExpression(a, 0, opts)).join(', ')})`;
    }
    case 'unary': {
      const opLower = String(n.op || '').toLowerCase();
      const op = { neg: '-', fneg: '-', not: '~', lnot: '!' }[opLower];
      if (op) {
        if ((opLower === 'not' || opLower === 'neg') && exprIsPointerTyped(n.arg, opts.pointerVarNames)) {
          return wrap(`${op}${printPointerAsUintptr(n.arg, opts)}`, PREC.unary, parentPrec);
        }
        return wrap(`${op}${printExpression(n.arg, PREC.unary, opts)}`, PREC.unary, parentPrec);
      }
      if (opLower === 'is-zero' || opLower === 'is_zero') {
        const inner = parenthesizeBitwiseOperand(printExpression(n.arg, PREC.eq, opts));
        return wrap(`${inner} == 0`, PREC.eq, parentPrec);
      }
      if (opLower === 'is-nonzero' || opLower === 'is_nonzero') {
        const inner = parenthesizeBitwiseOperand(printExpression(n.arg, PREC.ne, opts));
        return wrap(`${inner} != 0`, PREC.ne, parentPrec);
      }
      if (opLower === 'trunc' || opLower === 'zext' || opLower === 'sext') {
        if (n.arg?.floating === true || n.arg?.float === true
          || n.arg?.kind === 'float-const' || n.arg?.kind === 'float'
          || n.arg?.type === 'float' || n.arg?.type === 'double') {
          return printExpression(n.arg, parentPrec, opts);
        }
        const dstBits = normalizedIntegerWidth(n.bits);
        const type = opLower === 'sext'
          ? exactSignedType(dstBits)
          : (opLower === 'trunc' && n.signed === true ? exactSignedType(dstBits) : exactUnsignedType(dstBits));
        const argText = exprIsPointerTyped(n.arg, opts.pointerVarNames)
          ? printPointerAsUintptr(n.arg, opts)
          : printExpression(n.arg, PREC.unary, opts);
        if ((opLower === 'sext' || opLower === 'zext') && n.fromBits != null) {
          const fromBits = normalizedIntegerWidth(n.fromBits);
          if (fromBits < dstBits) {
            const wantSigned = opLower === 'sext';
            const alreadyNarrowed = n.arg?.kind === 'unary'
              && n.arg.op === 'trunc'
              && normalizedIntegerWidth(n.arg.bits) === fromBits
              && (wantSigned ? n.arg.signed === true : n.arg.signed !== true);
            if (!alreadyNarrowed) {
              const narrowType = wantSigned ? exactSignedType(fromBits) : exactUnsignedType(fromBits);
              return wrap(`(${type})(${narrowType})${argText}`, PREC.unary, parentPrec);
            }
          }
        }
        return wrap(`(${type})${argText}`, PREC.unary, parentPrec);
      }
      const isFpUnary = ['fabs', 'fsqrt', 'sqrt', 'frinta', 'frintn', 'frintm', 'frintp', 'frintz', 'fcvtzs', 'f2i', 'fcvtzu', 'f2u', 'fcvtps', 'fcvtms', 'fcvtas', 'fcvtns', 'fcvtpu', 'fcvtmu', 'fcvtau', 'fcvtnu', 'fcvt'].includes(n.op);
      const effectiveArg = (isFpUnary && n.arg?.kind === 'unary' && (n.arg.op === 'trunc' || n.arg.op === 'zext')) ? n.arg.arg : n.arg;
      const arg = printExpression(effectiveArg, 0, opts);
      const is32 = Number(n.bits) === 32;
      const srcBits = n.arg?.bits ?? (/^s\d+$/i.test(String(n.arg?.name || '')) ? 32 : 64);
      const srcIsFloat = Number(srcBits) === 32;
      const dstIsFloat = n.bits != null ? is32 : srcIsFloat;
      const sintType = is32 ? 'int32_t' : 'int64_t';
      const uintType = is32 ? 'uint32_t' : 'uint64_t';
      if (opLower === 'fabs') return `${dstIsFloat ? 'fabsf' : 'fabs'}(${arg})`;
      if (opLower === 'abs') return `abs(${arg})`;
      if (opLower === 'fsqrt' || opLower === 'sqrt') return `${dstIsFloat ? 'sqrtf' : 'sqrt'}(${arg})`;
      if (opLower === 'frinta' || opLower === 'frintn') return `${dstIsFloat ? 'roundf' : 'round'}(${arg})`;
      if (opLower === 'frintm') return `${dstIsFloat ? 'floorf' : 'floor'}(${arg})`;
      if (opLower === 'frintp') return `${dstIsFloat ? 'ceilf' : 'ceil'}(${arg})`;
      if (opLower === 'frintz') return `${dstIsFloat ? 'truncf' : 'trunc'}(${arg})`;
      if (opLower === 'fcvtzs' || opLower === 'f2i') return `((${sintType})(double)(${arg}))`;
      if (opLower === 'fcvtzu' || opLower === 'f2u') return `((${uintType})(double)(${arg}))`;
      if (opLower === 'fcvtps') return `((${sintType})${srcIsFloat ? 'ceilf' : 'ceil'}(${arg}))`;
      if (opLower === 'fcvtms') return `((${sintType})${srcIsFloat ? 'floorf' : 'floor'}(${arg}))`;
      if (opLower === 'fcvtas' || opLower === 'fcvtns') return `((${sintType})${srcIsFloat ? 'roundf' : 'round'}(${arg}))`;
      if (opLower === 'fcvtpu') return `((${uintType})${srcIsFloat ? 'ceilf' : 'ceil'}(${arg}))`;
      if (opLower === 'fcvtmu') return `((${uintType})${srcIsFloat ? 'floorf' : 'floor'}(${arg}))`;
      if (opLower === 'fcvtau' || opLower === 'fcvtnu') return `((${uintType})${srcIsFloat ? 'roundf' : 'round'}(${arg}))`;
      const intSrcBits = Number(n.fromBits ?? n.arg?.bits ?? 64);
      if (opLower === 'scvtf' || opLower === 'i2f') return `((${is32 ? 'float' : 'double'})(${intSrcBits === 32 ? 'int32_t' : 'int64_t'})(${arg}))`;
      if (opLower === 'ucvtf' || opLower === 'u2f') return `((${is32 ? 'float' : 'double'})(${intSrcBits === 32 ? 'uint32_t' : 'uint64_t'})(${arg}))`;
      if (opLower === 'fcvt') return `((${is32 ? 'float' : 'double'})(${arg}))`;
      return `${sanitizeCallableIdent(n.op, 'unknown_unary')}(${arg})`;
    }
    case 'compare': {
      const p = PREC[n.op] || 8;
      const [left, right] = compareOperands(n, p, opts);
      return wrap(`${left} ${OP_TEXT[n.op] || n.op} ${right}`, p, parentPrec);
    }
    case 'binary': {
      if (n.op === 'ror') {
        const left = exprIsPointerTyped(n.left, opts.pointerVarNames)
          ? printPointerAsUintptr(n.left, opts)
          : printExpression(n.left, 0, opts);
        const right = exprIsPointerTyped(n.right, opts.pointerVarNames)
          ? printPointerAsUintptr(n.right, opts)
          : printExpression(n.right, 0, opts);
        return `ror(${left}, ${right})`;
      }
      const guarded = guardedDivision(n, opts, parentPrec);
      if (guarded) return guarded;
      const exact = moduloArithmeticExpression(n, opts, parentPrec);
      if (exact) return exact;
      const p = PREC[n.op] || 11;
      const semanticOperands = signedBinaryOperands(n, p, opts);
      const leftIsPtr = exprIsPointerTyped(n.left, opts.pointerVarNames);
      const rightIsPtr = exprIsPointerTyped(n.right, opts.pointerVarNames);
      const castLeft = !semanticOperands && (
        (INTEGER_ONLY_BINARY_OPS.has(n.op) && leftIsPtr)
        || (n.op === 'add' && leftIsPtr && rightIsPtr)
      );
      const castRight = !semanticOperands && (
        (INTEGER_ONLY_BINARY_OPS.has(n.op) && rightIsPtr)
        || (n.op === 'sub' && !leftIsPtr && rightIsPtr)
        || (n.op === 'add' && leftIsPtr && rightIsPtr)
      );
      const isFpBin = ['fadd', 'fsub', 'fmul', 'fdiv'].includes(n.op);
      const effLeft = (isFpBin && n.left?.kind === 'unary' && (n.left.op === 'trunc' || n.left.op === 'zext')) ? n.left.arg : n.left;
      const effRight = (isFpBin && n.right?.kind === 'unary' && (n.right.op === 'trunc' || n.right.op === 'zext')) ? n.right.arg : n.right;
      const left = semanticOperands?.[0] ?? (castLeft ? printPointerAsUintptr(effLeft, opts) : printExpression(effLeft, p, opts));
      const right = semanticOperands?.[1] ?? (castRight
        ? printPointerAsUintptr(effRight, opts)
        : printExpression(effRight, p + (['sub','fsub','div','fdiv','sdiv','udiv','mod','rem','smod','umod','srem','urem','shl','lshr','ashr','shr'].includes(n.op) ? 1 : 0), opts));
      return wrap(`${left} ${OP_TEXT[n.op] || n.op} ${right}`, p, parentPrec);
    }
    case 'select': {
      const text = `${printExpression(n.condition, PREC.select + 1, opts)} ? ${printExpression(n.whenTrue, PREC.select, opts)} : ${printExpression(n.whenFalse, PREC.select, opts)}`;
      return wrap(text, PREC.select, parentPrec);
    }
    default: return n.name || 'unknown';
  }
}

function safeSeparatorIndexes(text, separator) {
  const indexes = [];
  let quote = null;
  let escaped = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote != null) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') break;
    if (text.startsWith(separator, index)) {
      indexes.push(index);
      index += separator.length - 1;
    }
  }
  return indexes;
}

function splitLong(text, width, indent) {
  if (text.length + indent.length <= width) return [text];
  const candidates = [' && ', ' || ', ', ', ' + ', ' - '];
  for (const sep of candidates) {
    const indexes = safeSeparatorIndexes(text, sep);
    if (indexes.length === 0) continue;
    const out = [];
    let start = 0;
    for (const index of indexes) {
      out.push(`${start === 0 ? '' : '    '}${text.slice(start, index)}${sep.trimEnd()}`);
      start = index + sep.length;
    }
    out.push(`${start === 0 ? '' : '    '}${text.slice(start)}`);
    return out;
  }
  return [text];
}

export function printProgram(cAst, opts = {}) {
  const width = Math.max(48, Number(opts.columnWidth || 88));
  const lines = [];
  const mapping = [];
  for (const n of cAst?.body || []) {
    const indent = '    '.repeat(Math.max(0, n.indent || 0));
    const text = n.text ?? '';
    const chunks = splitLong(text, width, indent);
    const start = lines.length;
    for (const chunk of chunks) lines.push(indent + chunk);
    mapping.push({ outputStartLine: start + 1, outputEndLine: lines.length, source: n.source, kind: n.kind });
  }
  return { text: lines.join('\n'), lines, mapping };
}

export function expressionReadability(n) {
  const text = printExpression(n);
  return { characters: text.length, effect: effectOf(n), casts: (text.match(/\([ui]nt\d+_t\)/g) || []).length, temporaries: (text.match(/\b(?:v|tmp)\d+\b/g) || []).length };
}
