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
  createConnective,
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

function reserveCanonicalFreshSymbolIds(plain, seen = new Map()) {
  if (!plain || typeof plain !== 'object') return;
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
      reserveCanonicalFreshSymbolIds(plain.arg, seen);
      return;
    case EXPR_KIND.BINARY:
    case EXPR_KIND.COMPARE:
    case EXPR_KIND.CONCAT:
      reserveCanonicalFreshSymbolIds(plain.left, seen);
      reserveCanonicalFreshSymbolIds(plain.right, seen);
      return;
    case EXPR_KIND.CONNECTIVE:
      for (const arg of plain.args || []) reserveCanonicalFreshSymbolIds(arg, seen);
      return;
    case EXPR_KIND.ITE:
      reserveCanonicalFreshSymbolIds(plain.cond, seen);
      reserveCanonicalFreshSymbolIds(plain.thenExpr, seen);
      reserveCanonicalFreshSymbolIds(plain.elseExpr, seen);
      return;
    default:
      return;
  }
}

function plainNodeToExpr(plain) {
  if (!plain) return null;
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
      return createUnary(plain.op, plainNodeToExpr(plain.arg));

    case EXPR_KIND.BINARY:
      return createBinary(plain.op, plainNodeToExpr(plain.left), plainNodeToExpr(plain.right));

    case EXPR_KIND.COMPARE:
      return createCompare(plain.op, plainNodeToExpr(plain.left), plainNodeToExpr(plain.right));

    case EXPR_KIND.CONNECTIVE:
      return createConnective(plain.op, ...plain.args.map(plainNodeToExpr));

    case EXPR_KIND.ITE:
      return createIte(plainNodeToExpr(plain.cond), plainNodeToExpr(plain.thenExpr), plainNodeToExpr(plain.elseExpr));

    case EXPR_KIND.EXTRACT:
      return createExtract(plainNodeToExpr(plain.arg), plain.high, plain.low);

    case EXPR_KIND.CONCAT:
      return createConcat(plainNodeToExpr(plain.left), plainNodeToExpr(plain.right));

    case EXPR_KIND.CAST:
      return createCast(plain.op, plainNodeToExpr(plain.arg), plain.targetWidth);

    default:
      throw new TypeError(`plainToExpr: unknown plain node kind '${plain.kind}'`);
  }
}

export function plainToExpr(plain) {
  reserveCanonicalFreshSymbolIds(plain);
  return plainNodeToExpr(plain);
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

export function deserializeExprDag(jsonOrObject) {
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
