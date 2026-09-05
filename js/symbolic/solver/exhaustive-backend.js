/**
 * Browser-safe exact Bool/BV backend.
 *
 * This is a real finite-domain decision procedure, not a mock: it enumerates
 * every assignment in the supported Bool/BV domain, evaluates Hex's own Expr
 * DAG, and returns a validated model for SAT. The finite scope is explicit;
 * queries outside it return RESOURCE_LIMIT/UNSUPPORTED and can never mint a
 * proof.
 */

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
import { evaluateExpr, EVAL_STATUS } from '../expr/evaluate.js';
import { validateVerificationQuery } from '../verify/query.js';
import { PROOF_AUTHORITY, SolverBackend } from './backend.js';
import { effectivePositiveSafeInteger, requirePositiveSafeInteger } from './limits.js';
import { validateExactModelBindings } from './model-boundary.js';
import { SOLVER_STATUS, createSolverResult } from './result.js';
import { SolverSession } from './session.js';

export const EXHAUSTIVE_BACKEND_ID = 'hex-exhaustive-bv';
export const EXHAUSTIVE_BACKEND_VERSION = '1.0.0';

function monotonicNow() {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
}

function childExpressions(expr) {
  if (!expr || typeof expr !== 'object') return [];
  switch (expr.kind) {
    case EXPR_KIND.UNARY: return [expr.arg];
    case EXPR_KIND.BINARY:
    case EXPR_KIND.COMPARE: return [expr.left, expr.right];
    case EXPR_KIND.CONNECTIVE: return Array.isArray(expr.args) ? expr.args : [];
    case EXPR_KIND.ITE: return [expr.cond, expr.thenExpr, expr.elseExpr];
    case EXPR_KIND.EXTRACT:
    case EXPR_KIND.CAST: return [expr.arg];
    case EXPR_KIND.CONCAT: return [expr.left, expr.right];
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
      if (isBoolSort(expr.sort) && typeof expr.value !== 'boolean') return 'invalid-bool-constant';
      if (isBvSort(expr.sort) && (typeof expr.value !== 'bigint' || expr.value < 0n || expr.value >= (1n << BigInt(expr.sort.width)))) return 'noncanonical-bv-constant';
      return null;
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
      if (expr.args.length === 0 || (expr.op === BOOL_CONNECTIVE_OP.NOT && expr.args.length !== 1) ||
          ([BOOL_CONNECTIVE_OP.IMPLIES, BOOL_CONNECTIVE_OP.EQ, BOOL_CONNECTIVE_OP.NE].includes(expr.op) && expr.args.length !== 2)) return 'invalid-connective-arity';
      return null;
    }
    case EXPR_KIND.ITE:
      return isBoolSort(expr.cond?.sort) && expr.thenExpr?.sort?.kind === expr.elseExpr?.sort?.kind &&
        ((isBoolSort(expr.thenExpr?.sort) && isBoolSort(expr.sort)) ||
          (isBvSort(expr.thenExpr?.sort) && isBvSort(expr.sort) && expr.thenExpr.sort.width === expr.elseExpr.sort.width && expr.sort.width === expr.thenExpr.sort.width))
        ? null : 'invalid-ite-expression';
    case EXPR_KIND.EXTRACT:
      return isBvSort(expr.arg?.sort) && Number.isSafeInteger(expr.high) && Number.isSafeInteger(expr.low) &&
        expr.low >= 0 && expr.high >= expr.low && expr.high < expr.arg.sort.width && isBvSort(expr.sort) &&
        expr.sort.width === expr.high - expr.low + 1 ? null : 'invalid-extract-expression';
    case EXPR_KIND.CONCAT:
      return isBvSort(expr.left?.sort) && isBvSort(expr.right?.sort) && isBvSort(expr.sort) &&
        expr.sort.width === expr.left.sort.width + expr.right.sort.width ? null : 'invalid-concat-expression';
    case EXPR_KIND.CAST:
      return Object.values(CAST_OP).includes(expr.op) && isBvSort(expr.arg?.sort) && isBvSort(expr.sort) &&
        Number.isSafeInteger(expr.targetWidth) && expr.sort.width === expr.targetWidth &&
        ((expr.op === CAST_OP.TRUNC && expr.targetWidth < expr.arg.sort.width) ||
          ([CAST_OP.ZEXT, CAST_OP.SEXT].includes(expr.op) && expr.targetWidth > expr.arg.sort.width))
        ? null : 'invalid-cast-expression';
    default:
      return 'unsupported-expression-kind';
  }
}

export function collectSymbols(expressions, { maxExprNodes = 100000, maxExprDepth = 1024 } = {}) {
  requirePositiveSafeInteger(maxExprNodes, 'maxExprNodes');
  requirePositiveSafeInteger(maxExprDepth, 'maxExprDepth');
  const symbols = new Map();
  const colors = new WeakMap();
  const heights = new WeakMap();
  let nodeCount = 0;
  let maxBvWidth = 0;
  let unsupportedReason = null;
  let limitExceeded = false;
  let depthExceeded = false;
  let maxDepth = 0;
  let traversalCount = 0;
  for (const root of expressions) {
    traversalCount++;
    if (traversalCount > maxExprNodes) { limitExceeded = true; break; }
    if (limitExceeded || depthExceeded || unsupportedReason) break;
    if (!root || typeof root !== 'object') { unsupportedReason = 'malformed-expression-node'; break; }
    if (colors.get(root) === 2) continue;
    const stack = [{ expr: root, entered: false, children: null, index: 0, childHeight: 0 }];
    while (stack.length > 0 && !limitExceeded && !depthExceeded && !unsupportedReason) {
      const frame = stack[stack.length - 1];
      if (!frame.entered) {
        if (colors.get(frame.expr) === 1) { unsupportedReason = 'cyclic-expression-dag'; break; }
        if (colors.get(frame.expr) === 2) { stack.pop(); continue; }
        if (stack.length > maxExprDepth) { depthExceeded = true; break; }
        colors.set(frame.expr, 1);
        nodeCount++;
        if (nodeCount > maxExprNodes) { limitExceeded = true; break; }
        if (isBvSort(frame.expr.sort)) maxBvWidth = Math.max(maxBvWidth, frame.expr.sort.width);
        unsupportedReason = validateExprNode(frame.expr);
        if (unsupportedReason) break;
        if (frame.expr.kind === EXPR_KIND.FRESH_SYMBOL) {
          const key = String(frame.expr.symbolId || frame.expr.name || '');
          if (!key || !frame.expr.name) unsupportedReason = 'malformed-symbol';
          else {
            const existing = symbols.get(key);
            if (existing && stableDigest(existing.sort) !== stableDigest(frame.expr.sort)) unsupportedReason = 'symbol-sort-conflict';
            else if (existing && existing.name !== String(frame.expr.name)) unsupportedReason = 'symbol-identity-conflict';
            symbols.set(key, { key, name: String(frame.expr.name), symbolId: String(frame.expr.symbolId || key), sort: frame.expr.sort });
          }
        }
        frame.children = childExpressions(frame.expr);
        frame.entered = true;
      }
      if (frame.index < frame.children.length) {
        traversalCount++;
        if (traversalCount > maxExprNodes) { limitExceeded = true; break; }
        const child = frame.children[frame.index++];
        if (!child || typeof child !== 'object') { unsupportedReason = 'malformed-expression-node'; break; }
        if (frame.expr.kind === EXPR_KIND.CONNECTIVE && !isBoolSort(child.sort)) { unsupportedReason = 'invalid-connective-expression'; break; }
        if (colors.get(child) === 1) { unsupportedReason = 'cyclic-expression-dag'; break; }
        if (colors.get(child) === 2) {
          const childHeight = heights.get(child) || 1;
          const combinedDepth = stack.length + childHeight;
          maxDepth = Math.max(maxDepth, combinedDepth);
          if (combinedDepth > maxExprDepth) { depthExceeded = true; break; }
          frame.childHeight = Math.max(frame.childHeight, childHeight);
        } else stack.push({ expr: child, entered: false, children: null, index: 0, childHeight: 0 });
        continue;
      }
      const height = frame.childHeight + 1;
      heights.set(frame.expr, height);
      maxDepth = Math.max(maxDepth, stack.length - 1 + height);
      if (stack.length - 1 + height > maxExprDepth) { depthExceeded = true; break; }
      colors.set(frame.expr, 2);
      stack.pop();
      if (stack.length > 0) stack[stack.length - 1].childHeight = Math.max(stack[stack.length - 1].childHeight, height);
    }
  }
  return {
    symbols: [...symbols.values()].sort((a, b) => a.key.localeCompare(b.key)),
    nodeCount,
    maxBvWidth,
    unsupportedReason,
    limitExceeded,
    depthExceeded,
    maxDepth,
    traversalCount,
  };
}

function symbolConstantPair(left, right) {
  if (left?.kind === EXPR_KIND.FRESH_SYMBOL && right?.kind === EXPR_KIND.CONST) return [left, right];
  if (right?.kind === EXPR_KIND.FRESH_SYMBOL && left?.kind === EXPR_KIND.CONST) return [right, left];
  return null;
}

function deriveFixedBindings(constraints) {
  const fixed = new Map();
  for (const constraint of constraints) {
    if (constraint?.kind !== EXPR_KIND.COMPARE || constraint.op !== 'eq') continue;
    const pair = symbolConstantPair(constraint.left, constraint.right);
    if (!pair) continue;
    const [symbol, constant] = pair;
    const key = String(symbol.symbolId || symbol.name);
    const value = constant.value;
    if (fixed.has(key) && fixed.get(key) !== value) return { contradiction: true, fixed };
    fixed.set(key, value);
  }
  return { contradiction: false, fixed };
}

function assignmentModel(symbols, assignments) {
  // Solver binding identity is canonical symbolId. Keying the model by display
  // name lets one symbol's name collide with another symbol's symbolId, which
  // evaluateExpr() resolves id-first — an alias that let the exact backend
  // prove SAT formulas UNSAT. Symbols must stay independent bindings keyed by
  // symbolId only (name is presentation metadata, never a binding key).
  return Object.fromEntries(
    symbols.map((symbol) => [symbol.symbolId || symbol.name, assignments.get(symbol.key)]),
  );
}

function evaluateAll(query, model) {
  for (const constraint of query.constraints) {
    const result = evaluateExpr(constraint, model);
    if (result.status !== EVAL_STATUS.VALUE || result.sort?.kind !== SORT_KIND.BOOL || result.value !== true) return false;
  }
  if (query.assertion) {
    const result = evaluateExpr(query.assertion, model);
    if (result.status !== EVAL_STATUS.VALUE || result.sort?.kind !== SORT_KIND.BOOL || result.value !== true) return false;
  }
  return true;
}

function domainSize(symbol) {
  return symbol.sort.kind === SORT_KIND.BOOL ? 2n : 1n << BigInt(symbol.sort.width);
}

function domainValue(symbol, index) {
  if (symbol.sort.kind === SORT_KIND.BOOL) return index === 1n;
  return index;
}

class ExhaustiveSolverSession extends SolverSession {
  async _executeCheck(query, options = {}, token, signal) {
    const startedAt = Date.now();
    const deadline = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? monotonicNow() + options.timeoutMs : Infinity;
    const guard = () => signal?.aborted ? 'cancelled' : monotonicNow() >= deadline ? 'timeout' : null;
    let maxConstraints;
    let maxExprNodes;
    let maxExprDepth;
    let maxBvWidth;
    let maxAssignments;
    let yieldEvery;
    try {
      maxConstraints = effectivePositiveSafeInteger(options, 'maxConstraints', this.options.maxConstraints, this.backend.maxConstraints);
      maxExprNodes = effectivePositiveSafeInteger(options, 'maxExprNodes', this.options.maxExprNodes, this.backend.maxExprNodes);
      maxExprDepth = effectivePositiveSafeInteger(options, 'maxExprDepth', this.options.maxExprDepth, this.backend.maxExprDepth);
      maxBvWidth = effectivePositiveSafeInteger(options, 'maxBvWidth', this.options.maxBvWidth, this.backend.maxBvWidth);
      maxAssignments = effectivePositiveSafeInteger(options, 'maxAssignments', this.options.maxAssignments, this.backend.maxAssignments);
      yieldEvery = effectivePositiveSafeInteger(options, 'yieldEvery', this.options.yieldEvery, this.backend.yieldEvery);
    } catch (error) {
      return createSolverResult({ status: SOLVER_STATUS.INVALID_QUERY, reason: `invalid-budget:${error.message}`, backend: this.backend.id, backendVersion: this.backend.version, queryHash: null, lifecycle: { publishable: false } });
    }
    const queryValidation = validateVerificationQuery(query, { maxExprNodes });
    if (!queryValidation.valid) {
      return createSolverResult({
        status: queryValidation.limitExceeded ? SOLVER_STATUS.RESOURCE_LIMIT : SOLVER_STATUS.INVALID_QUERY,
        reason: queryValidation.reason,
        backend: this.backend.id,
        backendVersion: this.backend.version,
        queryHash: null,
        lifecycle: { budgetExceeded: queryValidation.limitExceeded === true, publishable: false },
      });
    }

    const constraints = Array.isArray(query.constraints) ? query.constraints : [];
    const expressions = [...constraints, ...(query.assertion ? [query.assertion] : [])];
    if (constraints.length > maxConstraints) {
      return createSolverResult({ status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'constraint-budget-exceeded', backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
    }

    const collected = collectSymbols(expressions, { maxExprNodes, maxExprDepth });
    if (collected.limitExceeded) {
      return createSolverResult({ status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'expression-node-budget-exceeded', backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
    }
    if (collected.depthExceeded) {
      return createSolverResult({ status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'expression-depth-budget-exceeded', backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash, lifecycle: { budgetExceeded: true, publishable: false } });
    }
    if (collected.unsupportedReason) {
      return createSolverResult({ status: SOLVER_STATUS.UNSUPPORTED, reason: collected.unsupportedReason, backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
    }
    if (constraints.some((constraint) => constraint?.sort?.kind !== SORT_KIND.BOOL) ||
        (query.assertion && query.assertion.sort?.kind !== SORT_KIND.BOOL)) {
      return createSolverResult({ status: SOLVER_STATUS.UNSUPPORTED, reason: 'non-boolean-query-predicate', backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
    }

    if (collected.symbols.some((symbol) => symbol.sort.kind === SORT_KIND.BV && symbol.sort.width > maxBvWidth)) {
      return createSolverResult({ status: SOLVER_STATUS.UNSUPPORTED, reason: `bitvector-width-exceeds-${maxBvWidth}`, backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
    }

    const preEnumerationStop = guard();
    if (preEnumerationStop === 'cancelled') return createSolverResult({ status: SOLVER_STATUS.CANCELLED, reason: 'provider-aborted', backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash, lifecycle: { cancelled: true, publishable: false } });
    if (preEnumerationStop === 'timeout') return createSolverResult({ status: SOLVER_STATUS.TIMEOUT, reason: 'enumeration-deadline-exceeded', backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash, lifecycle: { timedOut: true, publishable: false } });

    const derived = deriveFixedBindings(constraints);
    if (derived.contradiction) {
      return createSolverResult({ status: SOLVER_STATUS.UNSAT, stats: { solveTimeMs: Date.now() - startedAt, nodesEvaluated: 0 }, backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
    }

    const assignments = new Map(derived.fixed);
    const freeSymbols = collected.symbols.filter((symbol) => !assignments.has(symbol.key));
    const maxAssignmentsBigInt = BigInt(maxAssignments);
    let totalAssignments = 1n;
    for (const symbol of freeSymbols) {
      totalAssignments *= domainSize(symbol);
      if (totalAssignments > maxAssignmentsBigInt) {
        return createSolverResult({ status: SOLVER_STATUS.RESOURCE_LIMIT, reason: 'assignment-budget-exceeded', stats: { solveTimeMs: Date.now() - startedAt, nodesEvaluated: 0 }, backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
      }
    }

    let nodesEvaluated = 0;
    let found = null;
    const visit = async (position) => {
      const stopped = guard();
      if (stopped) return stopped;
      if (found) return 'found';
      if (position >= freeSymbols.length) {
        nodesEvaluated++;
        const model = assignmentModel(collected.symbols, assignments);
        if (evaluateAll(query, model)) found = model;
        // Yield to the task queue (not only the microtask queue) so browser
        // cancellation and host timeouts can be observed during enumeration.
        if (nodesEvaluated % yieldEvery === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        return found ? 'found' : 'continue';
      }
      const symbol = freeSymbols[position];
      const size = domainSize(symbol);
      for (let index = 0n; index < size; index++) {
        const stopped = guard();
        if (stopped) return stopped;
        assignments.set(symbol.key, domainValue(symbol, index));
        const outcome = await visit(position + 1);
        if (outcome === 'cancelled' || outcome === 'timeout' || outcome === 'found') return outcome;
      }
      assignments.delete(symbol.key);
      return 'continue';
    };

    const outcome = await visit(0);
    if (outcome === 'cancelled') {
      return createSolverResult({ status: SOLVER_STATUS.CANCELLED, reason: 'provider-aborted', backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash, lifecycle: { cancelled: true, publishable: false } });
    }
    if (outcome === 'timeout') {
      return createSolverResult({ status: SOLVER_STATUS.TIMEOUT, reason: 'enumeration-deadline-exceeded', backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash, lifecycle: { timedOut: true, publishable: false } });
    }
    const stats = { solveTimeMs: Date.now() - startedAt, nodesEvaluated };
    if (found) {
      const bindingValidation = validateExactModelBindings(collected.symbols, found);
      if (!bindingValidation.valid) return createSolverResult({ status: SOLVER_STATUS.PROVIDER_FAILURE, reason: bindingValidation.reason, stats, backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash, lifecycle: { publishable: false } });
      return createSolverResult({ status: SOLVER_STATUS.SAT, model: found, stats, backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
    }
    return createSolverResult({ status: SOLVER_STATUS.UNSAT, stats, backend: this.backend.id, backendVersion: this.backend.version, queryHash: query.queryHash });
  }
}

export class ExhaustiveBvBackend extends SolverBackend {
  constructor(options = {}) {
    const id = options.id ?? EXHAUSTIVE_BACKEND_ID;
    const version = options.version ?? EXHAUSTIVE_BACKEND_VERSION;
    super({ id, version, proofAuthority: PROOF_AUTHORITY.EXACT, isRemote: false, isWasm: false, requiresCanonicalQueryIdentity: true });
    const value = (name, fallback) => Object.prototype.hasOwnProperty.call(options, name) ? options[name] : fallback;
    this.maxBvWidth = requirePositiveSafeInteger(value('maxBvWidth', 8), 'maxBvWidth');
    this.maxAssignments = requirePositiveSafeInteger(value('maxAssignments', 1 << 20), 'maxAssignments');
    this.maxConstraints = requirePositiveSafeInteger(value('maxConstraints', 4096), 'maxConstraints');
    this.maxExprNodes = requirePositiveSafeInteger(value('maxExprNodes', 100000), 'maxExprNodes');
    this.maxExprDepth = requirePositiveSafeInteger(value('maxExprDepth', 1024), 'maxExprDepth');
    this.yieldEvery = requirePositiveSafeInteger(value('yieldEvery', 4096), 'yieldEvery');
  }

  baseCapabilities() {
    return {
      ...super.baseCapabilities(),
      supportedSorts: ['bool', 'bv'],
      maxBvWidth: this.maxBvWidth,
      supportsIncremental: false,
      supportsCancellation: true,
      supportsModelExtraction: true,
      sessionReuseAfterTimeout: false,
      exactProofs: true,
      executionIsolation: 'caller-selected',
      memoryBudgetClass: 'measured-only',
      maxAssignments: this.maxAssignments,
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
      maxExprDepth: this.maxExprDepth,
      yieldEvery: this.yieldEvery,
    };
  }

  createSession(options = {}) {
    return new ExhaustiveSolverSession(this, {
      maxBvWidth: this.maxBvWidth,
      maxAssignments: this.maxAssignments,
      maxConstraints: this.maxConstraints,
      maxExprNodes: this.maxExprNodes,
      maxExprDepth: this.maxExprDepth,
      yieldEvery: this.yieldEvery,
      ...options,
    });
  }
}
