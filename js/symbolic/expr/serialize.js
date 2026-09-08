/**
 * js/symbolic/expr/serialize.js
 *
 * Deterministic canonical serialization and deserialization for Expr DAGs.
 * Enforces stable schema versions, sorted object keys, and exact BigInt hex representations.
 */

import {
  SORT_KIND,
  EXPR_KIND,
  boolSort,
  bvSort,
} from './kinds.js';
import {
  createBool,
  createBv,
  createFreshSymbol,
  restoreFreshSymbol,
  createUnknownSemantic,
  createUnary,
  createBinary,
  createCompare,
  createConnectiveFromArgs,
  createIte,
  createExtract,
  createConcat,
  createCast,
} from './factory.js';

export const EXPR_SCHEMA_VERSION = '1.0.0';
export const EXPR_DAG_VERSION = '1.0.0';

export function canonicalizeObject(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalizeObject);
  }
  const sorted = Object.create(null);
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalizeObject(obj[key]);
  }
  return sorted;
}

export function exprToPlain(node) {
  if (!node) return null;
  const base = {
    kind: node.kind,
    sort: node.sort.kind === SORT_KIND.BOOL ? { kind: 'bool' } : { kind: 'bv', width: node.sort.width },
  };

  switch (node.kind) {
    case EXPR_KIND.CONST:
      return {
        ...base,
        value: typeof node.value === 'bigint' ? `0x${node.value.toString(16)}` : node.value,
      };

    case EXPR_KIND.FRESH_SYMBOL:
      return {
        ...base,
        name: node.name,
        symbolId: node.symbolId,
        meta: node.meta && Object.keys(node.meta).length ? node.meta : undefined,
      };

    case EXPR_KIND.UNKNOWN_SEMANTIC:
      return {
        ...base,
        reason: node.reason,
        detail: node.detail ?? undefined,
      };

    case EXPR_KIND.UNARY:
      return {
        ...base,
        op: node.op,
        arg: exprToPlain(node.arg),
      };

    case EXPR_KIND.BINARY:
      return {
        ...base,
        op: node.op,
        left: exprToPlain(node.left),
        right: exprToPlain(node.right),
      };

    case EXPR_KIND.COMPARE:
      return {
        ...base,
        op: node.op,
        left: exprToPlain(node.left),
        right: exprToPlain(node.right),
      };

    case EXPR_KIND.CONNECTIVE:
      return {
        ...base,
        op: node.op,
        args: node.args.map(exprToPlain),
      };

    case EXPR_KIND.ITE:
      return {
        ...base,
        cond: exprToPlain(node.cond),
        thenExpr: exprToPlain(node.thenExpr),
        elseExpr: exprToPlain(node.elseExpr),
      };

    case EXPR_KIND.EXTRACT:
      return {
        ...base,
        high: node.high,
        low: node.low,
        arg: exprToPlain(node.arg),
      };

    case EXPR_KIND.CONCAT:
      return {
        ...base,
        left: exprToPlain(node.left),
        right: exprToPlain(node.right),
      };

    case EXPR_KIND.CAST:
      return {
        ...base,
        op: node.op,
        targetWidth: node.targetWidth,
        arg: exprToPlain(node.arg),
      };

    default:
      throw new TypeError(`exprToPlain: unknown node kind '${node.kind}'`);
  }
}

function sortFromPlain(plain) {
  return plain.sort.kind === 'bool' ? boolSort() : bvSort(plain.sort.width);
}

/*
 * A legacy blank/missing symbol id needs a new allocation, but a canonical id
 * may appear later in the same serialized tree. Reserve every canonical id
 * first so traversal order cannot mint a replacement that collides with an id
 * already present in the payload.
 */
function sortKey(sort) {
  return sort.kind === SORT_KIND.BOOL ? 'bool' : `bv:${sort.width}`;
}

/*
 * Fresh symbols bind to solver environments by symbolId, so one deserialize
 * operation must never produce two nodes sharing a symbolId with divergent
 * declarations. The same id may legitimately reappear (DAG sharing), but only
 * with an identical name and sort; anything else would split structural
 * identity from binding identity and is rejected as malformed.
 */
function assertConsistentFreshSymbolDeclaration(seen, plain) {
  const symbolId = typeof plain.symbolId === 'string' ? plain.symbolId : null;
  if (symbolId == null || symbolId.trim() === '') return;
  const declaration = { name: plain.name, sort: sortKey(sortFromPlain(plain)) };
  const existing = seen.get(symbolId);
  if (existing) {
    if (existing.name !== declaration.name || existing.sort !== declaration.sort) {
      throw new TypeError(
        `plainToExpr: conflicting fresh symbol declaration for symbolId '${symbolId}'`
        + ` (${existing.name}/${existing.sort} vs ${declaration.name}/${declaration.sort})`,
      );
    }
    return;
  }
  seen.set(symbolId, declaration);
}

// Deserialization is an untrusted-input boundary: the DAG walker must run
// inside an explicit depth/node budget instead of relying on the native call
// stack, so oversized inputs fail as domain errors rather than synchronous
// RangeErrors (#5489).
export const EXPR_DAG_MAX_DEPTH = 1024;
export const EXPR_DAG_MAX_NODES = 1_048_576;

function dagBudgetGuard(plain, depth, budget) {
  if (depth > EXPR_DAG_MAX_DEPTH) {
    throw new TypeError(`plainToExpr: expression DAG depth budget exceeded (>${EXPR_DAG_MAX_DEPTH})`);
  }
  budget.nodes += 1;
  if (budget.nodes > EXPR_DAG_MAX_NODES) {
    throw new TypeError(`plainToExpr: expression DAG node budget exceeded (>${EXPR_DAG_MAX_NODES})`);
  }
}

function reserveCanonicalFreshSymbolIds(plain, seen = new Map(), depth = 0, budget = { nodes: 0 }) {
  if (!plain || typeof plain !== 'object') return;
  dagBudgetGuard(plain, depth, budget);
  switch (plain.kind) {
    case EXPR_KIND.FRESH_SYMBOL:
      assertConsistentFreshSymbolDeclaration(seen, plain);
      if (typeof plain.symbolId === 'string' && plain.symbolId.trim() !== '') {
        restoreFreshSymbol(sortFromPlain(plain), plain.name, plain.symbolId, plain.meta || {});
      }
      return;
    case EXPR_KIND.UNARY:
    case EXPR_KIND.EXTRACT:
    case EXPR_KIND.CAST:
      reserveCanonicalFreshSymbolIds(plain.arg, seen, depth + 1, budget);
      return;
    case EXPR_KIND.BINARY:
    case EXPR_KIND.COMPARE:
    case EXPR_KIND.CONCAT:
      reserveCanonicalFreshSymbolIds(plain.left, seen, depth + 1, budget);
      reserveCanonicalFreshSymbolIds(plain.right, seen, depth + 1, budget);
      return;
    case EXPR_KIND.CONNECTIVE:
      for (const arg of plain.args || []) reserveCanonicalFreshSymbolIds(arg, seen, depth + 1, budget);
      return;
    case EXPR_KIND.ITE:
      reserveCanonicalFreshSymbolIds(plain.cond, seen, depth + 1, budget);
      reserveCanonicalFreshSymbolIds(plain.thenExpr, seen, depth + 1, budget);
      reserveCanonicalFreshSymbolIds(plain.elseExpr, seen, depth + 1, budget);
      return;
    default:
      return;
  }
}

function plainNodeToExpr(plain, depth = 0, budget = { nodes: 0 }) {
  if (!plain) return null;
  dagBudgetGuard(plain, depth, budget);
  const sort = sortFromPlain(plain);

  switch (plain.kind) {
    case EXPR_KIND.CONST:
      if (sort.kind === SORT_KIND.BOOL) {
        if (typeof plain.value !== 'boolean') {
          throw new TypeError(`deserializeExprDag: Bool const value must be a boolean, got ${typeof plain.value}`);
        }
        return createBool(plain.value);
      }
      if (typeof plain.value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(plain.value)) {
        throw new TypeError(`deserializeExprDag: BV const value must be a canonical hex string starting with 0x, got ${JSON.stringify(plain.value)}`);
      }
      {
        const value = createBv(sort.width, BigInt(plain.value));
        if (plain.value !== `0x${value.value.toString(16)}`) {
          throw new TypeError(`deserializeExprDag: BV const value must be a canonical hex string starting with 0x, got ${JSON.stringify(plain.value)}`);
        }
        return value;
      }

    case EXPR_KIND.FRESH_SYMBOL:
      // Restore the saved canonical symbolId. Discarding a present malformed ID
      // would silently rebind the serialized symbol to a fresh identity. Only
      // legacy payloads where the ID is missing or a blank string may allocate
      // a replacement.
      if (plain.symbolId == null && !Object.prototype.hasOwnProperty.call(plain, 'symbolId')) {
        return createFreshSymbol(sort, plain.name, plain.meta || {});
      }
      if (typeof plain.symbolId === 'string' && plain.symbolId.trim() === '') {
        return createFreshSymbol(sort, plain.name, plain.meta || {});
      }
      if (typeof plain.symbolId !== 'string') {
        throw new TypeError('plainToExpr: fresh symbolId must be a string when present');
      }
      return restoreFreshSymbol(sort, plain.name, plain.symbolId, plain.meta || {});

    case EXPR_KIND.UNKNOWN_SEMANTIC:
      return createUnknownSemantic(sort, plain.reason, plain.detail);

    case EXPR_KIND.UNARY:
      return createUnary(plain.op, plainNodeToExpr(plain.arg, depth + 1, budget));

    case EXPR_KIND.BINARY:
      return createBinary(plain.op, plainNodeToExpr(plain.left, depth + 1, budget), plainNodeToExpr(plain.right, depth + 1, budget));

    case EXPR_KIND.COMPARE:
      return createCompare(plain.op, plainNodeToExpr(plain.left, depth + 1, budget), plainNodeToExpr(plain.right, depth + 1, budget));

    case EXPR_KIND.CONNECTIVE:
      return createConnectiveFromArgs(plain.op, plain.args.map((arg) => plainNodeToExpr(arg, depth + 1, budget)));

    case EXPR_KIND.ITE:
      return createIte(plainNodeToExpr(plain.cond, depth + 1, budget), plainNodeToExpr(plain.thenExpr, depth + 1, budget), plainNodeToExpr(plain.elseExpr, depth + 1, budget));

    case EXPR_KIND.EXTRACT:
      return createExtract(plainNodeToExpr(plain.arg, depth + 1, budget), plain.high, plain.low);

    case EXPR_KIND.CONCAT:
      return createConcat(plainNodeToExpr(plain.left, depth + 1, budget), plainNodeToExpr(plain.right, depth + 1, budget));

    case EXPR_KIND.CAST:
      return createCast(plain.op, plainNodeToExpr(plain.arg, depth + 1, budget), plain.targetWidth);

    default:
      throw new TypeError(`plainToExpr: unknown plain node kind '${plain.kind}'`);
  }
}

export function plainToExpr(plain) {
  // The symbol-reservation pass and materialization pass are two traversals of
  // the same logical DAG. Keep independent work counters so the public node
  // budget describes input nodes rather than being consumed twice (#5489).
  const reserveBudget = { nodes: 0 };
  reserveCanonicalFreshSymbolIds(plain, new Map(), 0, reserveBudget);
  const materializeBudget = { nodes: 0 };
  return plainNodeToExpr(plain, 0, materializeBudget);
}

export function serializeExprDag(node, options = {}) {
  const payload = {
    schemaVersion: EXPR_SCHEMA_VERSION,
    expressionDagVersion: EXPR_DAG_VERSION,
    metadata: options.metadata || {},
    root: exprToPlain(node),
  };
  const canonical = canonicalizeObject(payload);
  return JSON.stringify(canonical);
}

// Iterative pre-parse scan: the native JSON parser itself recurses per
// nesting level, so a deeply nested JSON text would throw a raw RangeError
// from inside JSON.parse before the DAG budget guard can reject it (#5489).
function assertExprDagJsonDepthBudget(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') {
      depth += 1;
      if (depth > EXPR_DAG_MAX_DEPTH) {
        throw new TypeError(`deserializeExprDag: expression DAG JSON depth budget exceeded (>${EXPR_DAG_MAX_DEPTH})`);
      }
    } else if (char === '}' || char === ']') depth -= 1;
  }
}

export function deserializeExprDag(jsonOrObject) {
  if (typeof jsonOrObject === 'string') {
    assertExprDagJsonDepthBudget(jsonOrObject);
  }
  const obj = typeof jsonOrObject === 'string' ? JSON.parse(jsonOrObject) : jsonOrObject;
  if (!obj || typeof obj !== 'object') {
    throw new TypeError('deserializeExprDag: input must be a valid serialized DAG object or JSON');
  }
  if (obj.schemaVersion !== EXPR_SCHEMA_VERSION) {
    throw new Error(`deserializeExprDag: incompatible schema version ${obj.schemaVersion}, expected ${EXPR_SCHEMA_VERSION}`);
  }
  if (obj.expressionDagVersion !== EXPR_DAG_VERSION) {
    throw new Error(`deserializeExprDag: incompatible expression DAG version ${obj.expressionDagVersion}, expected ${EXPR_DAG_VERSION}`);
  }
  return plainToExpr(obj.root);
}
