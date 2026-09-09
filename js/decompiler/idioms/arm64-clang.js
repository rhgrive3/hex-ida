import { expr, sameExpr, isPure } from '../ast/nodes.js';

/* These recognizers operate on semantic expressions, not instruction adjacency. */
export function recoverArm64ClangIdiom(root) {
  if (!root) return root;
  if (root.kind === 'binary' && root.op === 'sub' && root.left?.kind === 'binary' && root.left.op === 'mul' && isPure(root.left)) {
    return expr.intrinsic('msub', [root.left.left, root.left.right, root.right], root.bits, root.signed, root.source);
  }
  if (root.kind === 'binary' && root.op === 'add' && root.left?.kind === 'binary' && root.left.op === 'mul' && isPure(root.left)) {
    return expr.intrinsic('madd', [root.left.left, root.left.right, root.right], root.bits, root.signed, root.source);
  }
  if (root.kind === 'binary' && root.op === 'and' && root.left?.kind === 'binary' && root.left.op === 'lshr' && root.right?.kind === 'const') {
    const mask = root.right.value;
    if (mask >= 0n && (mask & (mask + 1n)) === 0n && root.left.right?.kind === 'const') {
      let width = 0n; for (let x = mask; x; x >>= 1n) width++;
      return expr.intrinsic('bit_extract', [root.left.left, root.left.right, expr.constant(width, root.bits)], Number(width || 1n), false, root.source);
    }
  }
  // Clang lowers max(x, 0) for signed integers to:
  //   bic w0, w0, w0, asr #31
  // i.e. x & ~(x >>s (bits-1)). Keep the exact bitvector shape until this
  // proof point so negative values and INT_MIN retain correct two's-complement semantics.
  if (root.kind === 'binary' && root.op === 'and' && root.right?.kind === 'unary' && root.right.op === 'not') {
    const shifted = root.right.arg;
    if (shifted?.kind === 'binary' && shifted.op === 'ashr' && shifted.right?.kind === 'const'
        && shifted.right.value === BigInt((root.bits || 64) - 1) && sameExpr(root.left, shifted.left) && isPure(root.left)) {
      return expr.intrinsic('max', [root.left, expr.constant(0, root.bits, true)], root.bits, true, root.source, { proof: 'clang-bic-sign-mask' });
    }
  }
  return root;
}

export function recognizeDivisionByConstant(root) {
  if (!root || root.kind !== 'binary') return null;
  if ((root.op === 'sdiv' || root.op === 'udiv') && root.right?.kind === 'const') return { kind: 'division-constant', divisor: root.right.value, signed: root.op === 'sdiv' };
  if ((root.op === 'smod' || root.op === 'umod') && root.right?.kind === 'const') return { kind: 'modulo-constant', divisor: root.right.value, signed: root.op === 'smod' };
  return null;
}

function orderedConstantBound(innerBound, outerBound, outerName) {
  if (innerBound?.kind !== 'const' || outerBound?.kind !== 'const') return false;
  if (typeof innerBound.value !== 'bigint' || typeof outerBound.value !== 'bigint') return false;
  if (innerBound.bits !== outerBound.bits || innerBound.signed !== outerBound.signed) return false;
  return outerName === 'min'
    ? innerBound.value <= outerBound.value
    : outerBound.value <= innerBound.value;
}

export function recognizeClamp(root) {
  if (root?.kind !== 'intrinsic' || !['min','max'].includes(root.name) || root.args?.length !== 2) return null;
  const opposing = root.args.filter((a) => a?.kind === 'intrinsic' && ['min','max'].includes(a.name) && a.name !== root.name);
  if (opposing.length !== 1) return null;
  const other = opposing[0];
  if (other.args?.length !== 2) return null;
  // Historical spelling: the clamped value appears directly in the outer args
  // as well as inside the opposing intrinsic. This is direct structural authority
  // for the value role, so retain the established result.
  const shared = root.args.find((a) => other.args.some((b) => sameExpr(a, b)));
  if (shared) {
    return { kind: 'clamp', value: shared, low: root.name === 'max' ? root.args.find((a) => a !== shared) : other.args.find((a) => a !== shared), high: root.name === 'min' ? root.args.find((a) => a !== shared) : other.args.find((a) => a !== shared) };
  }
  // A nested min/max is commutative, so operand position cannot identify the
  // clamped value. Mint a clamp only when exactly one inner operand is proven to
  // be the ordered constant bound in the same integer domain as the outer bound.
  // Otherwise the value/bound roles are ambiguous and must remain unclassified.
  const outerBound = root.args[0] === other ? root.args[1] : root.args[0];
  if (!outerBound) return null;
  const boundCandidates = other.args.filter((candidate) => orderedConstantBound(candidate, outerBound, root.name));
  if (boundCandidates.length !== 1) return null;
  const innerBound = boundCandidates[0];
  if (sameExpr(innerBound, outerBound)) return null;
  const value = other.args[0] === innerBound ? other.args[1] : other.args[0];
  if (value == null || (value?.kind === 'intrinsic' && ['min','max'].includes(value.name))) return null;
  return {
    kind: 'clamp',
    value,
    low: root.name === 'min' ? innerBound : outerBound,
    high: root.name === 'min' ? outerBound : innerBound,
  };
}
