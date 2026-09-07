import { evalBinary, evalUnary, u } from '../truth/integer.js';

/*
 * The small evaluator above is useful for cheap diagnostics, but its samples
 * are not a proof authority.  Proof-gated decompiler transforms use the
 * Semantic/Symbolic verifier below instead.  Keeping the adapter here gives
 * the rewrite bridge one production boundary: a local rule can describe a
 * candidate, but only a proof token minted by verifyBoundedEquivalence can
 * authorize its adoption.
 */
import {
  BV_BINARY_OP,
  BV_COMPARE_OP,
  BV_UNARY_OP,
  CAST_OP,
  EXPR_KIND,
  boolSort,
  bvSort,
} from '../../symbolic/expr/kinds.js';
import {
  createBinary,
  createCast,
  createCompare,
  createFreshSymbol,
  createIte,
  createUnary,
} from '../../symbolic/expr/factory.js';
import { verifyBoundedEquivalence } from '../../symbolic/verify/equivalence.js';
import { VERDICT } from '../../symbolic/verify/query.js';
import { SOLVER_STATUS } from '../../symbolic/solver/result.js';
import { defaultSolverRegistry } from '../../symbolic/solver/registry.js';
import { isExactProofBackend } from '../../symbolic/solver/backend.js';
import { stableDigest } from '../../core/identity/index.js';

const REWRITE_PROOF_TOKENS = new WeakSet();
const REWRITE_PROOF_BINDINGS = new WeakMap();
export const REWRITE_PROOF_VERSION = 'decompiler-rewrite-proof/v1';

/**
 * A proof token is deliberately branded in this module.  A caller cannot
 * promote `{ verdict: 'proved' }` or a sampled `equivalent: true` result by
 * copying fields into an object passed to the rewrite engine.
 */
export function isRewriteProof(value) {
  return !!value && typeof value === 'object' && REWRITE_PROOF_TOKENS.has(value);
}

/**
 * A brand proves that this module minted the token.  It does not by itself
 * prove that the token belongs to the expression pair currently under
 * consideration, so the rewrite bridge also checks this private binding.
 */
export function isRewriteProofFor(value, before, after, metadata = {}) {
  if (!isRewriteProof(value)) return false;
  const options = bindingOptions(metadata);
  const expected = proofBindingDigest(before, after, options, originMaterial(before, after, options.origin ?? null));
  return expected != null && REWRITE_PROOF_BINDINGS.get(value) === expected;
}

function proofCompletenessComplete(completeness) {
  return !!completeness
    && ['translation', 'controlFlow', 'memoryEffects', 'pathCoverage', 'queryScope']
      .every((key) => completeness[key] === 'complete');
}

function primitiveData(object, key) {
  if (object == null || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function sourceValues(source, key, singular) {
  const value = primitiveData(source, key) ?? primitiveData(source, singular);
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).filter((item) => (
    typeof item === 'string' || typeof item === 'number' || typeof item === 'bigint'
  )).map(String);
}

function sourceBinding(node) {
  const source = primitiveData(node, 'source');
  return {
    addresses: sourceValues(source, 'addresses', 'address'),
    rows: sourceValues(source, 'rows', 'row'),
    ir: sourceValues(source, 'ir', 'irId'),
    ssaDefs: sourceValues(source, 'ssaDefs', 'ssaDef'),
    ssaUses: sourceValues(source, 'ssaUses', 'ssaUse'),
  };
}

/*
 * `structuralKey` is intentionally a cheap rewrite fixed-point key and does
 * not include source provenance.  Proof identity has a stricter requirement:
 * two otherwise identical SSA variables from different definitions must not
 * be interchangeable.  Keep this material small and data-only so a proof
 * token can be checked again after an async gate returns without invoking
 * user getters or executing arbitrary AST methods.
 */
function proofExpressionMaterial(root, active = new WeakSet(), depth = 0, budget = { maxNodes: 4096, count: 0 }) {
  if (root == null || typeof root !== 'object' || Array.isArray(root) || depth > 512) return null;
  budget.count += 1;
  if (budget.count > budget.maxNodes) return null;
  if (active.has(root)) return null;
  active.add(root);
  const material = {
    kind: primitiveData(root, 'kind'),
    op: primitiveData(root, 'op'),
    bits: primitiveData(root, 'bits'),
    signed: primitiveData(root, 'signed'),
    compareSigned: primitiveData(root, 'compareSigned'),
    comparisonDomain: primitiveData(root, 'comparisonDomain'),
    name: primitiveData(root, 'name'),
    ssaId: primitiveData(root, 'ssaId'),
    value: primitiveData(root, 'value'),
    effect: primitiveData(root, 'effect'),
    floating: primitiveData(root, 'floating'),
    volatile: primitiveData(root, 'volatile'),
    extension: primitiveData(root, 'extension'),
    extend: primitiveData(root, 'extend'),
    source: sourceBinding(root),
  };
  const child = (key) => proofExpressionMaterial(primitiveData(root, key), active, depth + 1, budget);
  const kind = material.kind;
  if (kind === 'unary') material.arg = child('arg');
  else if (kind === 'binary' || kind === 'compare') {
    material.left = child('left');
    material.right = child('right');
  } else if (kind === 'select') {
    material.condition = child('condition');
    material.whenTrue = child('whenTrue');
    material.whenFalse = child('whenFalse');
  } else if (kind === 'call' || kind === 'intrinsic') {
    const args = primitiveData(root, 'args');
    if (!Array.isArray(args)) { active.delete(root); return null; }
    material.args = args.map((arg) => proofExpressionMaterial(arg, active, depth + 1, budget));
  } else if (kind === 'field') material.base = child('base');
  else if (kind === 'index') {
    material.base = child('base');
    material.index = child('index');
  }
  active.delete(root);
  return material;
}

function proofBindingDigest(before, after, options = {}, origin = null) {
  const requestedNodes = options.maxNodes;
  const budget = {
    maxNodes: Number.isSafeInteger(requestedNodes) && requestedNodes > 0 ? requestedNodes : 4096,
    count: 0,
  };
  const beforeMaterial = proofExpressionMaterial(before, new WeakSet(), 0, budget);
  const afterMaterial = proofExpressionMaterial(after, new WeakSet(), 0, budget);
  if (beforeMaterial == null || afterMaterial == null) return null;
  try {
    return stableDigest({
      version: REWRITE_PROOF_VERSION,
      before: beforeMaterial,
      after: afterMaterial,
      origin,
      inputDigest: typeof options.inputDigest === 'string' ? options.inputDigest : null,
      provenanceStatus: options.provenanceStatus ?? 'current',
      refinement: options.refinement ?? 'exact-observable-expression',
      allowUndefinedBehavior: options.allowUndefinedBehavior === true,
      memoryRegions: options.memoryRegions ?? [],
      preconditions: options.preconditions ?? null,
    });
  } catch {
    return null;
  }
}

function bindingOptions(metadata = {}) {
  const metadataContext = primitiveData(metadata, 'context');
  const metadataProofOptions = primitiveData(metadata, 'proofOptions');
  const metadataCandidate = primitiveData(metadata, 'candidate');
  const context = metadataContext && typeof metadataContext === 'object' ? metadataContext : {};
  const proofOptions = metadataProofOptions && typeof metadataProofOptions === 'object' ? metadataProofOptions : {};
  const candidate = metadataCandidate && typeof metadataCandidate === 'object' ? metadataCandidate : null;
  const directOptions = {};
  for (const key of ['refinement', 'allowUndefinedBehavior', 'memoryRegions', 'preconditions', 'maxNodes']) {
    const value = primitiveData(metadata, key);
    if (value !== undefined) directOptions[key] = value;
  }
  const metadataOrigin = primitiveData(metadata, 'origin');
  const metadataInputDigest = primitiveData(metadata, 'inputDigest');
  const origin = candidate?.origin ?? metadataOrigin ?? proofOptions.origin ?? context.origin ?? null;
  const inputDigest = candidate?.inputDigest ?? metadataInputDigest ?? proofOptions.inputDigest ?? context.inputDigest;
  return {
    ...proofOptions,
    ...context,
    ...directOptions,
    origin,
    inputDigest,
    provenanceStatus: primitiveData(metadata, 'provenanceStatus') ?? proofOptions.provenanceStatus ?? context.provenanceStatus,
  };
}

function originMaterial(before, after, explicit = null) {
  const material = {
    before: {
      addresses: sourceValues(before?.source, 'addresses', 'address'),
      rows: sourceValues(before?.source, 'rows', 'row'),
      ir: sourceValues(before?.source, 'ir', 'irId'),
      ssaDefs: sourceValues(before?.source, 'ssaDefs', 'ssaDef'),
      ssaUses: sourceValues(before?.source, 'ssaUses', 'ssaUse'),
    },
    after: {
      addresses: sourceValues(after?.source, 'addresses', 'address'),
      rows: sourceValues(after?.source, 'rows', 'row'),
      ir: sourceValues(after?.source, 'ir', 'irId'),
      ssaDefs: sourceValues(after?.source, 'ssaDefs', 'ssaDef'),
      ssaUses: sourceValues(after?.source, 'ssaUses', 'ssaUse'),
    },
  };
  if (explicit != null) material.candidate = explicit;
  return material;
}

function hasOrigin(material) {
  return Object.values(material || {}).some((side) => side && typeof side === 'object'
    && Object.values(side).some((values) => Array.isArray(values) && values.length > 0));
}

function unsupported(reason, detail = null) {
  return { expression: null, status: 'unsupported', reason, detail, assumptions: [], unsupportedEntities: [{ reason }] };
}

function widthOf(node) {
  const bits = primitiveData(node, 'bits');
  return typeof bits === 'number' && Number.isSafeInteger(bits) && bits > 0 ? bits : null;
}

function operationMap(op, table) {
  return Object.prototype.hasOwnProperty.call(table, op) ? table[op] : null;
}

/**
 * Translate the pure, expression-shaped decompiler AST into the solver-neutral
 * expression DAG.  Memory, calls, floating point, and potentially undefined
 * arithmetic are refused unless a caller supplies an explicit, complete
 * semantic model.  This is intentionally narrower than the general Semantic
 * IR translator: a rewrite bridge must never invent state it did not inspect.
 */
export function translateDecompilerExpression(root, options = {}) {
  const maxNodes = options.maxNodes == null ? 4096 : options.maxNodes;
  const maxDepth = options.maxDepth == null ? 256 : options.maxDepth;
  if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0 || !Number.isSafeInteger(maxDepth) || maxDepth <= 0) {
    return unsupported('invalid-proof-translation-budget');
  }
  const symbols = options.symbolTable instanceof Map ? options.symbolTable : new Map();
  const seen = new WeakMap();
  const active = new WeakSet();
  const unsupportedEntities = [];
  const assumptions = [];
  let nodes = 0;

  const fail = (reason, node = null) => {
    unsupportedEntities.push({ reason, kind: primitiveData(node, 'kind') || null });
    return null;
  };
  const symbolFor = (node, bits) => {
    const name = primitiveData(node, 'name');
    if (typeof name !== 'string' || name.length === 0) return fail('variable-identity-required', node);
    const ssaId = primitiveData(node, 'ssaId');
    const signed = primitiveData(node, 'signed');
    if (signed != null && typeof signed !== 'boolean') return fail('invalid-variable-signedness', node);
    if (ssaId != null && !['string', 'bigint'].includes(typeof ssaId)
        && !(typeof ssaId === 'number' && Number.isSafeInteger(ssaId))) {
      return fail('invalid-variable-ssa-identity', node);
    }
    const source = sourceBinding(node);
    // SSA provenance is part of the symbolic variable identity.  The cheap AST
    // structural key may intentionally ignore it, but an exact proof may not
    // collapse two definitions which merely share a printable variable name.
    const identity = stableDigest({
      name,
      ssaId: ssaId == null ? null : String(ssaId),
      bits,
      signed: signed == null ? null : signed,
      ssaDefs: source.ssaDefs,
      ssaUses: source.ssaUses,
      ir: source.ir,
    });
    if (!symbols.has(identity)) {
      try {
        symbols.set(identity, createFreshSymbol(bvSort(bits), identity, {
          source: 'decompiler-expression', name, ssaId: ssaId ?? null,
          ssaDefs: source.ssaDefs, ssaUses: source.ssaUses, ir: source.ir,
        }));
      } catch (error) {
        return fail(`variable-symbol-failed:${error?.message || 'invalid-symbol'}`, node);
      }
    }
    return symbols.get(identity);
  };
  const convert = (node, depth = 0) => {
    if (node == null || typeof node !== 'object' || Array.isArray(node)) return fail('malformed-expression', node);
    if (depth > maxDepth) return fail('expression-depth-exceeded', node);
    if (seen.has(node)) return seen.get(node);
    if (active.has(node)) return fail('cyclic-expression', node);
    nodes += 1;
    if (nodes > maxNodes) return fail('expression-node-budget-exceeded', node);
    const kind = primitiveData(node, 'kind');
    const bits = widthOf(node);
    if (bits == null || bits > 64) return fail('unsupported-bit-width', node);
    const effect = primitiveData(node, 'effect');
    if (effect != null && effect !== 'pure') return fail('observable-effect-not-modeled', node);
    active.add(node);
    let expression = null;
    try {
      if (kind === 'const') {
        const value = primitiveData(node, 'value');
        if (typeof value !== 'bigint' && typeof value !== 'number' && typeof value !== 'string') return fail('noncanonical-constant', node);
        try { expression = { kind: EXPR_KIND.CONST, sort: bvSort(bits), value: BigInt.asUintN(bits, BigInt(value)) }; }
        catch { expression = fail('invalid-constant', node); }
      } else if (kind === 'var') {
        expression = symbolFor(node, bits);
      } else if (kind === 'unary') {
        const arg = convert(primitiveData(node, 'arg'), depth + 1);
        const op = primitiveData(node, 'op');
        if (!arg) expression = null;
        else if (op === 'not') expression = createUnary(BV_UNARY_OP.NOT, arg);
        else if (op === 'neg') expression = createUnary(BV_UNARY_OP.NEG, arg);
        else if (op === 'trunc') expression = createCast(CAST_OP.TRUNC, arg, bits);
        else if (op === 'zext' || op === 'zx') expression = createCast(CAST_OP.ZEXT, arg, bits);
        else if (op === 'sext' || op === 'sx') expression = createCast(CAST_OP.SEXT, arg, bits);
        else expression = fail(`unsupported-unary-op:${String(op)}`, node);
      } else if (kind === 'binary') {
        const left = convert(primitiveData(node, 'left'), depth + 1);
        const right = convert(primitiveData(node, 'right'), depth + 1);
        const op = primitiveData(node, 'op');
        // Undefined arithmetic is an explicit unknown unless the caller has
        // supplied a precondition and opted into its contract.
        if (['udiv', 'sdiv', 'umod', 'smod', 'urem', 'srem'].includes(op)
            && (options.allowUndefinedBehavior !== true || options.preconditions == null)) {
          expression = fail('undefined-arithmetic-domain-requires-precondition', node);
        } else if (!left || !right) expression = null;
        else {
          const mapped = operationMap(op, {
            add: BV_BINARY_OP.ADD, sub: BV_BINARY_OP.SUB, mul: BV_BINARY_OP.MUL,
            and: BV_BINARY_OP.AND, or: BV_BINARY_OP.OR, xor: BV_BINARY_OP.XOR,
            shl: BV_BINARY_OP.SHL, lshr: BV_BINARY_OP.LSHR, ashr: BV_BINARY_OP.ASHR,
            udiv: BV_BINARY_OP.UDIV, sdiv: BV_BINARY_OP.SDIV,
            umod: BV_BINARY_OP.UREM, urem: BV_BINARY_OP.UREM,
            smod: BV_BINARY_OP.SREM, srem: BV_BINARY_OP.SREM,
          });
          expression = mapped ? createBinary(mapped, left, right) : fail(`unsupported-binary-op:${String(op)}`, node);
        }
      } else if (kind === 'compare') {
        const left = convert(primitiveData(node, 'left'), depth + 1);
        const right = convert(primitiveData(node, 'right'), depth + 1);
        const op = primitiveData(node, 'op');
        const signed = primitiveData(node, 'compareSigned') === true;
        const mapped = operationMap(op, {
          eq: BV_COMPARE_OP.EQ, ne: BV_COMPARE_OP.NE,
          ult: BV_COMPARE_OP.ULT, ule: BV_COMPARE_OP.ULE,
          ugt: BV_COMPARE_OP.UGT, uge: BV_COMPARE_OP.UGE,
          slt: BV_COMPARE_OP.SLT, sle: BV_COMPARE_OP.SLE,
          sgt: BV_COMPARE_OP.SGT, sge: BV_COMPARE_OP.SGE,
          lt: signed ? BV_COMPARE_OP.SLT : BV_COMPARE_OP.ULT,
          le: signed ? BV_COMPARE_OP.SLE : BV_COMPARE_OP.ULE,
          gt: signed ? BV_COMPARE_OP.SGT : BV_COMPARE_OP.UGT,
          ge: signed ? BV_COMPARE_OP.SGE : BV_COMPARE_OP.UGE,
        });
        expression = left && right && mapped ? createCompare(mapped, left, right) : fail(`unsupported-compare-op:${String(op)}`, node);
      } else if (kind === 'select') {
        const condition = convert(primitiveData(node, 'condition'), depth + 1);
        const whenTrue = convert(primitiveData(node, 'whenTrue'), depth + 1);
        const whenFalse = convert(primitiveData(node, 'whenFalse'), depth + 1);
        if (!condition || condition.sort?.kind !== boolSort().kind) expression = fail('select-condition-not-boolean', node);
        else if (!whenTrue || !whenFalse) expression = null;
        else expression = createIte(condition, whenTrue, whenFalse);
      } else {
        expression = fail(`unsupported-expression-kind:${String(kind)}`, node);
      }
    } catch (error) {
      expression = fail(`translation-error:${error?.message || 'invalid-expression'}`, node);
    }
    active.delete(node);
    if (expression) seen.set(node, expression);
    return expression;
  };
  const expression = convert(root);
  if (!expression || unsupportedEntities.length > 0) {
    return {
      expression: null,
      status: 'unsupported',
      reason: unsupportedEntities[0]?.reason || 'translation-failed',
      assumptions,
      unsupportedEntities,
      nodes,
    };
  }
  return {
    expression,
    status: assumptions.length > 0 ? 'exact-with-assumptions' : 'exact',
    reason: null,
    assumptions,
    unsupportedEntities,
    nodes,
  };
}

function proofTokenFromResult(result, metadata, origin, binding) {
  if (!result || result.verdict !== VERDICT.PROVED || result.solverStatus !== SOLVER_STATUS.UNSAT
      || !result.evidence || !result.queryHash || !proofCompletenessComplete(result.completeness)
      || binding == null) return null;
  const token = Object.freeze({
    proofVersion: REWRITE_PROOF_VERSION,
    accepted: true,
    verdict: result.verdict,
    solverStatus: result.solverStatus,
    reasonCode: result.reasonCode,
    queryHash: result.queryHash,
    evidence: result.evidence,
    completeness: result.completeness,
    query: result.query,
    solverResult: result.solverResult,
    origin,
    metadata: metadata || null,
  });
  REWRITE_PROOF_TOKENS.add(token);
  REWRITE_PROOF_BINDINGS.set(token, binding);
  return token;
}

/**
 * Run the exact production symbolic verifier for one AST transform.  Every
 * non-proof result is returned as an explicit unknown/refusal and can only
 * withhold a candidate; it never falls back to sampled equivalence.
 */
export async function verifyDecompilerRewrite(before, after, options = {}) {
  // Capture the binding before translation or the asynchronous solver call.
  // The AST objects belong to the caller and are intentionally not frozen at
  // this boundary. A concurrent pass can mutate one while the exact backend is
  // waiting, so a digest computed only after the await would bind a token to a
  // pair the solver never proved.
  const bindingOptionsAtStart = bindingOptions(options);
  const origin = originMaterial(before, after, bindingOptionsAtStart.origin ?? null);
  if (options.requireOrigin !== false && !hasOrigin(origin)) {
    return Object.freeze({ accepted: false, verdict: VERDICT.UNKNOWN, status: 'unknown', reasonCode: 'missing-transform-origin', origin });
  }
  if (options.provenanceStatus != null && options.provenanceStatus !== 'current') {
    return Object.freeze({ accepted: false, verdict: VERDICT.UNKNOWN, status: 'unknown', reasonCode: 'stale-transform-provenance', origin });
  }
  const bindingAtStart = proofBindingDigest(before, after, bindingOptionsAtStart, origin);
  if (bindingAtStart == null) {
    return Object.freeze({ accepted: false, verdict: VERDICT.UNKNOWN, status: 'unknown', reasonCode: 'proof-binding-unavailable', origin });
  }
  const symbolTable = new Map();
  const beforeTranslation = translateDecompilerExpression(before, { ...options, symbolTable });
  const afterTranslation = translateDecompilerExpression(after, { ...options, symbolTable });
  if (beforeTranslation.status === 'unsupported' || afterTranslation.status === 'unsupported') {
    return Object.freeze({
      accepted: false,
      verdict: VERDICT.UNKNOWN,
      status: 'unknown',
      reasonCode: beforeTranslation.reason || afterTranslation.reason || 'translation-unsupported',
      origin,
      beforeTranslation,
      afterTranslation,
    });
  }
  const backend = options.backend || defaultSolverRegistry.getDefaultBackend();
  if (!isExactProofBackend(backend)) {
    return Object.freeze({ accepted: false, verdict: VERDICT.UNKNOWN, status: 'unknown', reasonCode: 'exact-proof-backend-required', origin });
  }
  let result;
  try {
    result = await verifyBoundedEquivalence({
      beforeTarget: beforeTranslation.expression,
      afterTarget: afterTranslation.expression,
      correspondence: {},
      preconditions: options.preconditions ?? null,
      memoryRegions: options.memoryRegions ?? [],
      backend,
      options: {
        ...options.solverOptions,
        proofScope: {
          kind: 'decompiler-rewrite',
          memoryRegions: options.memoryRegions ?? [],
          ubPolicy: options.allowUndefinedBehavior === true ? 'caller-preconditioned' : 'total-bitvector-only',
          refinement: options.refinement ?? 'exact-observable-expression',
        },
      },
    });
  } catch (error) {
    return Object.freeze({ accepted: false, verdict: VERDICT.UNKNOWN, status: 'unknown', reasonCode: `verifier-failure:${error?.message || 'unknown'}`, origin });
  }
  // Re-read the caller-owned pair and context only at the adoption boundary.
  // A mismatch means the backend's result belongs to an earlier snapshot and
  // must remain unknown; the original pre-await binding is the only binding a
  // token from this invocation may carry.
  const bindingOptionsAtEnd = bindingOptions(options);
  const originAtEnd = originMaterial(before, after, bindingOptionsAtEnd.origin ?? null);
  const bindingAtEnd = proofBindingDigest(before, after, bindingOptionsAtEnd, originAtEnd);
  if (bindingAtEnd == null || bindingAtEnd !== bindingAtStart) {
    return Object.freeze({
      accepted: false,
      verdict: VERDICT.UNKNOWN,
      status: 'unknown',
      reasonCode: 'mutable-proof-input-changed-during-verification',
      origin,
      beforeTranslation,
      afterTranslation,
      result,
    });
  }
  const token = proofTokenFromResult(result, {
    inputDigest: bindingOptionsAtStart.inputDigest ?? stableDigest({ before: beforeTranslation.expression, after: afterTranslation.expression }),
    refinement: bindingOptionsAtStart.refinement ?? 'exact-observable-expression',
  }, origin, bindingAtStart);
  if (token) return token;
  return Object.freeze({
    accepted: false,
    verdict: result?.verdict || VERDICT.UNKNOWN,
    status: 'unknown',
    reasonCode: result?.reasonCode || 'proof-ineligible',
    origin,
    result,
  });
}

/** Build the callback consumed by the asynchronous proof-gated rewrite bridge. */
export function createRewriteProofGate(options = {}) {
  return (before, after, metadata = {}) => verifyDecompilerRewrite(before, after, {
    ...options,
    origin: metadata.candidate?.origin ?? metadata.origin ?? options.origin ?? null,
    inputDigest: metadata.candidate?.inputDigest ?? metadata.inputDigest ?? options.inputDigest,
    provenanceStatus: metadata.provenanceStatus ?? options.provenanceStatus,
  });
}

export function evaluateExpression(n, env = {}, memory = {}) {
  if (!n) return null;
  switch (n.kind) {
    case 'const': return u(n.value, n.bits);
    case 'var': return env[n.name] == null ? null : u(env[n.name], n.bits);
    case 'unary': {
      const a = evaluateExpression(n.arg, env, memory); if (a == null) return null;
      return evalUnary(n.op, a, n.bits, n.arg?.bits || n.bits);
    }
    case 'binary': {
      const a = evaluateExpression(n.left, env, memory), b = evaluateExpression(n.right, env, memory);
      if (a == null || b == null) return null;
      return evalBinary(n.op, a, b, n.bits, n.signed);
    }
    case 'compare': {
      const a = evaluateExpression(n.left, env, memory), b = evaluateExpression(n.right, env, memory);
      if (a == null || b == null) return null;
      return evalBinary(n.op, a, b, n.left?.bits || n.right?.bits || 64, n.compareSigned);
    }
    case 'select': {
      const q = evaluateExpression(n.condition, env, memory); if (q == null) return null;
      return evaluateExpression(q === 0n ? n.whenFalse : n.whenTrue, env, memory);
    }
    case 'intrinsic': {
      const args = (n.args || []).map((a) => evaluateExpression(a, env, memory));
      if (args.some((a) => a == null)) return null;
      if (n.name === 'min') return n.signed === false ? (args[0] < args[1] ? args[0] : args[1]) : (BigInt.asIntN(n.bits, args[0]) < BigInt.asIntN(n.bits, args[1]) ? args[0] : args[1]);
      if (n.name === 'max') return n.signed === false ? (args[0] > args[1] ? args[0] : args[1]) : (BigInt.asIntN(n.bits, args[0]) > BigInt.asIntN(n.bits, args[1]) ? args[0] : args[1]);
      if (n.name === 'abs') return evalUnary('abs', args[0], n.bits);
      if (n.name === 'bit_extract') {
        const lsb = Number(args[1]), width = Number(args[2]);
        return u(args[0] >> BigInt(lsb), width);
      }
      if (n.name === 'madd') return u(args[0] * args[1] + args[2], n.bits);
      if (n.name === 'msub') return u(args[0] * args[1] - args[2], n.bits);
      return null;
    }
    case 'load': return memory[n.location?.key || n.location?.name] ?? null;
    default: return null;
  }
}

export function verifyRewrite(original, rewritten, opts = {}) {
  const widths = opts.widths || [8, 16, 32, 64];
  const seeds = opts.samples || [0n, 1n, -1n, 2n, 7n, 0x7fn, 0x80n, 0xffn, 0x7fffffffn, 0x80000000n, 0xffffffffn, 0x7fffffffffffffffn, 0xffffffffffffffffn];
  const variables = [...collectVariables(original), ...collectVariables(rewritten)];
  const names = [...new Set(variables)];
  let checked = 0;
  let skipped = 0;
  for (const bits of widths) {
    for (let i = 0; i < seeds.length; i++) {
      const env = {};
      for (let j = 0; j < names.length; j++) env[names[j]] = u(seeds[(i + j) % seeds.length], bits);
      const a = evaluateExpression(original, env), b = evaluateExpression(rewritten, env);
      if (a == null || b == null) { skipped++; continue; }
      checked++;
      if (u(a, original.bits || bits) !== u(b, rewritten.bits || bits)) return { equivalent: false, checked, counterexample: { bits, env, original: a, rewritten: b } };
    }
  }
  if (checked === 0) return { equivalent: null, checked, skipped, reason: 'no-evaluable-samples' };
  if (skipped > 0) return { equivalent: null, checked, skipped, reason: 'incomplete-evaluator-coverage' };
  return { equivalent: true, checked };
}

export function collectVariables(n, out = new Set()) {
  if (!n) return out;
  if (n.kind === 'var') out.add(n.name);
  if (n.arg) collectVariables(n.arg, out);
  if (n.left) collectVariables(n.left, out);
  if (n.right) collectVariables(n.right, out);
  if (n.condition) collectVariables(n.condition, out);
  if (n.whenTrue) collectVariables(n.whenTrue, out);
  if (n.whenFalse) collectVariables(n.whenFalse, out);
  for (const a of n.args || []) collectVariables(a, out);
  if (n.base) collectVariables(n.base, out);
  if (n.index) collectVariables(n.index, out);
  return out;
}

export async function verifyWithFunctionSandbox(adapter, original, rewritten, cases = []) {
  if (!adapter || typeof adapter.execute !== 'function') return { available: false, reason: 'sandbox adapter unavailable' };
  const mismatches = [];
  for (const c of cases) {
    const a = await adapter.execute(original, c);
    const b = await adapter.execute(rewritten, c);
    if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push({ input: c, original: a, rewritten: b });
  }
  if (cases.length === 0) return { available: true, equivalent: null, checked: 0, mismatches, reason: 'no-cases' };
  return { available: true, equivalent: mismatches.length === 0, checked: cases.length, mismatches: mismatches.slice(0, 8) };
}
