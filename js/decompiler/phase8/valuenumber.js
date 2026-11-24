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
function encodeScalar(value) {
  if (value == null) return 'n';
  if (typeof value === 'boolean') return value ? 'T' : 'F';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('phase8.gvn.unproven-semantic-attribute');
    return `#${value === 0 ? 0 : value}`;
  }
  if (typeof value === 'string') return `s${value.length}:${value}`;
  throw new TypeError('phase8.gvn.unproven-semantic-attribute');
}
function encodeAny(value) {
  if (value == null) return 'n';
  if (typeof value === 'boolean') return value ? 'T' : 'F';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? `#${value === 0 ? 0 : value}` : 'n';
  }
  if (typeof value === 'string') return `s${value.length}:${value}`;
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 'n' : `j${serialized.length}:${serialized}`;
}
function argumentKey(argument, valueKey) {
  const value = argument?.value;
  if (value?.id == null || !Number.isSafeInteger(value.bits) || value.bits <= 0) return null;
  const key = valueKey(value);
  if (key == null) return null;
  const bits = argument.bits ?? value.bits;
  if (!Number.isSafeInteger(bits) || bits <= 0) return null;
  let shiftKey = 'n';
  if (argument.shift != null) {
    const raw = argument.shift;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || typeof raw.op !== 'string' || !raw.op.trim()
      || !Number.isSafeInteger(raw.amount) || raw.amount < 0) return null;
    shiftKey = `S${raw.op.length}:${raw.op}#${raw.amount}`;
  }
  try {
    return `${key.length}:${key}|${bits}|${shiftKey}|${encodeScalar(argument.extend)}|${encodeScalar(argument.signed)}`;
  } catch { return null; }
}
function scalarSemantics(instruction, produced, valueKey) {
  if (!Object.hasOwn(SCALAR_ATTRIBUTES, instruction.op)
    || !SCALAR_OPERATORS[instruction.op].has(instruction.sub ?? null)
    || !Number.isSafeInteger(produced.bits) || produced.bits <= 0) return null;
  if (instruction.extra?.float != null && instruction.extra.float !== false) return null;
  try {
    const fields = SCALAR_ATTRIBUTES[instruction.op];
    let attrKey = '';
    for (let i = 0; i < fields.length; i += 1) {
      const field = fields[i];
      attrKey += `|${field}=${encodeScalar(instruction.extra?.[field])}`;
    }
    let condKey = 'n';
    if (instruction.op === 'sel') {
      const predicate = instruction.conditionValue;
      const predicateKey = predicate == null ? null : valueKey(predicate);
      if (predicate != null && (predicate.bits !== 1 || predicateKey == null)) return null;
      const code = instruction.cond;
      if (code != null) {
        if (typeof code !== 'string' || !code.trim() || ['unknown', '?'].includes(code.trim().toLowerCase())) return null;
        if (predicate == null && (instruction.args?.length ?? 0) < 3) return null;
        condKey = `C|s${code.length}:${code}|${predicateKey == null ? 'n' : `s${predicateKey.length}:${predicateKey}`}`;
      } else if (predicate != null) {
        condKey = `P|s${predicateKey.length}:${predicateKey}`;
      } else {
        // The generic select carries a one-bit predicate first. A legacy
        // flags-select with no condition code is not that representation.
        const first = instruction.args?.[0]?.value;
        const firstKey = first?.bits === 1 ? valueKey(first) : null;
        if (instruction.args?.length !== 3 || firstKey == null) return null;
        condKey = `F|s${firstKey.length}:${firstKey}`;
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
    return `${encodeScalar(instruction.bits)}${attrKey}|${condKey}`;
  } catch { return null; }
}

function fail(code) { throw new TypeError(code); }

function memoryAccessOf(definition) {
  return definition?.extra?.memoryAccess ?? null;
}

function loadWidthBitsOf(definition) {
  const access = memoryAccessOf(definition);
  const widthBits = access?.widthBits;
  return typeof widthBits === 'number' && Number.isSafeInteger(widthBits) && widthBits > 0 ? widthBits : null;
}

function normalizeLoadExtensionToken(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return 'unknown';
  const token = raw.trim().toLowerCase();
  if (!token) return null;
  if (token === 'sext' || token === 'sign' || token === 'sign-extend' || token === 'sign_extend' || token === 'signed' || token === 'sload') return 'sext';
  if (token === 'zext' || token === 'zero' || token === 'zero-extend' || token === 'zero_extend' || token === 'unsigned' || token === 'zload') return 'zext';
  if (token === 'raw' || token === 'none') return 'raw';
  return 'unknown';
}

function loadExtensionKindOf(definition, producedBits, widthBits) {
  const access = memoryAccessOf(definition);
  const extra = definition?.extra ?? null;
  const rawExt = extra?.extend ?? extra?.extension ?? access?.extend ?? access?.extension ?? definition?.sub ?? null;
  if (rawExt != null) {
    const normalized = normalizeLoadExtensionToken(rawExt);
    if (normalized === 'unknown') return null;
    if (normalized != null) return normalized;
  }
  const signedFlag = extra?.signed !== undefined ? extra.signed : access?.signed;
  if (signedFlag === true) return widthBits < producedBits ? 'sext' : 'sext';
  if (signedFlag === false) return widthBits < producedBits ? 'zext' : 'zext';
  if (signedFlag != null) return null;
  if (widthBits === producedBits) return 'raw';
  return null;
}

function loadCongruenceKey(instruction, produced, version) {
  if (!Number.isSafeInteger(produced?.bits) || produced.bits <= 0) {
    return { ok: false, key: null, reason: 'load destination width is unknown' };
  }
  const widthBits = loadWidthBitsOf(instruction);
  if (widthBits == null) {
    return { ok: false, key: null, reason: 'load memory access width is unknown' };
  }
  const extension = loadExtensionKindOf(instruction, produced.bits, widthBits);
  if (extension == null) {
    return { ok: false, key: null, reason: 'load extension kind is unknown' };
  }
  const access = memoryAccessOf(instruction);
  const key = `L|${encodeAny(instruction.loc.key)}|${produced.bits}|${widthBits}|${extension}|${encodeAny(access?.addressSpace ?? 'memory')}|${encodeAny(access?.volatility ?? null)}|${encodeAny(access?.atomic ?? null)}|${encodeAny(access?.ordering ?? null)}|${encodeAny(access?.endian ?? null)}|${instruction.extra?.float === true ? 'T' : 'F'}|${encodeAny(version)}`;
  return { ok: true, key, widthBits, extension, reason: null };
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
  // Ordering follows the same rule: an unproved `unknown` is not evidence of
  // "no ordering", and reuse across an unknown ordering is a wrong program.
  // Only an absent or explicit null, or an explicit `relaxed`, proves the
  // access imposes none (#5541).
  if (access.ordering != null && access.ordering !== 'relaxed') {
    return {
      ok: false,
      reason: access.ordering === 'unknown'
        ? 'access ordering is unproved'
        : `access imposes ordering: ${access.ordering}`,
    };
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
        const loadKey = loadCongruenceKey(instruction, produced, version);
        if (!loadKey.ok) { singleton(produced, loadKey.reason); continue; }
        const key = loadKey.key;
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
            proof: `same location ${instruction.loc.key} at ${loadKey.widthBits}-bit access (${loadKey.extension}) to ${produced.bits} bits, same reaching memory definitions, no unknown-store barrier, and the earlier load dominates`,
          });
        }
        continue;
      }

      if (semantics == null || operands.some((key) => key == null)) {
        singleton(produced, 'an operand or family-specific semantic attribute is not proven');
        continue;
      }
      const isCommutative = instruction.op === 'bin' && COMMUTATIVE.has(instruction.sub);
      let ordKey;
      if (isCommutative && operands.length === 2) {
        const a = operands[0];
        const b = operands[1];
        ordKey = a <= b
          ? `2|${a.length}:${a}|${b.length}:${b}`
          : `2|${b.length}:${b}|${a.length}:${a}`;
      } else {
        const ordering = isCommutative ? [...operands].sort() : operands;
        ordKey = `${ordering.length}`;
        for (let oi = 0; oi < ordering.length; oi += 1) {
          const item = ordering[oi];
          ordKey += `|${item.length}:${item}`;
        }
      }
      const sub = instruction.sub ?? null;
      const key = `${instruction.op}|${sub == null ? 'n' : `s${sub.length}:${sub}`}|${produced.bits}|${ordKey}|${semantics}`;
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
