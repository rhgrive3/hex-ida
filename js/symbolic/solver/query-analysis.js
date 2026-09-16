import { stableDigest } from '../../core/identity/index.js';
import {
  EXPR_KIND,
  SORT_KIND,
  BV_UNARY_OP,
  BV_BINARY_OP,
  BV_COMPARE_OP,
  BOOL_CONNECTIVE_OP,
  CAST_OP,
  isBoolSort,
  isBvSort,
} from '../expr/kinds.js';

function childExpressions(expr) {
  switch (expr?.kind) {
    case EXPR_KIND.UNARY:
    case EXPR_KIND.EXTRACT:
    case EXPR_KIND.CAST: return [expr.arg];
    case EXPR_KIND.BINARY:
    case EXPR_KIND.COMPARE:
    case EXPR_KIND.CONCAT: return [expr.left, expr.right];
    case EXPR_KIND.CONNECTIVE: return Array.isArray(expr.args) ? expr.args : [];
    case EXPR_KIND.ITE: return [expr.cond, expr.thenExpr, expr.elseExpr];
    default: return [];
  }
}

function sameBvSort(left, right) {
  return isBvSort(left?.sort) && isBvSort(right?.sort) && left.sort.width === right.sort.width;
}

function validateExprNode(expr) {
  if (!expr || typeof expr !== 'object' || !Object.values(EXPR_KIND).includes(expr.kind)) return 'unsupported-expression-kind';
  if (!isBoolSort(expr.sort) && !isBvSort(expr.sort)) return 'invalid-expression-sort';
  switch (expr.kind) {
    case EXPR_KIND.CONST:
      if (isBoolSort(expr.sort)) return typeof expr.value === 'boolean' ? null : 'invalid-bool-constant';
      return typeof expr.value === 'bigint' && expr.value >= 0n && expr.value < (1n << BigInt(expr.sort.width))
        ? null : 'invalid-bv-constant';
    case EXPR_KIND.FRESH_SYMBOL:
      return typeof expr.name === 'string' && expr.name && typeof (expr.symbolId || expr.name) === 'string' ? null : 'malformed-symbol';
    case EXPR_KIND.UNKNOWN_SEMANTIC:
      return `unknown-semantic:${expr.reason || 'unspecified'}`;
    case EXPR_KIND.UNARY:
      return Object.values(BV_UNARY_OP).includes(expr.op) && sameBvSort(expr, expr.arg) ? null : 'invalid-unary-expression';
    case EXPR_KIND.BINARY:
      return Object.values(BV_BINARY_OP).includes(expr.op) && sameBvSort(expr.left, expr.right) && sameBvSort(expr, expr.left)
        ? null : 'invalid-binary-expression';
    case EXPR_KIND.COMPARE:
      return Object.values(BV_COMPARE_OP).includes(expr.op) && isBoolSort(expr.sort) && sameBvSort(expr.left, expr.right)
        ? null : 'invalid-compare-expression';
    case EXPR_KIND.CONNECTIVE: {
      if (!Object.values(BOOL_CONNECTIVE_OP).includes(expr.op) || !isBoolSort(expr.sort) || !Array.isArray(expr.args)) return 'invalid-connective-expression';
      if (expr.args.length === 0 || expr.args.some((arg) => !isBoolSort(arg?.sort))) return 'invalid-connective-expression';
      if (expr.op === BOOL_CONNECTIVE_OP.NOT && expr.args.length !== 1) return 'invalid-connective-arity';
      if ([BOOL_CONNECTIVE_OP.IMPLIES, BOOL_CONNECTIVE_OP.EQ, BOOL_CONNECTIVE_OP.NE].includes(expr.op) && expr.args.length !== 2) return 'invalid-connective-arity';
      return null;
    }
    case EXPR_KIND.ITE:
      if (!isBoolSort(expr.cond?.sort)) return 'invalid-ite-expression';
      if (isBoolSort(expr.sort)) return isBoolSort(expr.thenExpr?.sort) && isBoolSort(expr.elseExpr?.sort) ? null : 'invalid-ite-expression';
      return isBvSort(expr.sort) && isBvSort(expr.thenExpr?.sort) && isBvSort(expr.elseExpr?.sort) &&
        expr.sort.width === expr.thenExpr.sort.width && expr.sort.width === expr.elseExpr.sort.width ? null : 'invalid-ite-expression';
    case EXPR_KIND.EXTRACT:
      return isBvSort(expr.arg?.sort) && Number.isSafeInteger(expr.high) && Number.isSafeInteger(expr.low) && expr.low >= 0 && expr.high >= expr.low &&
        expr.high < expr.arg.sort.width && isBvSort(expr.sort) && expr.sort.width === expr.high - expr.low + 1 ? null : 'invalid-extract-expression';
    case EXPR_KIND.CONCAT:
      return isBvSort(expr.left?.sort) && isBvSort(expr.right?.sort) && isBvSort(expr.sort) &&
        expr.sort.width === expr.left.sort.width + expr.right.sort.width ? null : 'invalid-concat-expression';
    case EXPR_KIND.CAST:
      return Object.values(CAST_OP).includes(expr.op) && isBvSort(expr.arg?.sort) && isBvSort(expr.sort) &&
        Number.isSafeInteger(expr.targetWidth) && expr.sort.width === expr.targetWidth &&
        ((expr.op === CAST_OP.TRUNC && expr.targetWidth < expr.arg.sort.width) ||
         ([CAST_OP.ZEXT, CAST_OP.SEXT].includes(expr.op) && expr.targetWidth > expr.arg.sort.width)) ? null : 'invalid-cast-expression';
    default: return 'unsupported-expression-kind';
  }
}

export function analyzeSolverExpressions(expressions, { maxExprNodes = 100000, maxExprDepth = 1024 } = {}) {
  if (!Array.isArray(expressions)) return Object.freeze({ unsupportedReason: 'malformed-expression-roots', symbols: [], nodeCount: 0, maxDepth: 0, maxBvWidth: 0 });
  const symbols = new Map();
  const colors = new WeakMap();
  let nodeCount = 0;
  let maxDepth = 0;
  let maxBvWidth = 0;
  for (const root of expressions) {
    if (!root || typeof root !== 'object') return Object.freeze({ unsupportedReason: 'malformed-expression-node', symbols: [], nodeCount, maxDepth, maxBvWidth });
    if (colors.get(root) === 2) continue;
    const stack = [{ node: root, entered: false, children: null, index: 0 }];
    while (stack.length) {
      if (stack.length > maxExprDepth) return Object.freeze({ depthExceeded: true, symbols: [], nodeCount, maxDepth: stack.length, maxBvWidth });
      maxDepth = Math.max(maxDepth, stack.length);
      const frame = stack[stack.length - 1];
      if (!frame.entered) {
        if (colors.get(frame.node) === 1) return Object.freeze({ unsupportedReason: 'cyclic-expression-dag', symbols: [], nodeCount, maxDepth, maxBvWidth });
        if (colors.get(frame.node) === 2) { stack.pop(); continue; }
        colors.set(frame.node, 1);
        nodeCount++;
        if (nodeCount > maxExprNodes) return Object.freeze({ limitExceeded: true, symbols: [], nodeCount, maxDepth, maxBvWidth });
        const invalid = validateExprNode(frame.node);
        if (invalid) return Object.freeze({ unsupportedReason: invalid, symbols: [], nodeCount, maxDepth, maxBvWidth });
        if (isBvSort(frame.node.sort)) maxBvWidth = Math.max(maxBvWidth, frame.node.sort.width);
        if (frame.node.kind === EXPR_KIND.FRESH_SYMBOL) {
          const key = String(frame.node.symbolId || frame.node.name);
          const existing = symbols.get(key);
          if (existing && stableDigest(existing.sort) !== stableDigest(frame.node.sort)) {
            return Object.freeze({ unsupportedReason: 'symbol-sort-conflict', symbols: [], nodeCount, maxDepth, maxBvWidth });
          }
          symbols.set(key, Object.freeze({ key, name: frame.node.name, symbolId: key, sort: frame.node.sort }));
        }
        frame.children = childExpressions(frame.node);
        frame.entered = true;
      }
      if (frame.index < frame.children.length) {
        const child = frame.children[frame.index++];
        if (!child || typeof child !== 'object') return Object.freeze({ unsupportedReason: 'malformed-expression-node', symbols: [], nodeCount, maxDepth, maxBvWidth });
        if (colors.get(child) === 1) return Object.freeze({ unsupportedReason: 'cyclic-expression-dag', symbols: [], nodeCount, maxDepth, maxBvWidth });
        if (colors.get(child) !== 2) stack.push({ node: child, entered: false, children: null, index: 0 });
        continue;
      }
      colors.set(frame.node, 2);
      stack.pop();
    }
  }
  return Object.freeze({
    symbols: Object.freeze([...symbols.values()].sort((a, b) => a.key.localeCompare(b.key))),
    nodeCount,
    maxDepth,
    maxBvWidth,
    unsupportedReason: null,
    limitExceeded: false,
    depthExceeded: false,
  });
}
