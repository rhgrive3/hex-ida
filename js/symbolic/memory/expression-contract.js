/**
 * Bounded input validation for the query-local memory/taint consumers.
 * Sort and operator rules are checked with the canonical Expr factories; this is
 * not a solver, evaluator, alias engine, or replacement Expr representation.
 */
import * as E from '../expr/index.js';

export function expressionChildren(node) {
  switch (node?.kind) {
    case 'unary': case 'extract': case 'cast': return [node.arg];
    case 'binary': case 'compare': case 'concat': return [node.left, node.right];
    case 'connective': return node.args;
    case 'ite': return [node.cond, node.thenExpr, node.elseExpr];
    default: return [];
  }
}

function validateNode(node, shapeOnly = false, guard = null) {
  if (!node || typeof node!=='object' || !Object.isFrozen(node)) return 'unsupported-expression';
  if (![Object.prototype, null].includes(Object.getPrototypeOf(node))) return 'non-data-expression';
  // Immutable lookalikes with getters are not canonical scalar data.
  for (const key of ['kind', 'sort', 'value', 'op', 'arg', 'left', 'right', 'args', 'cond', 'thenExpr', 'elseExpr', 'symbolId', 'name', 'high', 'low', 'targetWidth', 'meta', 'reason']) {
    const property = Object.getOwnPropertyDescriptor(node, key);
    if (property && !Object.hasOwn(property, 'value')) return 'expression-accessor';
    if (!property && key in node) return 'expression-inherited-property';
  }
  const sort=node.sort;
  if(!sort || !Object.isFrozen(sort)) return 'unsupported-expression';
  if (![Object.prototype, null].includes(Object.getPrototypeOf(sort))) return 'non-data-sort';
  for(const key of ['kind','width']) {const d=Object.getOwnPropertyDescriptor(sort,key);if(d && !Object.hasOwn(d,'value')) return 'sort-accessor';if(!d && key in sort) return 'sort-inherited-property';}
  if (sort.kind !== 'bool' && sort.kind !== 'bv') return 'unsupported-sort';
  if (sort.kind === 'bv' && (!Number.isSafeInteger(sort.width) || sort.width < 1 || sort.width > 64)) return 'unsupported-width';
  if (node.kind === 'unknown_semantic') {
    if (node.reason != null && (typeof node.reason !== 'string' || node.reason.length > 4096)) return 'non-data-semantic-reason';
    return `unknown-semantic:${node.reason || 'unspecified'}`;
  }
  if (node.kind === 'const' && typeof node.value !== (sort.kind === 'bool' ? 'boolean' : 'bigint')) return 'noncanonical-constant';
  if (['unary','binary','compare','connective','cast'].includes(node.kind) && typeof node.op !== 'string') return 'invalid-expression-operation';
  if (node.kind === 'extract' && (!Number.isSafeInteger(node.high) || !Number.isSafeInteger(node.low))) return 'invalid-extract-expression';
  if (node.kind === 'cast' && !Number.isSafeInteger(node.targetWidth)) return 'invalid-cast-expression';
  if (node.kind === 'fresh_symbol') {
    if (typeof node.symbolId !== 'string' || !node.symbolId || node.symbolId.length > 4096 ||
        typeof node.name !== 'string' || !node.name || node.name.length > 2048) return 'missing-canonical-symbol-id';
    if (node.meta != null) {
      if (typeof node.meta !== 'object' || !Object.isFrozen(node.meta) || ![Object.prototype, null].includes(Object.getPrototypeOf(node.meta))) return 'non-data-expression-metadata';
      const source = Object.getOwnPropertyDescriptor(node.meta, 'source');
      if (source && !Object.hasOwn(source, 'value') || !source && 'source' in node.meta) return 'expression-metadata-accessor';
    }
  }
  if (node.kind === 'connective') {
    if (!Array.isArray(node.args) || !Object.isFrozen(node.args) || node.args.length > 4096 ||
        Object.getPrototypeOf(node.args) !== Array.prototype || Object.hasOwn(node.args, Symbol.iterator)) return 'connective-arity-budget';
    guard?.take('workItems', node.args.length);
    for (let index = 0; index < node.args.length; index++) {
      const item = Object.getOwnPropertyDescriptor(node.args, String(index));
      if (!item || !Object.hasOwn(item, 'value')) return 'expression-operand-accessor';
    }
  }
  if (shapeOnly) return ['const','fresh_symbol','unary','binary','compare','connective','ite','extract','concat','cast'].includes(node.kind) ? null : 'unsupported-expression-kind';
  let canonical;
  try {
    switch (node.kind) {
      case 'const':
        canonical = sort.kind === 'bool' ? E.createBool(node.value) : E.createBv(sort.width, node.value);
        if (canonical.value !== node.value) return 'noncanonical-constant';
        break;
      case 'fresh_symbol':
        if (typeof node.symbolId !== 'string' || !node.symbolId || node.symbolId.length > 4096 ||
            typeof node.name !== 'string' || !node.name || node.name.length > 2048) return 'missing-canonical-symbol-id';
        return null;
      case 'unary': canonical = E.createUnary(node.op, node.arg); break;
      case 'binary': canonical = E.createBinary(node.op, node.left, node.right); break;
      case 'compare': canonical = E.createCompare(node.op, node.left, node.right); break;
      case 'connective':
        if (!Array.isArray(node.args) || !Object.isFrozen(node.args) || node.args.length > 4096) return 'connective-arity-budget';
        canonical = E.createConnective(node.op, ...node.args);
        break;
      case 'ite': canonical = E.createIte(node.cond, node.thenExpr, node.elseExpr); break;
      case 'extract': canonical = E.createExtract(node.arg, node.high, node.low); break;
      case 'concat': canonical = E.createConcat(node.left, node.right); break;
      case 'cast': canonical = E.createCast(node.op, node.arg, node.targetWidth); break;
      default: return 'unsupported-expression-kind';
    }
  } catch (error) {
    if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
    return `invalid-${node.kind}-expression`;
  }
  return E.sameSort(canonical.sort, sort) ? null : 'expression-sort-mismatch';
}

/** Inspect a finite immutable DAG without recursive or exponential traversal. */
export function inspectMemoryExpressions(roots, { maxExprNodes = 100000, maxExprDepth = 128, guard = null } = {}) {
  if (!Array.isArray(roots) || !Number.isSafeInteger(maxExprNodes) || maxExprNodes < 0 ||
      !Number.isSafeInteger(maxExprDepth) || maxExprDepth < 0) throw new TypeError('invalid expression inspection budget');
  const marks = new Map(), heights = new Map(), symbols = new Map();
  let traversalCount = 0, unsupportedReason = null, limitExceeded = false, depthExceeded = false;
  const stack = [];
  const charge = (allocation = 0) => {
    if (traversalCount >= maxExprNodes) { limitExceeded = true; return false; }
    guard?.take('workItems');
    if (allocation && guard?.limits.allocationUnits != null) guard.take('allocationUnits', allocation);
    traversalCount++;
    return true;
  };
  if (roots.length > maxExprNodes) limitExceeded = true;
  if (!limitExceeded) for (let i = roots.length - 1; i >= 0; i--) {
    if (!charge(1)) break;
    stack.push({ node: roots[i], finish: false });
  }
  while (stack.length && !limitExceeded && !unsupportedReason && !depthExceeded) {
    if (!charge()) break;
    const { node, finish } = stack.pop();
    if (finish) {
      // Factories inspect child sorts. Invoke them only after the children have
      // been validated as immutable data, never before visiting a nested getter.
      unsupportedReason = validateNode(node, false, guard);
      if (unsupportedReason) break;
      let height = 1;
      for (const child of expressionChildren(node)) height = Math.max(height, 1 + heights.get(child));
      heights.set(node, height); marks.set(node, 'done');
      if (height > maxExprDepth) depthExceeded = true;
      continue;
    }
    if (marks.get(node) === 'done') continue;
    if (marks.get(node) === 'active') { unsupportedReason = 'expression-cycle'; break; }
    // Validate before following any operands; charge its bounded allocation first.
    if (!charge(1)) break;
    unsupportedReason = validateNode(node, true, guard);
    if (unsupportedReason) break;
    marks.set(node, 'active');
    if (node.kind === 'fresh_symbol') {
      const prior = symbols.get(node.symbolId);
      if (prior && (!E.sameSort(prior.sort, node.sort) || prior.name !== node.name)) {
        unsupportedReason = 'symbol-sort-or-name-conflict'; break;
      }
      symbols.set(node.symbolId, node);
    }
    const children = expressionChildren(node);
    if (children.length > maxExprNodes - traversalCount) { limitExceeded = true; break; }
    if (!charge(1)) break;
    stack.push({ node, finish: true });
    for (let i = children.length - 1; i >= 0; i--) {
      if (!charge(1)) break;
      stack.push({ node: children[i], finish: false });
    }
  }
  return {
    symbols: [...symbols.values()], nodeCount: marks.size, traversalCount,
    unsupportedReason, limitExceeded, depthExceeded,
  };
}

/** Upper bound for the canonical recursive evaluator on an already validated
 * immutable DAG. This counts potential evaluation visits, not executed work.
 * Shared children are counted per reference without expanding the tree.
 */
export function boundedExpressionEvaluationCost(roots, guard, ceiling = 2000000) {
  const costs = new Map(), stack = roots.map(node => [node, false]);
  while (stack.length) {
    guard.take('workItems');
    const [node, finish] = stack.pop();
    if (costs.has(node)) continue;
    const inner = expressionChildren(node);
    if (finish) {
      let cost = 1;
      for (const child of inner) cost = Math.min(ceiling + 1, cost + costs.get(child));
      costs.set(node, cost);
    } else {
      stack.push([node, true]);
      for (const child of inner) if (!costs.has(child)) stack.push([child, false]);
    }
  }
  return roots.reduce((sum, node) => Math.min(ceiling + 1, sum + costs.get(node)), 0);
}

/** Rebuild a canonical Expr using its owning factories; no alternate semantics. */
export function rebuildCanonicalExpression(node, children) {
  switch (node.kind) {
    case 'const': case 'fresh_symbol': return node;
    case 'unary': return E.createUnary(node.op,children[0]);
    case 'binary': return E.createBinary(node.op,children[0],children[1]);
    case 'compare': return E.createCompare(node.op,children[0],children[1]);
    case 'connective': return E.createConnective(node.op,...children);
    case 'ite': return E.createIte(...children);
    case 'extract': return E.createExtract(children[0],node.high,node.low);
    case 'concat': return E.createConcat(children[0],children[1]);
    case 'cast': return E.createCast(node.op,children[0],node.targetWidth);
    default: throw new TypeError('unsupported canonical expression reconstruction');
  }
}
