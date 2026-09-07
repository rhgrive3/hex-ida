/** Architecture-neutral Semantic IR/SSA -> canonical Bool/BV Expr.
 * Declared value widths are never replaced by the consumer's result width.
 * Static and executed scalar translation share scalar.js; memory forwarding
 * still requires the existing authenticated MemorySSA query capability.
 */
import { OP, VK, MK } from '../../ir-base.js';
import { bvSort, boolSort, createBv, createFreshSymbol, createUnknownSemantic } from '../expr/index.js';
import { computeStructuralHash } from '../expr/hash.js';
import { TRANSLATION_STATUS, ASSUMPTION_TRUST, createAssumption, createCompleteness } from './support-matrix.js';
import { canonicalMemoryForwardingContextForLoad, isCanonicalExactMemoryForwarding } from '../../semantics/memoryssa/queries.js';
import { translateExecutedTarget } from '../memory/execution-snapshot.js';
import { QueryFailure, monotonicNow, boundedLimit } from '../memory/query-state.js';
import { floatingSemantics, literalExpression, lowerScalarInstruction } from './scalar.js';

export function translateSemanticIR(target, options = {}) {
  if (Object.hasOwn(options, 'executionSnapshot')) return translateExecutedTarget(target, options);
  // Keep the documented nonnumeric-option fallback. Explicit typed SSA widths
  // remain authoritative even when a caller supplies a default bitWidth.
  const defaultWidth = typeof options.bitWidth === 'number' && options.bitWidth ? options.bitWidth : 64;
  const fromBlock = options.fromBlock ?? null;
  const configuredArgs = options.symbolicArgs ?? {};
  const assumptions = [], unsupportedEntities = [], originMap = new Map();
  const memo = new Map(), active = new Set(), identities = new Map(), dataChecked = new WeakSet();
  let semanticUnknowns = 0, workItems = 0, maximumDepth = 0;
  let maxWork = 250000, maxDepth = 128, timeout = 250;
  const start = monotonicNow();
  function tick(amount = 1) {
    if (options.signal?.aborted || options.isCancelled?.()) throw new QueryFailure('cancelled');
    if (monotonicNow() - start >= timeout) throw new QueryFailure('deadline');
    if (amount > maxWork - workItems) throw new QueryFailure('budget:translation-work');
    workItems += amount;
  }
  function data(object, key) {
    if (object == null) return undefined;
    if (typeof object !== 'object') throw new QueryFailure('invalid-ir-object');
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && !Object.hasOwn(descriptor, 'value') || !descriptor && key in object) throw new QueryFailure('translation-accessor-or-inherited-field');
    return descriptor?.value;
  }
  function plain(object) {
    if (object == null) return;
    if (typeof object !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(object))) throw new QueryFailure('invalid-ir-data');
    if (dataChecked.has(object)) return;
    const names = Object.getOwnPropertyNames(object); tick(names.length);
    for (const key of names) data(object, key);
    dataChecked.add(object);
  }
  function widthOf(value, fallback) {
    plain(value);
    const machineType = data(value, 'machineType'); plain(machineType);
    const bits = data(value, 'bits') ?? data(machineType, 'widthBits') ?? fallback;
    if (!Number.isSafeInteger(bits) || bits < 1 || bits > 65536) throw new QueryFailure('invalid-value-width');
    if (machineType?.widthBits != null && machineType.widthBits !== bits) throw new QueryFailure('machine-value-width-mismatch');
    if (machineType?.kind != null && !['bitvector','integer','bool','boolean','address','pointer'].includes(machineType.kind)) throw new QueryFailure('unsupported-machine-value-sort');
    return bits;
  }
  function unknown(width, reason, entity = null, boolean = false) {
    semanticUnknowns++;
    unsupportedEntities.push(Object.freeze({ id: entity?.id ?? null, op: entity?.op ?? null, reason }));
    return createUnknownSemantic(boolean ? boolSort() : bvSort(Number.isSafeInteger(width) && width > 0 && width <= 65536 ? width : 64), reason);
  }
  function recordOrigin(expression, ...origins) {
    if (!expression) return;
    const key = expression.symbolId || computeStructuralHash(expression);
    if (!originMap.has(key)) originMap.set(key, new Set());
    for (const origin of origins) if (['string', 'number', 'bigint'].includes(typeof origin)) originMap.get(key).add(String(origin));
  }
  function metadata(inst) {
    // Validate each parent before reading its children. Constructing an array
    // of nested accesses first would invoke a getter before the boundary check.
    plain(inst);
    const extra = data(inst, 'extra'); plain(extra);
    const attributes = data(extra, 'attributes'); plain(attributes);
    const machine = data(attributes, 'machineEffects'); plain(machine);
    plain(data(machine, 'operationMetadata'));
    plain(data(attributes, 'machineAddressExpression'));
  }
  function argumentsOf(inst) {
    const args = inst.args ?? [];
    if (!Array.isArray(args)) throw new QueryFailure('invalid-ir-arguments');
    tick(args.length);
    const values = [];
    for (let i = 0; i < args.length; i++) {
      const arg = data(args, String(i)); plain(arg);
      values.push(arg && Object.hasOwn(arg, 'value') ? data(arg, 'value') : arg);
    }
    return values;
  }
  function visitValue(val, fallback, depth) {
    tick(); maximumDepth = Math.max(maximumDepth, depth);
    if (depth > maxDepth) throw new QueryFailure('budget:translation-depth');
    if (!val || typeof val !== 'object') return unknown(fallback, 'missing-ssa-value');
    const width = widthOf(val, fallback);
    const id = data(val, 'id');
    if (id != null) {
      if (!['string','number'].includes(typeof id) || typeof id === 'number' && !Number.isSafeInteger(id)) return unknown(width, 'invalid-value-id', val);
      if (identities.has(id) && identities.get(id) !== val) return unknown(width, 'duplicate-value-id', val);
      identities.set(id, val);
    }
    if (memo.has(val)) {
      const previous = memo.get(val);
      if (previous.width !== width) return unknown(width, 'inconsistent-value-width', val);
      return previous.expression;
    }
    if (active.has(val)) {
      assumptions.push(createAssumption({ id:`cycle_${id ?? 'anonymous'}`, kind:'phi-cycle-unroll-boundary',
        statement:'Dependency cycle is outside static scalar translation.', source:'translator', trust:ASSUMPTION_TRUST.BOUNDED_UNROLL }));
      return unknown(width, 'ssa-dependency-cycle', val);
    }
    active.add(val);
    let expression;
    const def = data(val, 'def'); plain(def);
    metadata(val);
    if (floatingSemantics(val)) expression = unknown(width, 'unsupported-floating-semantics', val);
    else if (val.kind === VK.ARG || val.kind === 'arg') {
      const rawReg = data(val, 'reg') ?? id ?? 'arg';
      if (!['string','number'].includes(typeof rawReg)) throw new QueryFailure('invalid-argument-identity');
      const reg = String(rawReg);
      const argIndex = data(val, 'index') ?? (/^x[0-9]+$/.test(reg) ? Number(reg.slice(1)) : null);
      const custom = argIndex != null && data(configuredArgs, String(argIndex)) !== undefined
        ? data(configuredArgs, String(argIndex)) : data(configuredArgs, reg);
      if (typeof custom === 'bigint' || typeof custom === 'number' && Number.isSafeInteger(custom)) expression = createBv(width, custom);
      else if (custom != null && typeof custom !== 'string') {
        expression = unknown(width, 'invalid-numeric-concrete-binding', val);
        // Preserve current-main #6090's structured diagnostic contract without
        // coercing an untrusted object merely to print a diagnostic.
        unsupportedEntities[unsupportedEntities.length - 1] = Object.freeze({ id: id ?? null,
          op: `arg:${reg}`, reason: `invalid-numeric-concrete-binding:${typeof custom === 'number' ? String(custom) : typeof custom}` });
      }
      else expression = createFreshSymbol(bvSort(width), typeof custom === 'string' ? custom : `arg_${reg}`, { source:'argument', reg, argIndex });
    } else if (def) {
      if (def.dst != null && def.dst !== val) expression = unknown(width, 'value-definition-output-mismatch', val);
      else expression = visitInstruction(def, width, depth + 1);
    } else if (val.const != null) expression = literalExpression(null, width, val);
    else expression = unknown(width, 'value-without-definition', val);
    if (expression?.kind === 'unknown_semantic' && !unsupportedEntities.some(e => e.reason === expression.reason)) {
      semanticUnknowns++; unsupportedEntities.push(Object.freeze({ id:id ?? null, reason:expression.reason }));
    }
    if (['bool','boolean'].includes(val.machineType?.kind) && expression?.sort.kind !== 'bool'
        || expression?.sort.kind === 'bool' && val.bits != null && width !== 1) expression = unknown(width, 'value-sort-mismatch', val);
    recordOrigin(expression, val.origin, def?.origin, def?.id != null ? `inst:${def.id}` : null);
    active.delete(val); memo.set(val, { width, expression });
    return expression;
  }
  function visitInstruction(inst, fallback, depth) {
    tick(); maximumDepth = Math.max(maximumDepth, depth);
    if (depth > maxDepth) throw new QueryFailure('budget:translation-depth');
    if (!inst) return unknown(fallback, 'missing-instruction');
    plain(inst); metadata(inst);
    const width = widthOf(inst.dst ?? inst, fallback);
    metadata(inst.dst);
    if (floatingSemantics(inst)) return unknown(width, 'unsupported-floating-semantics', inst);
    if (inst.op === OP.PHI) {
      const incoming = inst.incoming;
      if (!Array.isArray(incoming) || !incoming.length) return unknown(width, 'phi-without-incoming', inst);
      tick(incoming.length);
      const matches = [], predecessors = new Set();
      for (let i = 0; i < incoming.length; i++) {
        const item = data(incoming, String(i)); plain(item);
        if (!item || predecessors.has(item.from)) return unknown(width, 'invalid-phi-incoming', inst);
        predecessors.add(item.from);
        if (fromBlock == null || item.from === fromBlock) matches.push(item.value);
      }
      if (matches.length !== 1) return unknown(width, 'ambiguous-or-missing-phi-predecessor', inst);
      if (fromBlock != null && incoming.length > 1) {
        assumptions.push(createAssumption({ id:`phi_scope_${inst.id ?? 'anonymous'}`, kind:'phi-predecessor-scope',
          statement:'Selected PHI incoming is valid only on the requested predecessor; no edge predicate was proved.',
          source:'translator', trust:ASSUMPTION_TRUST.QUERY_SCOPE }));
      }
      const expression = visitValue(matches[0], width, depth + 1);
      return expression.sort.kind === 'bv' && expression.sort.width !== width ? unknown(width, 'phi-width-mismatch', inst) : expression;
    }
    if (inst.op === OP.LOAD) {
      if (isCanonicalExactMemoryForwarding(inst.memoryForwarding,
        canonicalMemoryForwardingContextForLoad(inst.memoryForwarding, inst, inst.memoryForwardingContext ?? inst.extra?.memoryForwardingContext))
        && inst.memoryForwarding.value != null && inst.memoryForwarding.widthBits === width) {
        const expression = createBv(width, inst.memoryForwarding.value);
        recordOrigin(expression, inst.origin, ...(inst.memoryForwarding.provenance?.sourceEntityIds ?? []));
        return expression;
      }
      return unknown(width, inst.loc && inst.loc.kind !== MK.UNKNOWN ? 'missing-canonical-memory-proof' : 'unknown-load-alias', inst);
    }
    const scalarOps = [OP.CONST,OP.MOV,OP.ADDR,OP.BIN,OP.UN,OP.CMP,OP.SEL];
    if (!scalarOps.includes(inst.op)) return unknown(width, 'unsupported-instruction-op', inst);
    const values = argumentsOf(inst);
    const operandFallback = inst.op === OP.CMP ? defaultWidth : width;
    const args = values.map(val => visitValue(val, operandFallback, depth + 1));
    let condition = null;
    if (inst.op === OP.SEL) {
      if (inst.conditionValue != null) condition = visitValue(inst.conditionValue, 1, depth + 1);
      else if (inst.cond && typeof inst.cond === 'object') condition = visitInstruction(inst.cond, defaultWidth, depth + 1);
    }
    let expression = lowerScalarInstruction(inst, args, width, condition);
    const declaredKind = inst.dst?.machineType?.kind;
    if (['bool','boolean'].includes(declaredKind) && expression.sort.kind !== 'bool'
        || expression.sort.kind === 'bool' && (inst.dst?.bits != null && width !== 1
          || declaredKind != null && !['bool','boolean'].includes(declaredKind))) {
      expression = unknown(width, 'value-sort-mismatch', inst);
    }
    if (expression.kind === 'unknown_semantic') {
      semanticUnknowns++; unsupportedEntities.push(Object.freeze({ id:inst.id ?? null, op:inst.op, reason:expression.reason }));
    }
    return expression;
  }
  let rootExpr;
  try {
    maxWork = boundedLimit(options.maxWorkItems, 250000, 250000, 'maxWorkItems');
    maxDepth = boundedLimit(options.maxDepth, 128, 128, 'maxDepth');
    timeout = boundedLimit(options.timeoutMs, 250, 5000, 'timeoutMs');
    tick();
    if (!Number.isSafeInteger(defaultWidth) || defaultWidth < 1 || defaultWidth > 65536) throw new QueryFailure('invalid-default-width');
    rootExpr = data(target, 'op') != null ? visitInstruction(target, defaultWidth, 0) : visitValue(target, defaultWidth, 0);
    tick();
  } catch (error) {
    if (!(error instanceof QueryFailure || error instanceof TypeError || error instanceof RangeError)) throw error;
    rootExpr = unknown(defaultWidth, error instanceof QueryFailure ? error.reason : 'invalid-translation-input');
  }
  const status = semanticUnknowns ? TRANSLATION_STATUS.UNSUPPORTED : assumptions.length ? TRANSLATION_STATUS.EXACT_WITH_ASSUMPTIONS : TRANSLATION_STATUS.EXACT;
  const exact = status === TRANSLATION_STATUS.EXACT;
  return Object.freeze({ status, expression:rootExpr, assumptions:Object.freeze(assumptions),
    unsupportedEntities:Object.freeze(unsupportedEntities), semanticUnknowns,
    originMap:Object.freeze(Object.fromEntries([...originMap].map(([key, origins]) => [key,Object.freeze([...origins].sort())]))),
    completeness:createCompleteness({ translation:exact?'complete':'unsupported', controlFlow:exact?'complete':'partial',
      memoryEffects:exact?'complete':'partial', queryScope:exact?'complete':'partial' }),
    metrics:Object.freeze({ workItems, maximumDepth, wallClock:monotonicNow()-start }) });
}
