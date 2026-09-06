import { expr } from './ast/nodes.js';
import { printExpression } from './pretty/c.js';

const CONDITIONS = new Set([
  'eq', 'ne', 'hs', 'cs', 'lo', 'cc', 'mi', 'pl', 'vs', 'vc',
  'hi', 'ls', 'ge', 'lt', 'gt', 'le',
]);
const FLAG_SUBS = new Set(['sub', 'add', 'and', 'fsub']);

const WIDTH_BITS = new Set([8, 16, 32, 64]);

function canonicalProducer(sub) {
  if (typeof sub !== 'string') return null;
  const normalized = sub.toLowerCase();
  return FLAG_SUBS.has(normalized) ? normalized : null;
}

function canonicalCondition(cond) {
  if (typeof cond !== 'string') return null;
  const normalized = cond.toLowerCase();
  return CONDITIONS.has(normalized) ? normalized : null;
}

function canonicalBits(bits, fallback = 64) {
  if (bits === undefined) return fallback;
  if (typeof bits !== 'number' || !Number.isSafeInteger(bits) || bits <= 0 || bits > 64) return null;
  return bits;
}

function canonicalOperandValue(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  return null;
}

function widthOf(bits) {
  const n = Number(bits || 64);
  return Number.isInteger(n) && n > 0 && n <= 64 ? n : 64;
}

function unsignedValue(value, bits) {
  return BigInt.asUintN(widthOf(bits), BigInt(value));
}

function flagsFor(sub, left, right, bits = 64) {
  if (sub === 'fsub') {
    const a=Number(left), b=Number(right);
    if (Number.isNaN(a) || Number.isNaN(b)) return { n:false, z:false, c:true, v:true, result:NaN, bits:widthOf(bits) };
    if (a === b) return { n:false, z:true, c:true, v:false, result:0, bits:widthOf(bits) };
    if (a < b) return { n:true, z:false, c:false, v:false, result:a-b, bits:widthOf(bits) };
    return { n:false, z:false, c:true, v:false, result:a-b, bits:widthOf(bits) };
  }
  bits = widthOf(bits);
  const a = unsignedValue(left, bits);
  const b = unsignedValue(right, bits);
  const sign = 1n << BigInt(bits - 1);
  const mask = (1n << BigInt(bits)) - 1n;
  let result = 0n;
  let c = false;
  let v = false;

  if (sub === 'sub') {
    result = BigInt.asUintN(bits, a - b);
    c = a >= b;
    v = (((a ^ b) & (a ^ result) & sign) !== 0n);
  } else if (sub === 'add') {
    const wide = a + b;
    result = wide & mask;
    c = wide > mask;
    v = (((~(a ^ b)) & (a ^ result) & sign) !== 0n);
  } else if (sub === 'and') {
    result = a & b;
    // AArch64 logical flag-setting operations define C=0 and V=0.
    c = false;
    v = false;
  } else {
    return null;
  }

  return {
    n: (result & sign) !== 0n,
    z: result === 0n,
    c,
    v,
    result,
    bits,
  };
}

export function isNZCVCondition(cond) {
  if (typeof cond !== 'string') return false;
  return CONDITIONS.has(cond.toLowerCase());
}

export function evaluateNZCVCondition(sub, cond, left, right, bits = 64) {
  const producer = canonicalProducer(sub);
  if (producer === null) return null;
  const condition = canonicalCondition(cond);
  if (condition === null) return null;
  if (producer === 'fsub') {
    if (typeof left !== 'number' || typeof right !== 'number') return null;
  } else {
    if (canonicalOperandValue(left) === null || canonicalOperandValue(right) === null) return null;
  }
  const width = canonicalBits(bits);
  if (width === null || !WIDTH_BITS.has(width)) return null;
  const f = flagsFor(producer, left, right, width);
  if (!f || !CONDITIONS.has(condition)) return null;
  switch (condition) {
    case 'eq': return f.z;
    case 'ne': return !f.z;
    case 'hs': case 'cs': return f.c;
    case 'lo': case 'cc': return !f.c;
    case 'mi': return f.n;
    case 'pl': return !f.n;
    case 'vs': return f.v;
    case 'vc': return !f.v;
    case 'hi': return f.c && !f.z;
    case 'ls': return !f.c || f.z;
    case 'ge': return f.n === f.v;
    case 'lt': return f.n !== f.v;
    case 'gt': return !f.z && f.n === f.v;
    case 'le': return f.z || f.n !== f.v;
    default: return null;
  }
}

function withUnsignedWidth(node, bits, source) {
  if (!node) return null;
  bits = widthOf(bits);
  return expr.unary('trunc', node, bits, false, source, { fromBits: Number(node.bits || bits) });
}

function withSignedWidth(node, bits, source) {
  const raw = withUnsignedWidth(node, bits, source);
  return raw ? expr.unary('sext', raw, bits, true, source, { fromBits: bits }) : null;
}

function directCompare(op, left, right, signed, bits, source, comparisonDomain = 'integer') {
  // The AST comparison carries signedness/width semantics. Do not inject
  // redundant textual casts here: recovered fields/locals already have their
  // declared C type, and double-casts make otherwise readable predicates noisy.
  // Architecture-specific cases that cannot be represented by a normal C
  // comparison are retained as explicit NZCV intrinsics below.
  void bits;
  return left && right ? expr.compare(op, left, right, signed, source, { comparisonDomain }) : null;
}

function zero(bits, signed, source) {
  return expr.constant(0n, widthOf(bits), signed, source);
}

function intrinsicCondition(sub, cond, left, right, bits, source) {
  const a = withUnsignedWidth(left, bits, source);
  const b = withUnsignedWidth(right, bits, source);
  if (!a || !b) return null;
  return expr.intrinsic(`__arm64_nzcv_${sub}_${cond}_${widthOf(bits)}`, [a, b], 1, false, source, {
    nzcv: { producer: sub, condition: cond, bits: widthOf(bits) },
  });
}

/**
 * Build an exact source-level condition for an AArch64 integer NZCV producer.
 * When a condition cannot be represented by one ordinary C comparison without
 * losing carry/overflow semantics, retain it as an explicit architecture
 * intrinsic instead of manufacturing a false high-level predicate.
 */
export function buildNZCVConditionExpression(sub, cond, left, right, bits = 64, source = null) {
  const producer = canonicalProducer(sub);
  if (producer === null) return null;
  const condition = canonicalCondition(cond);
  if (condition === null) return null;
  const width = canonicalBits(bits);
  if (width === null || !WIDTH_BITS.has(width)) return null;
  if (!left || !right) return null;
  sub = producer;
  cond = condition;
  bits = width;

  if (sub === 'fsub') {
    switch (cond) {
      case 'eq': return directCompare('eq', left, right, false, bits, source, 'floating');
      case 'ne': return directCompare('ne', left, right, false, bits, source, 'floating');
      case 'mi': case 'lo': case 'cc': return directCompare('lt', left, right, true, bits, source, 'floating');
      case 'ls': return directCompare('le', left, right, true, bits, source, 'floating');
      case 'ge': return directCompare('ge', left, right, true, bits, source, 'floating');
      case 'gt': return directCompare('gt', left, right, true, bits, source, 'floating');
      default: return intrinsicCondition(sub, cond, left, right, bits, source);
    }
  }

  if (sub === 'sub') {
    switch (cond) {
      case 'eq': return directCompare('eq', left, right, false, bits, source);
      case 'ne': return directCompare('ne', left, right, false, bits, source);
      case 'hs': case 'cs': return directCompare('ge', left, right, false, bits, source);
      case 'lo': case 'cc': return directCompare('lt', left, right, false, bits, source);
      case 'hi': return directCompare('gt', left, right, false, bits, source);
      case 'ls': return directCompare('le', left, right, false, bits, source);
      case 'ge': return directCompare('ge', left, right, true, bits, source);
      case 'lt': return directCompare('lt', left, right, true, bits, source);
      case 'gt': return directCompare('gt', left, right, true, bits, source);
      case 'le': return directCompare('le', left, right, true, bits, source);
      default: return intrinsicCondition(sub, cond, left, right, bits, source);
    }
  }

  if (sub === 'and') {
    const a = withUnsignedWidth(left, bits, source);
    const b = withUnsignedWidth(right, bits, source);
    const result = expr.binary('and', a, b, bits, false, source);
    switch (cond) {
      case 'eq': return expr.compare('eq', result, zero(bits, false, source), false, source);
      case 'ne': return expr.compare('ne', result, zero(bits, false, source), false, source);
      case 'hs': case 'cs': case 'hi': case 'vs': return expr.constant(0n, 1, false, source);
      case 'lo': case 'cc': case 'ls': case 'vc': return expr.constant(1n, 1, false, source);
      case 'mi': case 'lt': return expr.compare('lt', withSignedWidth(result, bits, source), zero(bits, true, source), true, source);
      case 'pl': case 'ge': return expr.compare('ge', withSignedWidth(result, bits, source), zero(bits, true, source), true, source);
      case 'gt': return expr.compare('gt', withSignedWidth(result, bits, source), zero(bits, true, source), true, source);
      case 'le': return expr.compare('le', withSignedWidth(result, bits, source), zero(bits, true, source), true, source);
      default: return null;
    }
  }

  // ADD/CMN equality only depends on the wrapped result. Every other useful
  // condition depends on carry and/or overflow (or on N derived from the exact
  // wrapped result). Preserve those flag semantics explicitly.
  if (sub === 'add' && (cond === 'eq' || cond === 'ne')) {
    const a = withUnsignedWidth(left, bits, source);
    const b = withUnsignedWidth(right, bits, source);
    const sum = expr.unary('trunc', expr.binary('add', a, b, bits, false, source), bits, false, source, { fromBits: bits });
    return expr.compare(cond, sum, zero(bits, false, source), false, source);
  }
  return intrinsicCondition(sub, cond, left, right, bits, source);
}

export function renderNZCVCondition(sub, cond, leftText, rightText, bits = 64, source = null) {
  if (typeof leftText !== 'string' || typeof rightText !== 'string') return null;
  const width = canonicalBits(bits);
  if (width === null || !WIDTH_BITS.has(width)) return null;
  const left = expr.variable(leftText, width, null, source);
  const right = expr.variable(rightText, width, null, source);
  const condition = buildNZCVConditionExpression(sub, cond, left, right, width, source);
  return condition ? printExpression(condition) : null;
}
