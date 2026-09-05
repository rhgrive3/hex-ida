/**
 * js/symbolic/expr/hash.js
 *
 * Deterministic structural hashing and collision-safe structural equality
 * for solver-neutral Bool/BV expression nodes.
 * Provenance, origin mappings, and UI metadata are strictly excluded from
 * the structural hash.
 */

import { stableDigest } from '../../core/identity/index.js';
import {
  EXPR_KIND,
  sortToString,
  sameSort,
} from './kinds.js';

const hashCache = new WeakMap();

function sha256Hex(data) {
  return stableDigest(data);
}

export function computeStructuralHash(node) {
  if (!node) return 'null';
  if (hashCache.has(node)) {
    return hashCache.get(node);
  }

  let canonicalRep = '';
  const sortStr = sortToString(node.sort);

  switch (node.kind) {
    case EXPR_KIND.CONST:
      canonicalRep = `CONST:${sortStr}:${typeof node.value === 'bigint' ? '0x' + node.value.toString(16) : String(node.value)}`;
      break;

    case EXPR_KIND.FRESH_SYMBOL:
      // Fresh symbols are independent variables even when they share a name;
      // the solver binds them by symbolId, so structural identity must agree
      // with solver binding identity (#3246).
      canonicalRep = `SYM:${sortStr}:${node.symbolId ?? ''}:${node.name ?? ''}`;
      break;

    case EXPR_KIND.UNKNOWN_SEMANTIC:
      canonicalRep = `UNKNOWN:${sortStr}:${node.reason}:${node.detail == null ? '' : stableDigest(node.detail)}`;
      break;

    case EXPR_KIND.UNARY:
      canonicalRep = `UNARY:${node.op}:${sortStr}(${computeStructuralHash(node.arg)})`;
      break;

    case EXPR_KIND.BINARY:
      canonicalRep = `BINARY:${node.op}:${sortStr}(${computeStructuralHash(node.left)},${computeStructuralHash(node.right)})`;
      break;

    case EXPR_KIND.COMPARE:
      canonicalRep = `CMP:${node.op}(${computeStructuralHash(node.left)},${computeStructuralHash(node.right)})`;
      break;

    case EXPR_KIND.CONNECTIVE: {
      const childHashes = node.args.map(computeStructuralHash).join(',');
      canonicalRep = `CONN:${node.op}(${childHashes})`;
      break;
    }

    case EXPR_KIND.ITE:
      canonicalRep = `ITE:${sortStr}(${computeStructuralHash(node.cond)},${computeStructuralHash(node.thenExpr)},${computeStructuralHash(node.elseExpr)})`;
      break;

    case EXPR_KIND.EXTRACT:
      canonicalRep = `EXTRACT:${sortStr}[${node.high}:${node.low}](${computeStructuralHash(node.arg)})`;
      break;

    case EXPR_KIND.CONCAT:
      canonicalRep = `CONCAT:${sortStr}(${computeStructuralHash(node.left)},${computeStructuralHash(node.right)})`;
      break;

    case EXPR_KIND.CAST:
      canonicalRep = `CAST:${node.op}:${sortStr}:${node.targetWidth}(${computeStructuralHash(node.arg)})`;
      break;

    default:
      canonicalRep = `GENERIC:${node.kind}:${sortStr}`;
  }

  const hash = sha256Hex(canonicalRep);
  hashCache.set(node, hash);
  return hash;
}

function childExpressions(node) {
  switch (node?.kind) {
    case EXPR_KIND.UNARY:
    case EXPR_KIND.EXTRACT:
    case EXPR_KIND.CAST: return [node.arg];
    case EXPR_KIND.BINARY:
    case EXPR_KIND.COMPARE:
    case EXPR_KIND.CONCAT: return [node.left, node.right];
    case EXPR_KIND.CONNECTIVE: return Array.isArray(node.args) ? node.args : [];
    case EXPR_KIND.ITE: return [node.cond, node.thenExpr, node.elseExpr];
    default: return [];
  }
}

function boundedAcyclicValue(value, maxNodes = 4096, maxDepth = 64) {
  if (value == null || typeof value !== 'object') return true;
  const colors = new WeakMap();
  let count = 0;
  const stack = [{ value, entered: false, children: null, index: 0, depth: 1 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (!frame.entered) {
      if (colors.get(frame.value) === 1 || frame.depth > maxDepth || ++count > maxNodes) return false;
      if (colors.get(frame.value) === 2) { stack.pop(); continue; }
      colors.set(frame.value, 1);
      if (ArrayBuffer.isView(frame.value) || frame.value instanceof ArrayBuffer || frame.value instanceof Date) frame.children = [];
      else frame.children = Array.isArray(frame.value) ? frame.value : Object.values(frame.value);
      frame.entered = true;
    }
    if (frame.index < frame.children.length) {
      const child = frame.children[frame.index++];
      if (child != null && typeof child === 'object') {
        if (colors.get(child) === 1) return false;
        if (colors.get(child) !== 2) stack.push({ value: child, entered: false, children: null, index: 0, depth: frame.depth + 1 });
      }
      continue;
    }
    colors.set(frame.value, 2);
    stack.pop();
  }
  return true;
}

/**
 * Call-local, iterative structural hashing for untrusted/structured-cloned
 * expression DAGs. It never consults the module cache and stops at maxNodes.
 */
export function computeStructuralHashesBounded(roots, { maxNodes = 100000 } = {}) {
  if (typeof maxNodes !== 'number' || !Number.isSafeInteger(maxNodes) || maxNodes <= 0) {
    return Object.freeze({ ok: false, reason: 'invalid-expression-node-budget', nodeCount: 0 });
  }
  if (!Array.isArray(roots)) return Object.freeze({ ok: false, reason: 'malformed-expression-roots', nodeCount: 0 });

  const colors = new WeakMap();
  const hashes = new WeakMap();
  let nodeCount = 0;
  let traversalCount = 0;
  for (const root of roots) {
    traversalCount++;
    if (traversalCount > maxNodes) return Object.freeze({ ok: false, reason: 'expression-node-budget-exceeded', nodeCount, limitExceeded: true });
    if (!root || typeof root !== 'object') {
      return Object.freeze({ ok: false, reason: 'malformed-expression-node', nodeCount });
    }
    if (hashes.has(root)) continue;
    const stack = [{ node: root, entered: false, children: null, index: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame.entered) {
        if (colors.get(frame.node) === 1) return Object.freeze({ ok: false, reason: 'cyclic-expression-dag', nodeCount });
        if (hashes.has(frame.node)) { stack.pop(); continue; }
        colors.set(frame.node, 1);
        nodeCount++;
        if (nodeCount > maxNodes) {
          return Object.freeze({ ok: false, reason: 'expression-node-budget-exceeded', nodeCount, limitExceeded: true });
        }
        frame.children = childExpressions(frame.node);
        frame.entered = true;
      }
      if (frame.index < frame.children.length) {
        traversalCount++;
        if (traversalCount > maxNodes) return Object.freeze({ ok: false, reason: 'expression-node-budget-exceeded', nodeCount, limitExceeded: true });
        const child = frame.children[frame.index++];
        if (!child || typeof child !== 'object') {
          return Object.freeze({ ok: false, reason: 'malformed-expression-node', nodeCount });
        }
        if (colors.get(child) === 1) return Object.freeze({ ok: false, reason: 'cyclic-expression-dag', nodeCount });
        if (!hashes.has(child)) stack.push({ node: child, entered: false, children: null, index: 0 });
        continue;
      }

      const node = frame.node;
      const sortStr = sortToString(node.sort);
      const childHashes = frame.children.map((child) => hashes.get(child));
      let canonicalRep;
      switch (node.kind) {
        case EXPR_KIND.CONST:
          canonicalRep = `CONST:${sortStr}:${typeof node.value === 'bigint' ? `0x${node.value.toString(16)}` : String(node.value)}`;
          break;
        case EXPR_KIND.FRESH_SYMBOL:
          canonicalRep = `SYM:${sortStr}:${node.symbolId ?? ''}:${node.name ?? ''}`;
          break;
        case EXPR_KIND.UNKNOWN_SEMANTIC:
          if (!boundedAcyclicValue(node.detail)) return Object.freeze({ ok: false, reason: 'malformed-unknown-detail', nodeCount });
          try { canonicalRep = `UNKNOWN:${sortStr}:${node.reason}:${node.detail == null ? '' : stableDigest(node.detail)}`; }
          catch { return Object.freeze({ ok: false, reason: 'malformed-unknown-detail', nodeCount }); }
          break;
        case EXPR_KIND.UNARY: canonicalRep = `UNARY:${node.op}:${sortStr}(${childHashes[0]})`; break;
        case EXPR_KIND.BINARY: canonicalRep = `BINARY:${node.op}:${sortStr}(${childHashes[0]},${childHashes[1]})`; break;
        case EXPR_KIND.COMPARE: canonicalRep = `CMP:${node.op}(${childHashes[0]},${childHashes[1]})`; break;
        case EXPR_KIND.CONNECTIVE: canonicalRep = `CONN:${node.op}(${childHashes.join(',')})`; break;
        case EXPR_KIND.ITE: canonicalRep = `ITE:${sortStr}(${childHashes.join(',')})`; break;
        case EXPR_KIND.EXTRACT: canonicalRep = `EXTRACT:${sortStr}[${node.high}:${node.low}](${childHashes[0]})`; break;
        case EXPR_KIND.CONCAT: canonicalRep = `CONCAT:${sortStr}(${childHashes.join(',')})`; break;
        case EXPR_KIND.CAST: canonicalRep = `CAST:${node.op}:${sortStr}:${node.targetWidth}(${childHashes[0]})`; break;
        default: canonicalRep = `GENERIC:${node.kind}:${sortStr}`;
      }
      hashes.set(node, sha256Hex(canonicalRep));
      colors.set(node, 2);
      stack.pop();
    }
  }
  return Object.freeze({ ok: true, hashes: Object.freeze(roots.map((root) => hashes.get(root))), nodeCount, traversalCount });
}

export function structuralEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (!sameSort(a.sort, b.sort)) return false;

  switch (a.kind) {
    case EXPR_KIND.CONST:
      return a.value === b.value;

    case EXPR_KIND.FRESH_SYMBOL:
      // Structural identity equals solver binding identity: symbolId first,
      // name-only comparison only for legacy nodes without a symbolId.
      if (a.symbolId != null || b.symbolId != null) return a.symbolId === b.symbolId;
      return a.name === b.name;

    case EXPR_KIND.UNKNOWN_SEMANTIC:
      return a.reason === b.reason && JSON.stringify(a.detail) === JSON.stringify(b.detail);

    case EXPR_KIND.UNARY:
      return a.op === b.op && structuralEquals(a.arg, b.arg);

    case EXPR_KIND.BINARY:
      return a.op === b.op && structuralEquals(a.left, b.left) && structuralEquals(a.right, b.right);

    case EXPR_KIND.COMPARE:
      return a.op === b.op && structuralEquals(a.left, b.left) && structuralEquals(a.right, b.right);

    case EXPR_KIND.CONNECTIVE:
      if (a.op !== b.op || a.args.length !== b.args.length) return false;
      for (let i = 0; i < a.args.length; i++) {
        if (!structuralEquals(a.args[i], b.args[i])) return false;
      }
      return true;

    case EXPR_KIND.ITE:
      return (
        structuralEquals(a.cond, b.cond) &&
        structuralEquals(a.thenExpr, b.thenExpr) &&
        structuralEquals(a.elseExpr, b.elseExpr)
      );

    case EXPR_KIND.EXTRACT:
      return a.high === b.high && a.low === b.low && structuralEquals(a.arg, b.arg);

    case EXPR_KIND.CONCAT:
      return structuralEquals(a.left, b.left) && structuralEquals(a.right, b.right);

    case EXPR_KIND.CAST:
      return a.op === b.op && a.targetWidth === b.targetWidth && structuralEquals(a.arg, b.arg);

    default:
      return false;
  }
}
