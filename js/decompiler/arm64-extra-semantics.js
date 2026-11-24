import { sourceOf } from './ast/nodes.js';
import { closeFunctionOutput } from './c-output-closure.js';
import { buildRenderProvenance } from './phase8/render-provenance.js';

/* Exact late lowering for ARM64 instructions that the legacy/semantic
 * decompilers still preserve as raw __asm. This is deliberately mnemonic-
 * scoped: unknown instructions stay raw assembly rather than being hidden. */

const A64_CONDITIONS = new Set([
  'eq', 'ne', 'cs', 'hs', 'cc', 'lo', 'mi', 'pl', 'vs', 'vc',
  'hi', 'ls', 'ge', 'lt', 'gt', 'le', 'al', 'nv',
]);

function canonicalConditionToken(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.trim().toLowerCase();
  return A64_CONDITIONS.has(normalized) ? normalized : null;
}

function renderedText(lines) {
  return (lines || []).map((line) => `${'    '.repeat(Math.max(0, line.indent || 0))}${line.text || ''}`).join('\n');
}

function splitOperands(text) {
  return String(text || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function parseImm(text) {
  const raw = String(text || '').trim().replace(/^#/, '');
  if (!/^-?(?:0x[0-9a-f]+|\d+)$/i.test(raw)) return null;
  const value = Number.parseInt(raw, 0);
  return Number.isSafeInteger(value) ? value : null;
}

function parseImm64(text) {
  const raw = String(text || '').trim().replace(/^#/, '');
  if (!/^-?(?:0x[0-9a-f]+|\d+)$/i.test(raw)) return null;
  try { return BigInt(raw); } catch { return null; }
}

const A64_ELEMENT_BITS = Object.freeze({ b:8, h:16, s:32, d:64 });
// The legacy renderer names every general-purpose register `xN` and every
// SIMD/FP register `vN` regardless of the printed view (`wN`, `sN`, `dN`, …).
// A late lowering may therefore only publish a destination variable the rest of
// the function already reads: the printed full-width register, or the SIMD
// register base name. Every other view stays raw instead of aliasing a second
// C variable onto the same architectural register.
const GP_FULL_WIDTH_TEXT = /^x(\d{1,2})$/;
const GP_ANY_WIDTH_TEXT = /^([wx])(\d{1,2}|zr)$/i;
const SCALAR_FP_TEXT = /^[bhsdq](\d{1,2})$/i;
const VECTOR_TEXT = /^v(\d{1,2})(?:\.(\d{1,2})([bhsd]))?$/i;

// A64 wide/narrow arrangement pairs shared by the long (widening) forms.
const WIDE_LOW_SOURCE_ARRANGEMENT = Object.freeze({ '8h':'8b', '4s':'4h', '2d':'2s' });
const WIDE_HIGH_SOURCE_ARRANGEMENT = Object.freeze({ '8h':'16b', '4s':'8h', '2d':'4s' });
// ADDV has no 2D form; every arrangement reduces to one scalar element.
const ADDV_DESTINATION_ELEMENT_BITS = Object.freeze({ '8b':8, '16b':8, '4h':16, '8h':16, '4s':32 });
const BITWISE_INSERT_ARRANGEMENTS = new Set(['8b','16b']);

const ARRANGEMENT_LAYOUT = Object.freeze({
  '8b':  { lanes: 8,  elemBits: 8,  widthBits: 64 },
  '16b': { lanes: 16, elemBits: 8,  widthBits: 128 },
  '4h':  { lanes: 4,  elemBits: 16, widthBits: 64 },
  '8h':  { lanes: 8,  elemBits: 16, widthBits: 128 },
  '2s':  { lanes: 2,  elemBits: 32, widthBits: 64 },
  '4s':  { lanes: 4,  elemBits: 32, widthBits: 128 },
  '2d':  { lanes: 2,  elemBits: 64, widthBits: 128 },
});

function gpFullWidthRegister(text) {
  const match = GP_FULL_WIDTH_TEXT.exec(String(text || '').trim());
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number < 0 || number > 30) return null;
  return { number, name:`x${number}` };
}

function gpRegister(text, canonicalGpNames = false) {
  const match = GP_ANY_WIDTH_TEXT.exec(String(text || '').trim());
  if (!match) return null;
  const prefix = match[1].toLowerCase();
  const bits = prefix === 'w' ? 32 : 64;
  if (match[2].toLowerCase() === 'zr') {
    return { isZero: true, number: 31, bits, name: bits === 32 ? '0U' : '0ULL', canonicalName: bits === 32 ? '0U' : '0ULL' };
  }
  const number = Number(match[2]);
  if (!Number.isInteger(number) || number < 0 || number > 30) return null;
  const canonicalName = `x${number}`;
  return { isZero: false, number, bits, name: canonicalGpNames ? canonicalName : `${prefix}${number}`, canonicalName };
}

function vectorRegister(text) {
  const match = VECTOR_TEXT.exec(String(text || '').trim());
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number < 0 || number > 31) return null;
  const base = `v${number}`;
  if (match[2] == null) return { number, name:base, arrangement:null, elementBits:null, widthBits:128 };
  const element = String(match[3]).toLowerCase();
  const laneCount = Number(match[2]);
  const elementBits = A64_ELEMENT_BITS[element];
  if (!Number.isInteger(laneCount) || laneCount < 1 || !elementBits) return null;
  const widthBits = laneCount * elementBits;
  if (widthBits !== 64 && widthBits !== 128) return null;
  return { number, name:base, arrangement:`${laneCount}${element}`, elementBits, widthBits };
}

function scalarFpRegister(text) {
  const match = SCALAR_FP_TEXT.exec(String(text || '').trim());
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isInteger(number) || number < 0 || number > 31) return null;
  const element = String(text).trim()[0].toLowerCase();
  return { number, name:`v${number}`, elementBits:A64_ELEMENT_BITS[element] };
}

// In A64 assembly syntax the MOVI <V>.2D immediate is the already-expanded
// 64-bit value whose every byte is 0x00 or 0xff — the encoding's 8-bit
// `abcdefgh` field has been unfolded by the disassembler (#5454). Treating the
// printed immediate as the encoding field turned `movi v0.2d, #0xff` into
// all-ones. Validate the byte-mask shape instead of re-expanding; anything
// else is not a canonical 2D immediate and stays raw.
function canonicalMovi2dImmediate(imm) {
  if (imm == null || imm < 0n || imm > 0xffffffffffffffffn) return null;
  for (let byte = 0; byte < 8; byte++) {
    const value = (imm >> BigInt(byte * 8)) & 0xffn;
    if (value !== 0n && value !== 0xffn) return null;
  }
  return imm;
}

function asmPayload(text) {
  const match = /^\s*__asm\s*\(\s*(["'])(.*?)\1\s*\)\s*;?\s*$/.exec(String(text || ''));
  return match ? match[2].trim() : null;
}

/* --- Standard C lowering helpers (UB-free across 32-bit and 64-bit widths) --- */

function hexLiteral(value, bits) {
  const mask = (1n << BigInt(bits)) - 1n;
  const masked = BigInt.asUintN(bits, value & mask);
  return `0x${masked.toString(16)}${bits === 32 ? 'U' : 'ULL'}`;
}

function lowerUbfizExpr(srcExpr, lsb, width, bits) {
  const uType = bits === 32 ? 'uint32_t' : 'uint64_t';
  if (width === bits) return `(${uType})(${srcExpr})`;
  const maskLit = hexLiteral((1n << BigInt(width)) - 1n, bits);
  if (lsb === 0) return `((${uType})(${srcExpr}) & ${maskLit})`;
  return `(((${uType})(${srcExpr}) & ${maskLit}) << ${lsb})`;
}

function lowerSbfizExpr(srcExpr, lsb, width, bits) {
  const uType = bits === 32 ? 'uint32_t' : 'uint64_t';
  const sType = bits === 32 ? 'int32_t' : 'int64_t';
  if (width === bits) return `(${uType})(${srcExpr})`;
  const lshift = bits - width;
  const rshift = bits - width - lsb;
  if (rshift === 0) return `((${uType})(${srcExpr}) << ${lshift})`;
  return `(${uType})((${sType})((${uType})(${srcExpr}) << ${lshift}) >> ${rshift})`;
}

function lowerUbfxExpr(srcExpr, lsb, width, bits) {
  const uType = bits === 32 ? 'uint32_t' : 'uint64_t';
  if (width === bits) return `(${uType})(${srcExpr})`;
  const maskLit = hexLiteral((1n << BigInt(width)) - 1n, bits);
  if (lsb === 0) return `((${uType})(${srcExpr}) & ${maskLit})`;
  return `(((${uType})(${srcExpr}) >> ${lsb}) & ${maskLit})`;
}

function lowerSbfxExpr(srcExpr, lsb, width, bits) {
  const uType = bits === 32 ? 'uint32_t' : 'uint64_t';
  const sType = bits === 32 ? 'int32_t' : 'int64_t';
  if (width === bits) return `(${uType})(${srcExpr})`;
  const lshift = bits - lsb - width;
  const rshift = bits - width;
  if (lshift === 0) return `(${uType})((${sType})(${uType})(${srcExpr}) >> ${rshift})`;
  return `(${uType})((${sType})((${uType})(${srcExpr}) << ${lshift}) >> ${rshift})`;
}

function lowerBfiExpr(dstExpr, srcExpr, lsb, width, bits) {
  const uType = bits === 32 ? 'uint32_t' : 'uint64_t';
  if (width === bits) return `(${uType})(${srcExpr})`;
  const fieldMask = (1n << BigInt(width)) - 1n;
  const allMask = (1n << BigInt(bits)) - 1n;
  const clearLit = hexLiteral(allMask ^ (fieldMask << BigInt(lsb)), bits);
  const fieldLit = hexLiteral(fieldMask, bits);
  const inserted = lsb === 0
    ? `((${uType})(${srcExpr}) & ${fieldLit})`
    : `(((${uType})(${srcExpr}) & ${fieldLit}) << ${lsb})`;
  return `(((${uType})(${dstExpr}) & ${clearLit}) | ${inserted})`;
}

function lowerBfxilExpr(dstExpr, srcExpr, lsb, width, bits) {
  const uType = bits === 32 ? 'uint32_t' : 'uint64_t';
  if (width === bits) return `(${uType})(${srcExpr})`;
  const fieldMask = (1n << BigInt(width)) - 1n;
  const allMask = (1n << BigInt(bits)) - 1n;
  const clearLit = hexLiteral(allMask ^ fieldMask, bits);
  const fieldLit = hexLiteral(fieldMask, bits);
  const extracted = lsb === 0
    ? `((${uType})(${srcExpr}) & ${fieldLit})`
    : `(((${uType})(${srcExpr}) >> ${lsb}) & ${fieldLit})`;
  return `(((${uType})(${dstExpr}) & ${clearLit}) | ${extracted})`;
}

function lowerMoviCExpr(arrangement, laneValue) {
  const layout = ARRANGEMENT_LAYOUT[arrangement];
  if (!layout) return null;
  const elemMask = (1n << BigInt(layout.elemBits)) - 1n;
  const elem = BigInt.asUintN(64, laneValue) & elemMask;
  let lo = 0n;
  let hi = 0n;
  for (let i = 0; i < layout.lanes; i++) {
    const bitPos = i * layout.elemBits;
    if (bitPos < 64) lo |= elem << BigInt(bitPos);
    else hi |= elem << BigInt(bitPos - 64);
  }
  lo = BigInt.asUintN(64, lo);
  hi = BigInt.asUintN(64, hi);
  if (hi === 0n) return `(unsigned __int128)0x${lo.toString(16)}ULL`;
  return `(((unsigned __int128)0x${hi.toString(16)}ULL << 64) | 0x${lo.toString(16)}ULL)`;
}

function lowerUshllCExpr(srcName, dstArrangement, shift, isHigh) {
  const layout = ARRANGEMENT_LAYOUT[dstArrangement];
  if (!layout) return null;
  const wideBits = layout.elemBits;
  const narrowBits = wideBits / 2;
  const narrowMask = hexLiteral((1n << BigInt(narrowBits)) - 1n, 64);
  const wideMask = hexLiteral((1n << BigInt(wideBits)) - 1n, 64);
  const baseBit = isHigh ? 64 : 0;
  const parts = [];
  for (let i = 0; i < layout.lanes; i++) {
    const srcBit = baseBit + i * narrowBits;
    const extracted = srcBit === 0
      ? `((uint64_t)(${srcName}) & ${narrowMask})`
      : `((uint64_t)((${srcName}) >> ${srcBit}) & ${narrowMask})`;
    const shifted = shift === 0 ? extracted : `((${extracted} << ${shift}) & ${wideMask})`;
    const dstBit = i * wideBits;
    parts.push(dstBit === 0 ? `(unsigned __int128)${shifted}` : `((unsigned __int128)${shifted} << ${dstBit})`);
  }
  return `(${parts.join(' | ')})`;
}

function lowerUaddwCExpr(wideName, narrowName, dstArrangement, isHigh) {
  const layout = ARRANGEMENT_LAYOUT[dstArrangement];
  if (!layout) return null;
  const wideBits = layout.elemBits;
  const narrowBits = wideBits / 2;
  const narrowMask = hexLiteral((1n << BigInt(narrowBits)) - 1n, 64);
  const wideMask = hexLiteral((1n << BigInt(wideBits)) - 1n, 64);
  const baseBit = isHigh ? 64 : 0;
  const parts = [];
  for (let i = 0; i < layout.lanes; i++) {
    const dstBit = i * wideBits;
    const srcBit = baseBit + i * narrowBits;
    const wideLane = dstBit === 0
      ? `((uint64_t)(${wideName}) & ${wideMask})`
      : `((uint64_t)((${wideName}) >> ${dstBit}) & ${wideMask})`;
    const narrowLane = srcBit === 0
      ? `((uint64_t)(${narrowName}) & ${narrowMask})`
      : `((uint64_t)((${narrowName}) >> ${srcBit}) & ${narrowMask})`;
    const sum = `((${wideLane} + ${narrowLane}) & ${wideMask})`;
    parts.push(dstBit === 0 ? `(unsigned __int128)${sum}` : `((unsigned __int128)${sum} << ${dstBit})`);
  }
  return `(${parts.join(' | ')})`;
}

function lowerPermuteCExpr(mnemonic, src1Name, src2Name, arrangement) {
  const layout = ARRANGEMENT_LAYOUT[arrangement];
  if (!layout) return null;
  const { lanes, elemBits } = layout;
  const half = lanes / 2;
  const elemMask = hexLiteral((1n << BigInt(elemBits)) - 1n, 64);
  const parts = [];
  for (let i = 0; i < lanes; i++) {
    let srcName;
    let srcLane;
    if (mnemonic === 'uzp1') {
      srcName = i < half ? src1Name : src2Name;
      srcLane = i < half ? 2 * i : 2 * (i - half);
    } else if (mnemonic === 'uzp2') {
      srcName = i < half ? src1Name : src2Name;
      srcLane = i < half ? 2 * i + 1 : 2 * (i - half) + 1;
    } else if (mnemonic === 'zip1') {
      srcName = i % 2 === 0 ? src1Name : src2Name;
      srcLane = i % 2 === 0 ? i / 2 : (i - 1) / 2;
    } else if (mnemonic === 'zip2') {
      srcName = i % 2 === 0 ? src1Name : src2Name;
      srcLane = i % 2 === 0 ? half + i / 2 : half + (i - 1) / 2;
    } else {
      return null;
    }
    const srcBit = srcLane * elemBits;
    const extracted = srcBit === 0
      ? `((uint64_t)(${srcName}) & ${elemMask})`
      : `((uint64_t)((${srcName}) >> ${srcBit}) & ${elemMask})`;
    const dstBit = i * elemBits;
    parts.push(dstBit === 0 ? `(unsigned __int128)${extracted}` : `((unsigned __int128)${extracted} << ${dstBit})`);
  }
  return `(${parts.join(' | ')})`;
}

function lowerAddvCExpr(srcName, srcArrangement) {
  const layout = ARRANGEMENT_LAYOUT[srcArrangement];
  if (!layout) return null;
  const elemType = `uint${layout.elemBits}_t`;
  const terms = [];
  for (let i = 0; i < layout.lanes; i++) {
    const bit = i * layout.elemBits;
    terms.push(bit === 0 ? `(${elemType})(${srcName})` : `(${elemType})((${srcName}) >> ${bit})`);
  }
  return `(unsigned __int128)(${elemType})(${terms.join(' + ')})`;
}

function lowerRbitStatement(dstName, srcExpr, bits) {
  if (bits === 32) {
    return `${dstName} = __builtin_bswap32((uint32_t)(${srcExpr})); `
      + `${dstName} = (((uint32_t)${dstName} & 0x0f0f0f0fU) << 4) | (((uint32_t)${dstName} >> 4) & 0x0f0f0f0fU); `
      + `${dstName} = (((uint32_t)${dstName} & 0x33333333U) << 2) | (((uint32_t)${dstName} >> 2) & 0x33333333U); `
      + `${dstName} = (((uint32_t)${dstName} & 0x55555555U) << 1) | (((uint32_t)${dstName} >> 1) & 0x55555555U);`;
  }
  return `${dstName} = __builtin_bswap64((uint64_t)(${srcExpr})); `
    + `${dstName} = (((uint64_t)${dstName} & 0x0f0f0f0f0f0f0f0fULL) << 4) | (((uint64_t)${dstName} >> 4) & 0x0f0f0f0f0f0f0f0fULL); `
    + `${dstName} = (((uint64_t)${dstName} & 0x3333333333333333ULL) << 2) | (((uint64_t)${dstName} >> 2) & 0x3333333333333333ULL); `
    + `${dstName} = (((uint64_t)${dstName} & 0x5555555555555555ULL) << 1) | (((uint64_t)${dstName} >> 1) & 0x5555555555555555ULL);`;
}

function registerFamilyKey(token) {
  const s = String(token || '').trim().toLowerCase();
  let m = /^[wx](\d{1,2})$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return n >= 0 && n <= 30 ? `gp:${n}` : null;
  }
  m = /^[bhsdqv](\d{1,2})(?:\.|$)/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return n >= 0 && n <= 31 ? `fp:${n}` : null;
  }
  return null;
}

function nzcvImmediateMatches(nzcv, cond) {
  const n = !!(nzcv & 8);
  const z = !!(nzcv & 4);
  const c = !!(nzcv & 2);
  const v = !!(nzcv & 1);
  switch (cond) {
    case 'eq': return z;
    case 'ne': return !z;
    case 'cs': case 'hs': return c;
    case 'cc': case 'lo': return !c;
    case 'mi': return n;
    case 'pl': return !n;
    case 'vs': return v;
    case 'vc': return !v;
    case 'hi': return c && !z;
    case 'ls': return !c || z;
    case 'ge': return n === v;
    case 'lt': return n !== v;
    case 'gt': return !z && n === v;
    case 'le': return z || n !== v;
    case 'al': return true;
    case 'nv': return false;
    default: return false;
  }
}

function cmpCtxRegs(cmpCtx) {
  if (!cmpCtx) return [];
  if (Array.isArray(cmpCtx.regs)) return cmpCtx.regs;
  const out = [];
  const kL = registerFamilyKey(cmpCtx.lhs);
  if (kL) out.push(kL);
  const kR = registerFamilyKey(cmpCtx.rhs);
  if (kR && kR !== kL) out.push(kR);
  return out;
}

function parseComparisonContext(lineText, canonicalGpNames = false) {
  const trimmed = String(lineText || '').trim();
  const commentMatch = /^\/\*\s*(cmp|fcmp|cmn|tst)\s+([^,—*]+?),\s*([^—*]+?)(?:\s+—.*)?\*\/$/i.exec(trimmed);
  const asmText = !commentMatch ? asmPayload(trimmed) : null;
  let kind = null;
  let rawLhs = null;
  let rawRhs = null;
  if (commentMatch) {
    kind = commentMatch[1].toLowerCase();
    rawLhs = commentMatch[2].trim();
    rawRhs = commentMatch[3].trim();
  } else if (asmText) {
    const sp = asmText.indexOf(' ');
    if (sp > 0) {
      const mn = asmText.slice(0, sp).toLowerCase();
      if (mn === 'cmp' || mn === 'fcmp' || mn === 'cmn' || mn === 'tst') {
        const ops = splitOperands(asmText.slice(sp + 1));
        if (ops.length === 2) {
          kind = mn;
          rawLhs = ops[0];
          rawRhs = ops[1];
        }
      }
    }
  }
  if (!kind || !rawLhs || !rawRhs) return null;

  if (kind === 'fcmp') {
    if (!/^[sd]\d+$/i.test(rawLhs)) return null;
    const isFloat = rawLhs[0].toLowerCase() === 's';
    const rhs = /^[sd]\d+$/i.test(rawRhs)
      ? rawRhs
      : (/^#?0(?:\.0)?$/.test(rawRhs) ? (isFloat ? '0.0f' : '0.0') : null);
    if (!rhs) return null;
    return { kind: 'fcmp', lhs: rawLhs, rhs, bits: isFloat ? 32 : 64 };
  }

  const lhsReg = gpRegister(rawLhs, canonicalGpNames);
  if (!lhsReg) return null;
  const bits = lhsReg.bits;
  const rhsReg = gpRegister(rawRhs, canonicalGpNames);
  let rhs = null;
  if (rhsReg && rhsReg.bits === bits) {
    rhs = rhsReg.name;
  } else {
    const imm = parseImm64(rawRhs);
    if (imm != null) rhs = hexLiteral(imm, bits);
  }
  if (!rhs) return null;
  return { kind, lhs: lhsReg.name, rhs, bits };
}

function conditionExprFromContext(cond, cmpCtx) {
  if (cond === 'al') return '1';
  if (cond === 'nv') return '0';
  if (!cmpCtx) return null;
  if (cmpCtx.kind === 'fccmp') {
    if (!cmpCtx.guardExpr) return null;
    const fcmpExpr = conditionExprFromContext(cond, cmpCtx.fcmp);
    if (!fcmpExpr) return null;
    const fallback = nzcvImmediateMatches(cmpCtx.nzcv, cond) ? '1' : '0';
    return `(${cmpCtx.guardExpr} ? ${fcmpExpr} : ${fallback})`;
  }
  const { kind, lhs, rhs, bits } = cmpCtx;
  if (kind === 'fcmp') {
    // ARM64 FCMP NZCV table:
    //   == : 0110,  < : 1000,  > : 0010,  Unordered (NaN) : 0011.
    switch (cond) {
      case 'eq': return `(${lhs} == ${rhs})`;
      case 'ne': return `(${lhs} != ${rhs})`;
      case 'lo': case 'cc': case 'mi': return `(${lhs} < ${rhs})`;
      case 'ls': return `(${lhs} <= ${rhs})`;
      case 'gt': return `(${lhs} > ${rhs})`;
      case 'ge': return `(${lhs} >= ${rhs})`;
      case 'lt': return `(!(${lhs} >= ${rhs}))`;
      case 'le': return `(!(${lhs} > ${rhs}))`;
      case 'hi': return `(!(${lhs} <= ${rhs}))`;
      case 'hs': case 'cs': case 'pl': return `(!(${lhs} < ${rhs}))`;
      case 'vs': return `((${lhs} != ${lhs}) || (${rhs} != ${rhs}))`;
      case 'vc': return `((${lhs} == ${lhs}) && (${rhs} == ${rhs}))`;
      default: return null;
    }
  }
  const uType = bits === 32 ? 'uint32_t' : 'uint64_t';
  const sType = bits === 32 ? 'int32_t' : 'int64_t';
  if (kind === 'tst') {
    const masked = `((${uType})(${lhs}) & (${uType})(${rhs}))`;
    if (cond === 'eq') return `(${masked} == 0)`;
    if (cond === 'ne') return `(${masked} != 0)`;
    if (cond === 'mi') return `((${sType})${masked} < 0)`;
    if (cond === 'pl') return `((${sType})${masked} >= 0)`;
    return null;
  }
  if (kind === 'cmn') {
    const sum = `((${uType})(${lhs}) + (${uType})(${rhs}))`;
    if (cond === 'eq') return `(${sum} == 0)`;
    if (cond === 'ne') return `(${sum} != 0)`;
    if (cond === 'mi') return `((${sType})${sum} < 0)`;
    if (cond === 'pl') return `((${sType})${sum} >= 0)`;
    return null;
  }
  switch (cond) {
    case 'eq': return `((${uType})(${lhs}) == (${uType})(${rhs}))`;
    case 'ne': return `((${uType})(${lhs}) != (${uType})(${rhs}))`;
    case 'lt': return `((${sType})(${lhs}) < (${sType})(${rhs}))`;
    case 'le': return `((${sType})(${lhs}) <= (${sType})(${rhs}))`;
    case 'gt': return `((${sType})(${lhs}) > (${sType})(${rhs}))`;
    case 'ge': return `((${sType})(${lhs}) >= (${sType})(${rhs}))`;
    case 'lo': case 'cc': return `((${uType})(${lhs}) < (${uType})(${rhs}))`;
    case 'ls': return `((${uType})(${lhs}) <= (${uType})(${rhs}))`;
    case 'hi': return `((${uType})(${lhs}) > (${uType})(${rhs}))`;
    case 'hs': case 'cs': return `((${uType})(${lhs}) >= (${uType})(${rhs}))`;
    case 'mi': return `((${sType})((${uType})(${lhs}) - (${uType})(${rhs})) < 0)`;
    case 'pl': return `((${sType})((${uType})(${lhs}) - (${uType})(${rhs})) >= 0)`;
    default: return null;
  }
}

function lowerOne(payload, { standardC = false, cmpCtx = null, canonicalGpNames = false } = {}) {
  const space = payload.indexOf(' ');
  const mnemonic = (space < 0 ? payload : payload.slice(0, space)).toLowerCase();
  const operands = splitOperands(space < 0 ? '' : payload.slice(space + 1));
  const reg = (op) => gpRegister(op, canonicalGpNames);

  // REV <Wd|Xd>, <Wn|Xn>: architectural byte reversal of the complete
  // 32/64-bit general-purpose register value.
  if (mnemonic === 'rev' && operands.length === 2) {
    const dst = reg(operands[0]);
    const src = reg(operands[1]);
    if (dst && !dst.isZero && src && dst.bits === src.bits) {
      const arg = (canonicalGpNames && dst.bits === 32) ? `(uint32_t)(${src.name})` : src.name;
      return `${dst.name} = __builtin_bswap${dst.bits}(${arg});`;
    }
  }

  // REV16 <Wd|Xd>, <Wn|Xn>: reverse bytes in each 16-bit halfword.
  if (mnemonic === 'rev16' && operands.length === 2) {
    const dst = reg(operands[0]);
    const src = reg(operands[1]);
    if (dst && !dst.isZero && src && dst.bits === src.bits) {
      if (dst.bits === 32) {
        return `${dst.name} = ((((uint32_t)(${src.name}) & 0x00ff00ffU) << 8) | (((uint32_t)(${src.name}) >> 8) & 0x00ff00ffU));`;
      }
      return `${dst.name} = ((((uint64_t)(${src.name}) & 0x00ff00ff00ff00ffULL) << 8) | (((uint64_t)(${src.name}) >> 8) & 0x00ff00ff00ff00ffULL));`;
    }
  }

  // REV32 <Xd>, <Xn>: reverse bytes in each 32-bit word (64-bit only).
  if (mnemonic === 'rev32' && operands.length === 2) {
    const dst = reg(operands[0]);
    const src = reg(operands[1]);
    if (dst && !dst.isZero && src && dst.bits === 64 && src.bits === 64) {
      return `${dst.name} = (((uint64_t)__builtin_bswap32((uint32_t)((uint64_t)(${src.name}) >> 32)) << 32) | (uint64_t)__builtin_bswap32((uint32_t)(${src.name})));`;
    }
  }

  // RBIT <Wd|Xd>, <Wn|Xn>: reverse all bits in 32-bit or 64-bit register.
  if (mnemonic === 'rbit' && operands.length === 2) {
    const dst = reg(operands[0]);
    const src = reg(operands[1]);
    if (dst && !dst.isZero && src && dst.bits === src.bits) {
      return lowerRbitStatement(dst.name, src.name, dst.bits);
    }
  }

  // CLZ <Wd|Xd>, <Wn|Xn>: count leading zeros (guards zero input to avoid UB).
  if (mnemonic === 'clz' && operands.length === 2) {
    const dst = reg(operands[0]);
    const src = reg(operands[1]);
    if (dst && !dst.isZero && src && dst.bits === src.bits) {
      if (dst.bits === 32) {
        return `${dst.name} = ((uint32_t)(${src.name}) == 0U ? 32U : (uint32_t)__builtin_clz((uint32_t)(${src.name})));`;
      }
      return `${dst.name} = ((uint64_t)(${src.name}) == 0ULL ? 64ULL : (uint64_t)__builtin_clzll((uint64_t)(${src.name})));`;
    }
  }

  // CLS <Wd|Xd>, <Wn|Xn>: count leading sign bits (equal to sign bit minus 1).
  // `v = x ^ (x << 1)` places the first bit differing from the sign bit at the
  // MSB position; its leading-zero count equals CLS for every non-zero `v`, and
  // `x == 0` maps to `bits - 1`.
  if (mnemonic === 'cls' && operands.length === 2) {
    const dst = reg(operands[0]);
    const src = reg(operands[1]);
    if (dst && !dst.isZero && src && dst.bits === src.bits) {
      if (dst.bits === 32) {
        const v = `((uint32_t)(${src.name}) ^ ((uint32_t)(${src.name}) << 1))`;
        return `${dst.name} = (${v} == 0U ? 31U : (uint32_t)__builtin_clz(${v}));`;
      }
      const v = `((uint64_t)(${src.name}) ^ ((uint64_t)(${src.name}) << 1))`;
      return `${dst.name} = (${v} == 0ULL ? 63ULL : (uint64_t)__builtin_clzll(${v}));`;
    }
  }

  // EXTR <Wd|Xd>, <Wn|Xn>, <Wm|Xm>, #<lsb>: extract bits from Rn:Rm.
  if (mnemonic === 'extr' && operands.length === 4) {
    const dst = reg(operands[0]);
    const rn = reg(operands[1]);
    const rm = reg(operands[2]);
    const lsb = parseImm(operands[3]);
    if (dst && !dst.isZero && rn && rm && dst.bits === rn.bits && dst.bits === rm.bits) {
      if (lsb != null && lsb >= 0 && lsb < dst.bits) {
        const uType = dst.bits === 32 ? 'uint32_t' : 'uint64_t';
        if (lsb === 0) return `${dst.name} = (${uType})(${rm.name});`;
        return `${dst.name} = (((${uType})(${rn.name}) << ${dst.bits - lsb}) | ((${uType})(${rm.name}) >> ${lsb}));`;
      }
    }
    return null;
  }

  // SBFX/UBFX <Wd|Xd>, <Wn|Xn>, #<lsb>, #<width>: bitfield extract.
  if (mnemonic === 'sbfx' || mnemonic === 'ubfx') {
    if (operands.length !== 4) return null;
    const dst = reg(operands[0]);
    const src = reg(operands[1]);
    const lsb = parseImm(operands[2]);
    const fieldWidth = parseImm(operands[3]);
    if (!dst || dst.isZero || !src || dst.bits !== src.bits) return null;
    if (lsb == null || fieldWidth == null) return null;
    if (lsb < 0 || fieldWidth < 1 || lsb + fieldWidth > dst.bits) return null;
    const expr = mnemonic === 'sbfx'
      ? lowerSbfxExpr(src.name, lsb, fieldWidth, dst.bits)
      : lowerUbfxExpr(src.name, lsb, fieldWidth, dst.bits);
    return `${dst.name} = ${expr};`;
  }

  // BFI/BFXIL <Wd|Xd>, <Wn|Xn>, #<lsb>, #<width>: bitfield insert/extract-insert-low.
  if (mnemonic === 'bfi' || mnemonic === 'bfxil') {
    if (operands.length !== 4) return null;
    const dst = reg(operands[0]);
    const src = reg(operands[1]);
    const lsb = parseImm(operands[2]);
    const fieldWidth = parseImm(operands[3]);
    if (!dst || dst.isZero || !src || dst.bits !== src.bits) return null;
    if (lsb == null || fieldWidth == null) return null;
    if (lsb < 0 || fieldWidth < 1 || lsb + fieldWidth > dst.bits) return null;
    const expr = mnemonic === 'bfi'
      ? lowerBfiExpr(dst.name, src.name, lsb, fieldWidth, dst.bits)
      : lowerBfxilExpr(dst.name, src.name, lsb, fieldWidth, dst.bits);
    return `${dst.name} = ${expr};`;
  }

  // BFM <Wd|Xd>, <Wn|Xn>, #<immr>, #<imms>: architectural bitfield move.
  if (mnemonic === 'bfm') {
    if (operands.length !== 4) return null;
    const dst = reg(operands[0]);
    const src = reg(operands[1]);
    const immr = parseImm(operands[2]);
    const imms = parseImm(operands[3]);
    if (!dst || dst.isZero || !src || dst.bits !== src.bits) return null;
    if (immr == null || imms == null) return null;
    if (immr < 0 || immr >= dst.bits || imms < 0 || imms >= dst.bits) return null;
    const expr = imms >= immr
      ? lowerBfxilExpr(dst.name, src.name, immr, imms - immr + 1, dst.bits)
      : lowerBfiExpr(dst.name, src.name, dst.bits - immr, imms + 1, dst.bits);
    return `${dst.name} = ${expr};`;
  }

  // FCVTAS: floating point -> signed integer, FPCR-independent round to
  // nearest with halfway cases away from zero, saturating on overflow and 0 on NaN.
  if (mnemonic === 'fcvtas' && operands.length === 2) {
    const dst = reg(operands[0]);
    if (dst && !dst.isZero && /^[sd]\d+$/i.test(operands[1])) {
      const bits = dst.bits;
      const isFloat = operands[1][0].toLowerCase() === 's';
      const src = operands[1];
      if (!standardC) {
        return `${dst.name} = __a64_fcvtas_${bits}(${src});`;
      }
      const fn = isFloat ? '__builtin_llroundf' : '__builtin_llround';
      if (bits === 64) {
        const hi = isFloat ? '9223372036854775808.0f' : '9223372036854775808.0';
        const lo = isFloat ? '-9223372036854775808.0f' : '-9223372036854775808.0';
        return `${dst.name} = (int64_t)(!((${src}) == (${src})) ? 0LL : ((${src}) >= ${hi} ? 0x7fffffffffffffffLL : ((${src}) <= ${lo} ? (-0x7fffffffffffffffLL - 1LL) : ${fn}(${src}))));`;
      }
      const hi = isFloat ? '2147483648.0f' : '2147483647.5';
      const lo = isFloat ? '-2147483648.0f' : '-2147483648.5';
      return `${dst.name} = (int32_t)(!((${src}) == (${src})) ? 0 : ((${src}) >= ${hi} ? 0x7fffffff : ((${src}) <= ${lo} ? (-0x7fffffff - 1) : (int32_t)${fn}(${src}))));`;
    }
  }

  // CSEL/CSINC/CSINV/CSNEG <Wd|Xd>, <Wn|Xn>, <Wm|Xm>, <cond>
  if ((mnemonic === 'csel' || mnemonic === 'csinc' || mnemonic === 'csinv' || mnemonic === 'csneg') && operands.length === 4) {
    const dst = reg(operands[0]);
    const rn = reg(operands[1]);
    const rm = reg(operands[2]);
    const cond = canonicalConditionToken(operands[3]);
    if (dst && !dst.isZero && rn && rm && dst.bits === rn.bits && dst.bits === rm.bits && cond !== null) {
      const uType = dst.bits === 32 ? 'uint32_t' : 'uint64_t';
      const condExpr = conditionExprFromContext(cond, cmpCtx);
      if (!condExpr) return null;
      const tVal = `(${uType})(${rn.name})`;
      let fVal = `(${uType})(${rm.name})`;
      if (mnemonic === 'csinc') fVal = `((${uType})(${rm.name}) + 1${dst.bits === 32 ? 'U' : 'ULL'})`;
      else if (mnemonic === 'csinv') fVal = `(~(${uType})(${rm.name}))`;
      else if (mnemonic === 'csneg') fVal = `(0${dst.bits === 32 ? 'U' : 'ULL'} - (${uType})(${rm.name}))`;
      return `${dst.name} = (${condExpr} ? ${tVal} : ${fVal});`;
    }
    return null;
  }

  // CSET/CSETM <Wd|Xd>, <cond>
  if ((mnemonic === 'cset' || mnemonic === 'csetm') && operands.length === 2) {
    const dst = reg(operands[0]);
    const cond = canonicalConditionToken(operands[1]);
    if (dst && !dst.isZero && cond !== null && cond !== 'al' && cond !== 'nv') {
      const condExpr = conditionExprFromContext(cond, cmpCtx);
      if (!condExpr) return null;
      const tVal = mnemonic === 'cset'
        ? (dst.bits === 32 ? '1U' : '1ULL')
        : (dst.bits === 32 ? '0xffffffffU' : '0xffffffffffffffffULL');
      const fVal = dst.bits === 32 ? '0U' : '0ULL';
      return `${dst.name} = (${condExpr} ? ${tVal} : ${fVal});`;
    }
    return null;
  }

  // FCSEL <Sd|Dd>, <Sn|Dn>, <Sm|Dm>, <cond> chooses one FP source from the
  // current NZCV condition. Unknown condition codes never lower: the raw __asm
  // fallback is the fail-closed boundary.
  if (mnemonic === 'fcsel' && operands.length === 4 && /^[sd]\d+$/i.test(operands[0]) && /^[sd]\d+$/i.test(operands[1]) && /^[sd]\d+$/i.test(operands[2])) {
    const cond = canonicalConditionToken(operands[3]);
    if (cond !== null && cond !== 'al' && cond !== 'nv') {
      if (standardC) {
        const condExpr = conditionExprFromContext(cond, cmpCtx);
        if (!condExpr) return null;
        return `${operands[0]} = ${condExpr} ? ${operands[1]} : ${operands[2]};`;
      }
      return `${operands[0]} = __a64_cond_${cond}() ? ${operands[1]} : ${operands[2]};`;
    }
  }

  // FCCMP conditionally performs an FP compare; when the predicate is false,
  // NZCV is replaced by the encoded immediate.
  if (mnemonic === 'fccmp' && operands.length === 4 && /^[sd]\d+$/i.test(operands[0]) && /^[sd]\d+$/i.test(operands[1])) {
    const cond = canonicalConditionToken(operands[3]);
    if (cond !== null && cond !== 'al' && cond !== 'nv') {
      const nzcv = parseImm(operands[2]);
      if (nzcv != null && nzcv >= 0 && nzcv <= 15) {
        if (standardC) {
          return `(void)(${operands[0]} == ${operands[1]}); /* fccmp ${operands[0]}, ${operands[1]}, #${nzcv}, ${cond} */`;
        }
        return `__a64_fccmp(${operands[0]}, ${operands[1]}, ${nzcv}, "${cond}");`;
      }
    }
  }

  // MOVI scalar 64-bit immediate: `movi dN, #imm` writes the 64-bit byte mask
  // into the low 64 bits of vN and clears the upper 64 bits.
  if (mnemonic === 'movi' && operands.length === 2) {
    const dst = scalarFpRegister(operands[0]);
    if (dst && dst.elementBits === 64) {
      const value = canonicalMovi2dImmediate(parseImm64(operands[1]));
      if (value == null) return null;
      if (standardC) return `${dst.name} = (unsigned __int128)0x${value.toString(16)}ULL;`;
      return `${dst.name} = __a64_movi_d(0x${value.toString(16)});`;
    }
  }

  // MOVI vector immediate. The observed gap is the shifted halfword form, but
  // keep the lowering generic for valid vN.<lanes><b|h|s|d> arrangements.
  if (mnemonic === 'movi' && operands.length >= 2 && /^v\d+\.\d+[bhsd]$/i.test(operands[0])) {
    const arrangement = operands[0].split('.')[1].toLowerCase();
    const vBase = operands[0].split('.')[0];
    if (arrangement === '2d') {
      // The printed immediate is the full 64-bit byte mask; parse it exactly
      // so masks wider than a safe integer still lower exactly (#5454).
      if (operands.length !== 2) return null;
      const value = canonicalMovi2dImmediate(parseImm64(operands[1]));
      if (value == null) return null;
      if (standardC) {
        const expr = lowerMoviCExpr('2d', value);
        if (expr) return `${vBase} = ${expr};`;
      }
      return `${vBase} = __a64_movi_2d(0x${value.toString(16)});`;
    }
    const imm = parseImm(operands[1]);
    if (imm != null) {
      let shift = 0;
      if (operands.length === 3) {
        const match = /^lsl\s+#?(\d+)$/i.exec(operands[2]);
        if (!match) return null;
        shift = Number(match[1]);
      }
      if (shift >= 0 && shift <= 63) {
        const value = BigInt.asUintN(64, BigInt(imm) << BigInt(shift));
        if (standardC) {
          const expr = lowerMoviCExpr(arrangement, value);
          if (expr) return `${vBase} = ${expr};`;
        }
        return `${vBase} = __a64_movi_${arrangement}(0x${value.toString(16)});`;
      }
    }
  }

  // SBFIZ/UBFIZ: bitfield insert. `#<lsb>` and `#<width>` place a sign/zero-
  // extended `width`-bit field of the source at bit `lsb`.
  if (mnemonic === 'sbfiz' || mnemonic === 'ubfiz') {
    if (operands.length !== 4) return null;
    if (standardC) {
      const dst = reg(operands[0]);
      const src = reg(operands[1]);
      const lsb = parseImm(operands[2]);
      const fieldWidth = parseImm(operands[3]);
      if (!dst || dst.isZero || !src || dst.bits !== src.bits) return null;
      if (lsb == null || fieldWidth == null) return null;
      if (lsb < 0 || fieldWidth < 1 || lsb + fieldWidth > dst.bits) return null;
      const expr = mnemonic === 'sbfiz'
        ? lowerSbfizExpr(src.name, lsb, fieldWidth, dst.bits)
        : lowerUbfizExpr(src.name, lsb, fieldWidth, dst.bits);
      return `${dst.name} = ${expr};`;
    }
    const dst = gpFullWidthRegister(operands[0]);
    const src = gpFullWidthRegister(operands[1]);
    const lsb = parseImm(operands[2]);
    const fieldWidth = parseImm(operands[3]);
    if (!dst || !src) return null;
    if (lsb == null || fieldWidth == null) return null;
    if (lsb < 0 || fieldWidth < 1 || lsb + fieldWidth > 64) return null;
    return `${dst.name} = __a64_${mnemonic}_64(${src.name}, ${lsb}, ${fieldWidth});`;
  }

  // USHLL/USHLL2: widening shift left. `Vd.<wide>` receives the low (USHLL) or
  // high (USHLL2) half of `Vn` zero-extended to the destination lane width and
  // shifted left by the immediate. The arrangement pair and the shift range are
  // validated exactly; anything else stays raw.
  if (mnemonic === 'ushll' || mnemonic === 'ushll2') {
    if (operands.length !== 3) return null;
    const dst = vectorRegister(operands[0]);
    const src = vectorRegister(operands[1]);
    const shift = parseImm(operands[2]);
    if (!dst?.arrangement || !src?.arrangement) return null;
    const table = mnemonic === 'ushll2' ? WIDE_HIGH_SOURCE_ARRANGEMENT : WIDE_LOW_SOURCE_ARRANGEMENT;
    if (table[dst.arrangement] !== src.arrangement) return null;
    if (shift == null || shift < 0 || shift >= dst.elementBits) return null;
    if (standardC) {
      const expr = lowerUshllCExpr(src.name, dst.arrangement, shift, mnemonic === 'ushll2');
      if (expr) return `${dst.name} = ${expr};`;
    }
    return `${dst.name} = __a64_${mnemonic}_${dst.arrangement}(${src.name}, ${shift});`;
  }

  // UADDW/UADDW2: widening add. `Vd.<wide>` and `Vn.<wide>` share the wide
  // arrangement; the second source is the low (UADDW) or high (UADDW2) half in
  // the matching narrow arrangement.
  if (mnemonic === 'uaddw' || mnemonic === 'uaddw2') {
    if (operands.length !== 3) return null;
    const dst = vectorRegister(operands[0]);
    const wide = vectorRegister(operands[1]);
    const narrow = vectorRegister(operands[2]);
    if (!dst?.arrangement || !wide?.arrangement || !narrow?.arrangement) return null;
    if (wide.arrangement !== dst.arrangement) return null;
    const table = mnemonic === 'uaddw2' ? WIDE_HIGH_SOURCE_ARRANGEMENT : WIDE_LOW_SOURCE_ARRANGEMENT;
    if (table[dst.arrangement] !== narrow.arrangement) return null;
    if (standardC) {
      const expr = lowerUaddwCExpr(wide.name, narrow.name, dst.arrangement, mnemonic === 'uaddw2');
      if (expr) return `${dst.name} = ${expr};`;
    }
    return `${dst.name} = __a64_${mnemonic}_${dst.arrangement}(${wide.name}, ${narrow.name});`;
  }

  // BIT: bitwise insert if true over whole bytes. `Vd` is both source and
  // destination; only the 8B/16B arrangements exist.
  if (mnemonic === 'bit') {
    if (operands.length !== 3) return null;
    const dst = vectorRegister(operands[0]);
    const source = vectorRegister(operands[1]);
    const mask = vectorRegister(operands[2]);
    if (!dst?.arrangement || !BITWISE_INSERT_ARRANGEMENTS.has(dst.arrangement)) return null;
    if (source?.arrangement !== dst.arrangement || mask?.arrangement !== dst.arrangement) return null;
    if (standardC) {
      const core = `((${dst.name} & ~${mask.name}) | (${source.name} & ${mask.name}))`;
      if (dst.arrangement === '8b') {
        return `${dst.name} = (${core} & (unsigned __int128)0xffffffffffffffffULL);`;
      }
      return `${dst.name} = ${core};`;
    }
    return `${dst.name} = __a64_bit_${dst.arrangement}(${dst.name}, ${source.name}, ${mask.name});`;
  }

  // UZP1/UZP2/ZIP1/ZIP2: NEON permute over matching valid vector arrangements.
  if (mnemonic === 'uzp1' || mnemonic === 'uzp2' || mnemonic === 'zip1' || mnemonic === 'zip2') {
    if (operands.length !== 3) return null;
    const dst = vectorRegister(operands[0]);
    const src1 = vectorRegister(operands[1]);
    const src2 = vectorRegister(operands[2]);
    if (!dst?.arrangement || !ARRANGEMENT_LAYOUT[dst.arrangement]) return null;
    if (src1?.arrangement !== dst.arrangement || src2?.arrangement !== dst.arrangement) return null;
    if (standardC) {
      const expr = lowerPermuteCExpr(mnemonic, src1.name, src2.name, dst.arrangement);
      if (expr) return `${dst.name} = ${expr};`;
    }
    return `${dst.name} = __a64_${mnemonic}_${dst.arrangement}(${src1.name}, ${src2.name});`;
  }

  // ADDV: add across vector, reducing every lane into the low element of one
  // scalar SIMD register. The scalar view is the low bits of the same physical
  // register the renderer names `vN`.
  if (mnemonic === 'addv') {
    if (operands.length !== 2) return null;
    const dst = scalarFpRegister(operands[0]);
    const src = vectorRegister(operands[1]);
    if (!dst || !src?.arrangement) return null;
    if (ADDV_DESTINATION_ELEMENT_BITS[src.arrangement] !== dst.elementBits) return null;
    if (standardC) {
      const expr = lowerAddvCExpr(src.name, src.arrangement);
      if (expr) return `${dst.name} = ${expr}; /* __a64_addv_${src.arrangement} */`;
    }
    return `${dst.name} = __a64_addv_${src.arrangement}(${src.name});`;
  }

  return null;
}

const A64_FLAG_SETTING_MNEMONICS = new Set([
  'adds', 'subs', 'ands', 'bics', 'adcs', 'sbcs', 'negs', 'ngcs',
  'cmp', 'cmn', 'tst', 'ccmp', 'ccmn', 'fcmp', 'fcmpe', 'fccmp', 'fccmpe',
  'cfinv', 'rmif', 'setf8', 'setf16', 'axflag', 'xaflag',
]);
const A64_CALL_OR_TRAP_MNEMONICS = new Set(['bl', 'blr', 'svc', 'hvc', 'smc', 'brk']);
const C_CALL_PATTERN = /(?<![A-Za-z0-9_])(?!if\b|while\b|for\b|switch\b|return\b|sizeof\b|typeof\b|__asm\b)[A-Za-z_][A-Za-z0-9_]*\s*\(/;

function cLineWrittenRegKeys(trimmed) {
  if (!trimmed || trimmed.startsWith('/*') || trimmed.startsWith('//')) return [];
  const out = [];
  const assignMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:[+\-*/%&|^]|<<|>>)?=(?!=)/.exec(trimmed);
  if (assignMatch) {
    const key = registerFamilyKey(assignMatch[1]);
    if (key) out.push(key);
  }
  const incDecMatch = /^(?:\+\+|--)\s*([A-Za-z_][A-Za-z0-9_]*)|^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\+\+|--)/.exec(trimmed);
  if (incDecMatch) {
    const key = registerFamilyKey(incDecMatch[1] || incDecMatch[2]);
    if (key) out.push(key);
  }
  return out;
}

function asmWrittenRegKey(payload) {
  const sp = payload.indexOf(' ');
  if (sp < 0) return null;
  const mn = payload.slice(0, sp).toLowerCase();
  if (/^(?:st|b\b|cb|tb|cmp|cmn|tst|fcmp|fcmpe|fccmp|fccmpe|ccmp|ccmn|bl|blr|br|ret)/i.test(mn)) return null;
  const ops = splitOperands(payload.slice(sp + 1));
  return ops.length ? registerFamilyKey(ops[0]) : null;
}

function cmpReferencesAnyReg(cmpCtx, regKeys) {
  if (!cmpCtx || !regKeys?.length) return false;
  const refs = cmpCtxRegs(cmpCtx);
  return regKeys.some((k) => refs.includes(k));
}

export function lowerArm64RawAssembly(result, options = {}) {
  if (!result?.lines?.length) return result;
  const standardC = typeof options?.standardC === 'boolean'
    ? options.standardC
    : result.lines.some((item) => item?.kind === 'sig');
  const canonicalGpNames = typeof options?.canonicalGpNames === 'boolean'
    ? options.canonicalGpNames
    : Boolean(result?.ir);
  let lowered = 0;
  let lastCmp = null;
  for (const line of result.lines) {
    if (!line || typeof line.text !== 'string') continue;
    if (!line.source && line.row != null && /^goto\s+loc_[0-9a-f]+;$/i.test(line.text.trim())) {
      line.source = sourceOf({
        address:line.addr ?? null,
        row:line.row,
        evidence:[{ reason:'residual compatibility control-flow edge' }],
      });
    }
    const trimmed = line.text.trim();
    const payload = asmPayload(line.text);
    const cmp = parseComparisonContext(trimmed, canonicalGpNames);
    if (cmp) {
      lastCmp = cmp;
    } else if (/^(?:loc_[0-9a-f]+:|return\b|goto\b|if\b|else\b|while\b|for\b|switch\b|\{|\})/i.test(trimmed)) {
      lastCmp = null;
    } else if (!payload && lastCmp) {
      if (!trimmed.startsWith('/*') && !trimmed.startsWith('//') && C_CALL_PATTERN.test(trimmed)) {
        lastCmp = null;
      } else if (cmpReferencesAnyReg(lastCmp, cLineWrittenRegKeys(trimmed))) {
        lastCmp = null;
      }
    }
    if (!payload) continue;
    const sp = payload.indexOf(' ');
    const mn = (sp < 0 ? payload : payload.slice(0, sp)).toLowerCase();
    if (A64_CALL_OR_TRAP_MNEMONICS.has(mn) || (mn === 'msr' && /^msr\s+nzcv\b/i.test(payload))) {
      lastCmp = null;
    }
    const semantic = lowerOne(payload, { standardC, cmpCtx: lastCmp, canonicalGpNames });
    if (!semantic) {
      if (!cmp && A64_FLAG_SETTING_MNEMONICS.has(mn)) {
        lastCmp = null;
      } else if (lastCmp) {
        const wKey = asmWrittenRegKey(payload);
        if (wKey && cmpReferencesAnyReg(lastCmp, [wKey])) lastCmp = null;
      }
      continue;
    }
    if (mn === 'fccmp') {
      const ops = splitOperands(payload.slice(sp + 1));
      const guardCond = ops.length === 4 ? canonicalConditionToken(ops[3]) : null;
      const nzcv = ops.length === 4 ? parseImm(ops[2]) : null;
      if (lastCmp && guardCond && guardCond !== 'al' && guardCond !== 'nv'
          && nzcv != null && nzcv >= 0 && nzcv <= 15
          && /^[sd]\d+$/i.test(ops[0]) && /^[sd]\d+$/i.test(ops[1])) {
        const guardExpr = conditionExprFromContext(guardCond, lastCmp);
        if (guardExpr) {
          const fcmp = { kind: 'fcmp', lhs: ops[0], rhs: ops[1], bits: ops[0][0].toLowerCase() === 's' ? 32 : 64 };
          const regs = [...new Set([...cmpCtxRegs(lastCmp), ...cmpCtxRegs(fcmp)])];
          lastCmp = { kind: 'fccmp', guardExpr, fcmp, nzcv, regs };
        } else {
          lastCmp = null;
        }
      } else {
        lastCmp = null;
      }
    } else if (lastCmp) {
      const wKey = asmWrittenRegKey(payload);
      if (wKey && cmpReferencesAnyReg(lastCmp, [wKey])) lastCmp = null;
    }
    line.text = semantic;
    line.note = line.note || 'Exact ARM64 instruction semantics lowered from the raw fallback.';
    lowered++;
  }
  if (!lowered) return result;
  result.pseudocode = renderedText(result.lines);
  result.ctx = { ...(result.ctx || {}), exactArm64FallbackLowerings: (result.ctx?.exactArm64FallbackLowerings || 0) + lowered };
  // Lowering can introduce new names (register destinations, intrinsic calls).
  // Close the C output again so the newly visible storage is declared too.
  return closeFunctionOutput(result, {
    ...(options?.context !== undefined ? { context: options.context } : {}),
    ...(options?.binary !== undefined ? { binary: options.binary } : {}),
    ...(options?.image !== undefined ? { image: options.image } : {}),
    ...(options?.model !== undefined ? { model: options.model } : {}),
    ...(options?.sections !== undefined ? { sections: options.sections } : {}),
    ...(options?.segments !== undefined ? { segments: options.segments } : {}),
    ...(options?.regions !== undefined ? { regions: options.regions } : {}),
    ...(options?.relocations !== undefined ? { relocations: options.relocations } : {}),
    ...(options?.fileBytes !== undefined ? { fileBytes: options.fileBytes } : {}),
    ...(options?.bytes !== undefined ? { bytes: options.bytes } : {}),
    ...(options?.readBytes !== undefined ? { readBytes: options.readBytes } : {}),
    ...(options?.readByte !== undefined ? { readByte: options.readByte } : {}),
    ...(options?.byteAt !== undefined ? { byteAt: options.byteAt } : {}),
    ...(options?.stringFor !== undefined ? { stringFor: options.stringFor } : {}),
    ...(options?.addressRefs !== undefined ? { addressRefs: options.addressRefs } : {}),
    render: renderedText,
    onLinesChanged: (closed) => {
      // The line array changed after the facade already published its
      // index-keyed map; refresh it (keeping the observed snapshot identity)
      // instead of leaving entity keys bound to the pre-closure indices.
      const previous = closed.renderProvenance ?? null;
      if (!previous) return;
      try {
        closed.renderProvenance = buildRenderProvenance({
          result: closed,
          snapshotId: previous.snapshotId ?? null,
          budget: previous.budget ?? null,
        });
      } catch {
        closed.renderProvenance = previous;
      }
    },
  });
}
