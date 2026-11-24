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
import { canonicalizeObject } from './serialize.js';

const hashCache = new WeakMap();

function canonicalDetailJson(detail) {
  if (detail == null) return '';
  return JSON.stringify(canonicalizeObject(detail));
}

function sha256Hex(data) {
  return stableDigest(data);
}

export function computeStructuralHash(node) {
  if (!node) return 'null';
  if (hashCache.has(node)) {
    return hashCache.get(node);
  }
  const colors = new Map();
  const stack = [{ node, expanded: false }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const cur = frame.node;
    if (!cur || hashCache.has(cur)) {
      stack.pop();
      continue;
    }
    if (!frame.expanded) {
      const color = colors.get(cur) || 0;
      if (color === 1) throw new RangeError('symbolic-expr-cycle');
      if (color === 2) { stack.pop(); continue; }
      colors.set(cur, 1);
      frame.expanded = true;
      const children = childExpressions(cur);
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        if (!child || hashCache.has(child)) continue;
        if (colors.get(child) === 1) throw new RangeError('symbolic-expr-cycle');
        if (colors.get(child) !== 2) stack.push({ node: child, expanded: false });
      }
      continue;
    }
    const hashOf = (child) => (child ? hashCache.get(child) : 'null');
    const sortStr = sortToString(cur.sort);
    let canonicalRep = '';
    switch (cur.kind) {
      case EXPR_KIND.CONST:
        canonicalRep = `CONST:${sortStr}:${typeof cur.value === 'bigint' ? '0x' + cur.value.toString(16) : String(cur.value)}`;
        break;
      case EXPR_KIND.FRESH_SYMBOL:
        canonicalRep = `SYM:${sortStr}:${JSON.stringify([cur.symbolId ?? null, cur.name])}`;
        break;
      case EXPR_KIND.UNKNOWN_SEMANTIC:
        canonicalRep = `UNKNOWN:${sortStr}:${cur.reason}:${canonicalDetailJson(cur.detail)}`;
        break;
      case EXPR_KIND.UNARY:
        canonicalRep = `UNARY:${cur.op}:${sortStr}(${hashOf(cur.arg)})`;
        break;
      case EXPR_KIND.BINARY:
        canonicalRep = `BINARY:${cur.op}:${sortStr}(${hashOf(cur.left)},${hashOf(cur.right)})`;
        break;
      case EXPR_KIND.COMPARE:
        canonicalRep = `CMP:${cur.op}(${hashOf(cur.left)},${hashOf(cur.right)})`;
        break;
      case EXPR_KIND.CONNECTIVE: {
        const childHashes = cur.args.map(hashOf).join(',');
        canonicalRep = `CONN:${cur.op}(${childHashes})`;
        break;
      }
      case EXPR_KIND.ITE:
        canonicalRep = `ITE:${sortStr}(${hashOf(cur.cond)},${hashOf(cur.thenExpr)},${hashOf(cur.elseExpr)})`;
        break;
      case EXPR_KIND.EXTRACT:
        canonicalRep = `EXTRACT:${sortStr}[${cur.high}:${cur.low}](${hashOf(cur.arg)})`;
        break;
      case EXPR_KIND.CONCAT:
        canonicalRep = `CONCAT:${sortStr}(${hashOf(cur.left)},${hashOf(cur.right)})`;
        break;
      case EXPR_KIND.CAST:
        canonicalRep = `CAST:${cur.op}:${cur.targetWidth ?? ""}:${sortStr}(${hashOf(cur.arg)})`;
        break;
      default:
        canonicalRep = `GENERIC:${cur.kind}:${sortStr}`;
    }
    hashCache.set(cur, sha256Hex(canonicalRep));
    colors.set(cur, 2);
    stack.pop();
  }
  return hashCache.get(node);
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
      if (ArrayBuffer.isView(frame.value) || frame.value instanceof ArrayBuffer || frame.value instanceof Date) {
        frame.children = [];
      } else {
        try {
          const descriptors = Object.getOwnPropertyDescriptors(frame.value);
          const keys = Reflect.ownKeys(descriptors);
          const children = [];
          for (const key of keys) {
            if (typeof key === 'symbol') return false;
            const descriptor = descriptors[key];
            if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
            if (descriptor.enumerable) children.push(descriptor.value);
          }
          frame.children = children;
        } catch {
          return false;
        }
      }
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
          canonicalRep = `SYM:${sortStr}:${JSON.stringify([node.symbolId ?? null, node.name])}`;
          break;
        case EXPR_KIND.UNKNOWN_SEMANTIC:
          if (!boundedAcyclicValue(node.detail)) return Object.freeze({ ok: false, reason: 'malformed-unknown-detail', nodeCount });
          try { canonicalRep = `UNKNOWN:${sortStr}:${node.reason}:${canonicalDetailJson(node.detail)}`; }
          catch { return Object.freeze({ ok: false, reason: 'malformed-unknown-detail', nodeCount }); }
          break;
        case EXPR_KIND.UNARY: canonicalRep = `UNARY:${node.op}:${sortStr}(${childHashes[0]})`; break;
        case EXPR_KIND.BINARY: canonicalRep = `BINARY:${node.op}:${sortStr}(${childHashes[0]},${childHashes[1]})`; break;
        case EXPR_KIND.COMPARE: canonicalRep = `CMP:${node.op}(${childHashes[0]},${childHashes[1]})`; break;
        case EXPR_KIND.CONNECTIVE: canonicalRep = `CONN:${node.op}(${childHashes.join(',')})`; break;
        case EXPR_KIND.ITE: canonicalRep = `ITE:${sortStr}(${childHashes.join(',')})`; break;
        case EXPR_KIND.EXTRACT: canonicalRep = `EXTRACT:${sortStr}[${node.high}:${node.low}](${childHashes[0]})`; break;
        case EXPR_KIND.CONCAT: canonicalRep = `CONCAT:${sortStr}(${childHashes.join(',')})`; break;
        case EXPR_KIND.CAST: canonicalRep = `CAST:${node.op}:${node.targetWidth ?? ""}:${sortStr}(${childHashes[0]})`; break;
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
  const visited = new WeakMap();
  const stack = [[a, b]];
  while (stack.length > 0) {
    const [left, right] = stack.pop();
    if (left === right) continue;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    let seenRight = visited.get(left);
    if (seenRight?.has(right)) continue;
    if (left.kind !== right.kind) return false;
    if (!sameSort(left.sort, right.sort)) return false;
    if (!seenRight) {
      seenRight = new WeakSet();
      visited.set(left, seenRight);
    }
    seenRight.add(right);
    switch (left.kind) {
      case EXPR_KIND.CONST:
        if (left.value !== right.value) return false;
        break;
      case EXPR_KIND.FRESH_SYMBOL:
        if (left.symbolId != null || right.symbolId != null) {
          if (left.symbolId !== right.symbolId || left.name !== right.name) return false;
        } else if (left.name !== right.name) {
          return false;
        }
        break;
      case EXPR_KIND.UNKNOWN_SEMANTIC:
        if (left.reason !== right.reason || canonicalDetailJson(left.detail) !== canonicalDetailJson(right.detail)) return false;
        break;
      case EXPR_KIND.UNARY:
        if (left.op !== right.op) return false;
        stack.push([left.arg, right.arg]);
        break;
      case EXPR_KIND.BINARY:
      case EXPR_KIND.COMPARE:
        if (left.op !== right.op) return false;
        stack.push([left.right, right.right], [left.left, right.left]);
        break;
      case EXPR_KIND.CONNECTIVE:
        if (left.op !== right.op || left.args.length !== right.args.length) return false;
        for (let i = left.args.length - 1; i >= 0; i--) {
          stack.push([left.args[i], right.args[i]]);
        }
        break;
      case EXPR_KIND.ITE:
        stack.push([left.elseExpr, right.elseExpr], [left.thenExpr, right.thenExpr], [left.cond, right.cond]);
        break;
      case EXPR_KIND.EXTRACT:
        if (left.high !== right.high || left.low !== right.low) return false;
        stack.push([left.arg, right.arg]);
        break;
      case EXPR_KIND.CONCAT:
        stack.push([left.right, right.right], [left.left, right.left]);
        break;
      case EXPR_KIND.CAST:
        if (left.op !== right.op || left.targetWidth !== right.targetWidth) return false;
        stack.push([left.arg, right.arg]);
        break;
      default:
        return false;
    }
  }
  return true;
}
