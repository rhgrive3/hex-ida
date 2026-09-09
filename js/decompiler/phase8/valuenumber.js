/**
 * Global value numbering.
 *
 * Two values get the same number when they are the same computation, decided by
 * semantic identity: operator, sub-kind, exact width, and the numbers of the
 * operands. Never by rendered text. `printExpression` output is a projection
 * chosen for humans — it normalises casts, hides widths and reorders for
 * readability — so two expressions that print identically can compute different
 * things, and using the printed form as a key is how a decompiler starts
 * "simplifying" one computation into another.
 *
 * Memory is the hard half. A load is congruent to an earlier load only when the
 * IR's own memory facts prove it: the same canonical location, the same width,
 * the same reaching memory definitions, and no barrier in between. Phase 8 does
 * not re-derive any of that — the alias solver and MemorySSA already answered it,
 * and a second opinion computed here would be a second memory truth.
 *
 * Everything this pass cannot prove becomes its own singleton class. A missed
 * reuse costs readability; a wrong reuse is a wrong program.
 */

import { createPassDescriptor, createPassResult } from './contract.js';
import { analysisIdentityMatches, canonicalAnalysisIdentity } from './analysis-identity.js';
import { readonlyMap, frozenEntries } from './readonly-map.js';

export const GVN_PASS = createPassDescriptor({
  id: 'phase8.gvn',
  version: '1.0.1',
  stage: 'memory-optimization',
  budgetClass: 'standard',
  // `ranges` is SCCP's output: two values that are the same constant are the
  // same computation however they were spelled. Declaring the dependency is what
  // makes the transaction refuse to run this pass before SCCP has run.
  consumes: ['cfg', 'ssa', 'ranges'],
  preserves: ['cfg', 'dominators', 'loops', 'ssa', 'memorySsa', 'alias', 'effects', 'ranges', 'deadCode', 'induction', 'types', 'aggregates', 'summaries', 'origins', 'structuredRegions', 'providerHints'],
  invalidates: [],
  produces: ['valueNumbers'],
  description: 'Semantic value numbering with memory reuse gated on the IR\'s own memory proof.',
});

/** Operators whose operand order does not change the result. */
const COMMUTATIVE = new Set(['add', 'mul', 'and', 'or', 'xor', 'eq', 'ne']);

/**
 * Operations that are never congruent to anything, including themselves.
 *
 * A call, an opaque clobber or an unrepresented operation may return a different
 * value each time it runs. Giving two of them the same number would let a
 * consumer replace the second with the first.
 */
const NEVER_CONGRUENT = new Set(['call', 'clobber', 'unknown']);

// Scalar identity includes the attributes owned by each public IR family.
// Unowned operations and incomplete descriptors remain singleton classes.
const SCALAR_ATTRIBUTES = Object.freeze({
  bin: ['negate', 'signed', 'float', 'roundingMode'],
  un: ['sourceBits', 'targetBits', 'float', 'roundingMode'],
  mov: ['castKind', 'sourceBits', 'targetBits'],
  mac: ['widen', 'negate', 'float', 'roundingMode'],
  cmp: ['comparison', 'signed', 'float', 'semanticComparisonCarrier'],
  sel: ['conditionValueId', 'conditionCarrierValueId'],
  bfx: ['lsb', 'width', 'signed'],
  bfi: ['lsb', 'width', 'bitfieldKind'],
});
const SCALAR_OPERATORS = Object.freeze({
  bin: new Set(['add', 'sub', 'mul', 'and', 'or', 'xor', 'bic', 'orn', 'eon', 'shl', 'lshr', 'ashr', 'ror', 'smull', 'umull', 'sdiv', 'udiv', 'eq', 'ne', 'lt', 'le', 'gt', 'ge']),
  un: new Set(['neg', 'not', 'bool', 'lnot', 'abs', 'sext', 'zext', 'trunc', 'clz', 'ctz', 'rbit', 'rev']),
  mov: new Set([null, 'copy', 'mov', 'sext', 'zext', 'trunc']),
  mac: new Set(['madd', 'msub']),
  cmp: new Set([null, 'sub', 'cmp', 'add']),
  sel: new Set([null, 'sel', 'inc', 'inv', 'neg']),
  bfx: new Set([null, 'bfx', 'sbfx', 'ubfx', 'extract']),
  bfi: new Set([null, 'bfi', 'bfxil', 'insert']),
});
function scalarAttribute(value) {
  if (value == null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError('phase8.gvn.unproven-semantic-attribute');
}
function argumentKey(argument, valueKey) {
  const value = argument?.value;
  if (value?.id == null || !Number.isSafeInteger(value.bits) || value.bits <= 0) return null;
  const key = valueKey(value);
  if (key == null) return null;
  const bits = argument.bits ?? value.bits;
  if (!Number.isSafeInteger(bits) || bits <= 0) return null;
  let shift = null;
  if (argument.shift != null) {
    const raw = argument.shift;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || typeof raw.op !== 'string' || !raw.op.trim()
      || !Number.isSafeInteger(raw.amount) || raw.amount < 0) return null;
    shift = [raw.op, raw.amount];
  }
  try {
    return JSON.stringify([key, bits, shift, scalarAttribute(argument.extend), scalarAttribute(argument.signed)]);
  } catch { return null; }
}
function scalarSemantics(instruction, produced, valueKey) {
  if (!Object.hasOwn(SCALAR_ATTRIBUTES, instruction.op)
    || !SCALAR_OPERATORS[instruction.op].has(instruction.sub ?? null)
    || !Number.isSafeInteger(produced.bits) || produced.bits <= 0) return null;
  if (instruction.extra?.float != null && instruction.extra.float !== false) return null;
  try {
    const attributes = SCALAR_ATTRIBUTES[instruction.op].map((field) => [field, scalarAttribute(instruction.extra?.[field])]);
    let condition = null;
    if (instruction.op === 'sel') {
      const predicate = instruction.conditionValue;
      const predicateKey = predicate == null ? null : valueKey(predicate);
      if (predicate != null && (predicate.bits !== 1 || predicateKey == null)) return null;
      const code = instruction.cond;
      if (code != null) {
        if (typeof code !== 'string' || !code.trim() || ['unknown', '?'].includes(code.trim().toLowerCase())) return null;
        if (predicate == null && (instruction.args?.length ?? 0) < 3) return null;
        condition = ['condition-code', code, predicateKey];
      } else if (predicate != null) {
        condition = ['predicate-value', predicateKey];
      } else {
        // The generic select carries a one-bit predicate first. A legacy
        // flags-select with no condition code is not that representation.
        const first = instruction.args?.[0]?.value;
        if (instruction.args?.length !== 3 || first?.bits !== 1 || valueKey(first) == null) return null;
        condition = ['predicate-first', valueKey(first)];
      }
    }
    if (instruction.op === 'bfx' || instruction.op === 'bfi') {
      const { lsb } = instruction.extra ?? {};
      const width = instruction.extra?.width ?? (instruction.sub === 'extract'
        ? produced.bits : instruction.sub === 'insert' ? instruction.args?.[1]?.value?.bits : null);
      const source = instruction.args?.[0]?.value;
      if (!Number.isSafeInteger(lsb) || lsb < 0 || !Number.isSafeInteger(width) || width <= 0
        || !Number.isSafeInteger(source?.bits) || lsb + width > source.bits) return null;
    }
    return JSON.stringify([scalarAttribute(instruction.bits), attributes, condition]);
  } catch { return null; }
}

function fail(code) { throw new TypeError(code); }

function memoryAccessOf(definition) {
  return definition?.extra?.memoryAccess ?? null;
}

/**
 * Whether a load may participate in value numbering at all.
 *
 * Reusing a load means executing it once where the program executed it twice, so
 * the question is not only "is the value the same" — MemorySSA answers that —
 * but "is the second execution unobservable". At machine level that turns on
 * three facts, and this predicate names each one against the vocabulary the
 * Semantic IR actually uses (`true | false | 'unknown'` for knowledge,
 * `relaxed | acquire | release | acq-rel | seq-cst | unknown` for ordering).
 *
 * Deliberately *not* required: proof that the access was not `volatile`.
 * `volatile` is a source-language annotation and cannot be recovered from a
 * stripped binary, so demanding it would make this capability unreachable on
 * every input forever rather than merely today. What matters at machine level is
 * that the access is to ordinary memory rather than a device, that it is not
 * atomic, and that it imposes no ordering. A positively volatile access still
 * blocks, because that is a fact rather than an absence of one.
 */
function loadIsReusable(definition) {
  const access = memoryAccessOf(definition);
  if (access == null) return { ok: false, reason: 'load carries no memory-access facts' };
  // Device or otherwise non-ordinary memory: re-execution is observable there
  // regardless of what the value is.
  if (access.addressSpace != null && access.addressSpace !== 'memory') {
    return { ok: false, reason: `access is to ${access.addressSpace}, not ordinary memory` };
  }
  if (access.volatility === true) return { ok: false, reason: 'the access is known to be volatile' };
  // Atomicity is machine-recoverable — the instruction encoding says whether an
  // access is exclusive or atomic — so `unknown` here is a missing upstream fact,
  // not an unknowable one, and unknown is not permission.
  if (access.atomic !== false) {
    return { ok: false, reason: `atomicity is ${access.atomic === true ? 'yes' : 'unknown'}` };
  }
  if (access.ordering != null && access.ordering !== 'unknown' && access.ordering !== 'relaxed') {
    return { ok: false, reason: `access imposes ordering: ${access.ordering}` };
  }
  if (definition.unknownAliasBarrier != null) {
    return { ok: false, reason: 'an unknown store lies between this load and its source' };
  }
  if (definition.loc?.key == null) {
    return { ok: false, reason: 'load has no canonical location key' };
  }
  if (definition.extra?.addressPrecise !== true) {
    return { ok: false, reason: 'load address is not proved precise' };
  }
  return { ok: true, reason: null };
}

/**
 * The memory version a load reads, taken from the IR's reaching definitions.
 *
 * Two loads are congruent only when this key matches. If the set of reaching
 * definitions cannot be determined the key is null, which makes the load a
 * singleton — the conservative answer.
 */
function memoryVersionKey(definition) {
  const use = definition?.memUse;
  if (use == null) return null;
  const reaching = use.memDefs ?? use.reaching ?? null;
  if (!Array.isArray(reaching)) return null;
  const ids = reaching.map((entry) => entry?.inst?.id ?? entry?.id ?? null);
  if (ids.some((id) => id == null)) return null;
  return ids.map(String).sort().join('|');
}

/**
 * Dominance, read from the IR rather than recomputed.
 *
 * Reuse requires the earlier definition to dominate the later one; otherwise the
 * "earlier" value may not have been computed on the path that reaches the reuse.
 */
function dominatorSets(ir) {
  const sets = new Map();
  const raw = ir?.dominators;
  if (raw instanceof Map) {
    for (const [block, dominators] of raw) sets.set(block, new Set(dominators));
    return sets;
  }
  if (Array.isArray(raw)) {
    raw.forEach((dominators, block) => sets.set(block, new Set(dominators ?? [])));
    return sets;
  }
  // Fall back to the immediate-dominator chain, which is the same information.
  const idom = ir?.idom;
  if (idom == null) return sets;
  const immediateOf = (block) => (idom instanceof Map ? idom.get(block) : idom[block]);
  for (const block of (ir.blocks ?? []).map((item) => item.index)) {
    const chain = new Set([block]);
    let current = immediateOf(block);
    let guard = 0;
    while (current != null && !chain.has(current) && guard < 4096) { chain.add(current); current = immediateOf(current); guard += 1; }
    sets.set(block, chain);
  }
  return sets;
}

function dominates(sets, earlierBlock, laterBlock) {
  if (earlierBlock == null || laterBlock == null) return false;
  if (earlierBlock === laterBlock) return true;
  return sets.get(laterBlock)?.has(earlierBlock) === true;
}

/**
 * Computes value numbers over one function.
 *
 * Values are numbered in a single pass over blocks in index order. That is
 * sufficient because congruence here is structural: a value's number depends
 * only on its operands' numbers, and an operand defined later in a loop simply
 * yields a singleton rather than a wrong class.
 */
export function runGvnPass(context = {}, budget = {}, area = null) {
  const analysis = context.analysis;
  const cfg = analysis?.get('cfg');
  const ssa = analysis?.get('ssa');
  const scalarFacts = analysis?.get('ranges');
  const blocks = cfg?.blocks ?? [];
  const values = ssa?.values ?? [];
  if (area == null) fail('phase8-gvn-requires-staging-area');
  const resolvedIdentity = context.resolvedAnalysisIdentity ?? canonicalAnalysisIdentity(context);
  if (!resolvedIdentity.valid || !analysisIdentityMatches(scalarFacts?.identity, resolvedIdentity.identity)) {
    return createPassResult({
      descriptor: GVN_PASS,
      status: 'unsupported',
      changed: false,
      completeness: 'unknown',
      stopReason: `invalid-identity:${resolvedIdentity.valid ? 'scalar range artifact is stale or missing identity' : resolvedIdentity.reason}`,
      diagnostics: [{
        severity: 'warning',
        code: 'phase8.gvn.identity',
        message: 'GVN refused to consume scalar facts without a matching canonical identity.',
        reason: resolvedIdentity.valid ? 'scalar range artifact is stale or missing identity' : resolvedIdentity.reason,
      }],
    });
  }

  const numbers = new Map();
  const classes = new Map();
  const singletonReasons = new Map();
  const reuseCandidates = [];
  const diagnostics = [];
  const dominatorsOf = dominatorSets(context.ir ?? { blocks, dominators: cfg?.dominators, idom: cfg?.idom });
  const valueById = new Map(values.map((value) => [value.id, value]));

  let nextNumber = 1;
  const keyToNumber = new Map();

  // Values with no defining operation — function arguments, incoming state,
  // anything the IR presents without a producer — are each their own class. They
  // are never visited by the instruction walk below, and leaving them unnumbered
  // makes every expression over them a singleton, which silently disables the
  // whole pass on exactly the operands real code is built from.
  const preNumber = (value) => {
    const number = nextNumber++;
    numbers.set(value.id, number);
    classes.set(number, [value.id]);
  };

  const singleton = (value, reason) => {
    const number = nextNumber++;
    numbers.set(value.id, number);
    classes.set(number, [value.id]);
    if (reason) singletonReasons.set(value.id, reason);
    return number;
  };

  const constantKey = (valueId) => {
    const canonicalFacts = scalarFacts?.facts;
    const canonical = canonicalFacts?.get?.(valueId) ?? null;
    if (canonicalFacts != null) {
      if (scalarFacts?.completeness === 'complete' && canonical?.constant != null
          && ['exact', 'conservative'].includes(canonical.status)) {
        return `const:${canonical.constant.bits}:${canonical.constant.value}`;
      }
      return null;
    }
    const constant = scalarFacts?.constants?.get(valueId);
    return constant == null ? null : `const:${constant.bits}:${constant.value}`;
  };

  const operandKey = (operand) => {
    if (operand == null) return null;
    // A proved constant is the same computation however it was produced, so the
    // constant itself is the key rather than the value that happened to hold it.
    const asConstant = constantKey(operand.id);
    if (asConstant != null) return asConstant;
    const number = numbers.get(operand.id);
    return number == null ? null : `vn:${number}`;
  };

  const abortedNow = () => {
    try { return typeof budget.shouldAbort === 'function' && budget.shouldAbort() === true; }
    catch { return true; }
  };

  for (const value of values) if (value.def == null) preNumber(value);

  let budgetExhausted = false;
  const ordered = [...blocks].sort((left, right) => left.index - right.index);
  for (const block of ordered) {
    if (budgetExhausted) break;
    // Phis merge values from different paths; two phis are congruent only if
    // their whole incoming set is, which this pass does not attempt.
    for (const phi of block.phis ?? []) {
      const produced = phi?.dst;
      if (produced != null) singleton(produced, 'phi values are not numbered');
    }
    for (const instruction of block.insts ?? []) {
      if (abortedNow()) { budgetExhausted = true; break; }
      const produced = instruction?.dst;
      if (produced == null) continue;

      if (NEVER_CONGRUENT.has(instruction.op)) {
        singleton(produced, `${instruction.op} may produce a different value each time it runs`);
        continue;
      }
      const semantics = scalarSemantics(instruction, produced, operandKey);
      const operands = (instruction.args ?? []).map((argument) => argumentKey(argument, operandKey));
      if (instruction.op !== 'load' && instruction.op !== 'const'
          && (semantics == null || operands.some((key) => key == null))) {
        // A cached constant is not a substitute for a well-defined operation.
        // Validate its semantic attributes before taking that shortcut.
        singleton(produced, 'an operand or family-specific semantic attribute is not proven');
        continue;
      }

      const constant = constantKey(produced.id);
      if (constant != null) {
        // Every proved constant of the same width and value is one class.
        const existing = keyToNumber.get(constant);
        if (existing != null) {
          numbers.set(produced.id, existing);
          classes.get(existing).push(produced.id);
        } else {
          const number = nextNumber++;
          keyToNumber.set(constant, number);
          numbers.set(produced.id, number);
          classes.set(number, [produced.id]);
        }
        continue;
      }

      if (instruction.op === 'load') {
        const reusable = loadIsReusable(instruction);
        if (!reusable.ok) { singleton(produced, reusable.reason); continue; }
        const version = memoryVersionKey(instruction);
        if (version == null) { singleton(produced, 'reaching memory definitions are not determined'); continue; }
        const key = `load:${instruction.loc.key}:${produced.bits}:${version}`;
        const existing = keyToNumber.get(key);
        if (existing == null) {
          const number = nextNumber++;
          keyToNumber.set(key, number);
          numbers.set(produced.id, number);
          classes.set(number, [produced.id]);
          continue;
        }
        numbers.set(produced.id, existing);
        classes.get(existing).push(produced.id);
        const earlier = valueById.get(classes.get(existing)[0]);
        if (earlier != null && dominates(dominatorsOf, earlier.def?.block, instruction.block)) {
          reuseCandidates.push({
            kind: 'load', valueId: produced.id, reuseOf: earlier.id,
            proof: `same location ${instruction.loc.key} at ${produced.bits} bits, same reaching memory definitions, no unknown-store barrier, and the earlier load dominates`,
          });
        }
        continue;
      }

      if (semantics == null || operands.some((key) => key == null)) {
        singleton(produced, 'an operand or family-specific semantic attribute is not proven');
        continue;
      }
      const ordering = instruction.op === 'bin' && COMMUTATIVE.has(instruction.sub) ? [...operands].sort() : operands;
      const key = JSON.stringify([instruction.op, instruction.sub ?? null, produced.bits, ordering, semantics]);
      const existing = keyToNumber.get(key);
      if (existing == null) {
        const number = nextNumber++;
        keyToNumber.set(key, number);
        numbers.set(produced.id, number);
        classes.set(number, [produced.id]);
        continue;
      }
      numbers.set(produced.id, existing);
      classes.get(existing).push(produced.id);
      const earlier = valueById.get(classes.get(existing)[0]);
      if (earlier != null && dominates(dominatorsOf, earlier.def?.block, instruction.block)) {
        reuseCandidates.push({
          kind: 'scalar', valueId: produced.id, reuseOf: earlier.id,
          proof: `identical ${instruction.op}/${instruction.sub ?? '-'} at ${produced.bits} bits over congruent operand views and identical semantic attributes, and the earlier definition dominates`,
        });
      }
    }
  }

  const congruentClasses = [...classes.values()].filter((members) => members.length > 1);
  // Published facts are snapshots: the working containers stay alive below (the
  // blocked-load diagnostic still reads singletonReasons), and a frozen Map
  // would still be mutable through Map.prototype.set. Consumers get read-only
  // views so canonical evidence cannot be rewritten in place.
  const facts = Object.freeze({
    passVersion: GVN_PASS.version,
    numbers: readonlyMap(numbers),
    classes: readonlyMap([...classes].map(([number, members]) => [number, Object.freeze([...members])])),
    congruentClassCount: congruentClasses.length,
    reuseCandidates: frozenEntries(reuseCandidates),
    // Why each value could not be numbered with anything else. A missed reuse
    // with no reason recorded is indistinguishable from a reuse nobody looked for.
    singletonReasons: readonlyMap(singletonReasons),
    completeness: budgetExhausted ? 'partial' : 'complete',
  });
  area.stage('valueNumbers', facts);

  if (budgetExhausted) {
    diagnostics.push({
      severity: 'warning',
      code: 'phase8.gvn.budget',
      message: 'Value numbering stopped before covering the whole function.',
      reason: 'The pass was cancelled; the classes published are sound but incomplete.',
    });
  }
  const blockedLoads = [...singletonReasons.entries()].filter(([valueId]) => valueById.get(valueId)?.def?.op === 'load');
  if (blockedLoads.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'phase8.gvn.load-not-reused',
      message: `${blockedLoads.length} loads were not reused.`,
      reason: [...new Set(blockedLoads.map(([, reason]) => reason))].slice(0, 4).join('; '),
    });
  }

  return createPassResult({
    descriptor: GVN_PASS,
    status: 'changed',
    changed: true,
    completeness: facts.completeness,
    transforms: [],
    produced: ['valueNumbers'],
    diagnostics,
    invalidated: [],
  });
}

export { loadIsReusable, memoryVersionKey };
