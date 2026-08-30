/**
 * Sparse conditional constant propagation, with a wrapped range beside every
 * lattice cell.
 *
 * Two properties matter more than the folding itself.
 *
 * Executable edges. A phi meets only its executable predecessors, and an edge is
 * executable only when it was *proved* reachable, never when it merely looks
 * plausible. That is what separates SCCP from ordinary constant propagation: a
 * value that is constant on every path the program can take stays constant even
 * though a dead path assigns something else.
 *
 * Exact widths. Every fold goes through the bitvector module, so `0xFFFFFFF0 + 0x20`
 * is `0x10` at 32 bits and not `0x100000010`. An operation that cannot be
 * modelled exactly — an architecture-defined shift, a division that can trap, a
 * comparison whose flag semantics belong to the target — makes the value
 * overdefined and records why. Guessing there would produce a confident wrong
 * answer, which is the one thing the architecture forbids outright.
 *
 * This pass is generic. It names no register, no flag and no ABI: the IR has
 * already lowered branch conditions to one-bit values, so nothing here needs to
 * know what `nzcv` or `eflags` mean.
 */

import {
  bitvector, evaluateBinary, evaluateUnary, extractField, insertField,
  isSupportedWidth, maxUnsigned, sameBitvector, signExtend, truncate, zeroExtend,
} from './bitvector.js';
import {
  describeRange, emptyRange, fullRange, join, sameRange, singleton,
  evaluateBinaryFact, factFromRange, fullFact, emptyFact,
  joinFacts, sameFact, signExtendFact, truncateFact, widenFacts, zeroExtendFact,
  refineComparisonFacts,
} from './range.js';
import { createPassDescriptor, createPassResult } from './contract.js';
import { stableDigest } from '../../core/identity/index.js';
import { canonicalAnalysisIdentity } from './analysis-identity.js';

export const SCCP_PASS = createPassDescriptor({
  id: 'phase8.sccp',
  version: '2.0.0',
  stage: 'scalar-optimization',
  budgetClass: 'standard',
  consumes: ['cfg', 'ssa'],
  // Ranges are the canonical scalar input to these derived products. Replacing
  // them makes an older value-number, induction or aggregate result stale even
  // though SCCP itself does not rewrite the program.
  preserves: ['cfg', 'dominators', 'loops', 'ssa', 'memorySsa', 'alias', 'effects', 'deadCode', 'types', 'summaries', 'origins', 'structuredRegions', 'providerHints'],
  invalidates: ['aggregates', 'induction', 'valueNumbers'],
  produces: ['ranges'],
  description: 'Executable-edge-aware constant propagation with an exact-width wrapped range domain.',
});

/** Lattice cells. UNDEFINED is the top: not yet known to be reachable at all. */
export const UNDEFINED = 'undefined';
export const CONSTANT = 'constant';
export const OVERDEFINED = 'overdefined';

const TOP = Object.freeze({ state: UNDEFINED, constant: null, reason: null });
const COMPARISON_OPERATORS = new Set(['eq', 'ne', 'ult', 'ule', 'ugt', 'uge', 'slt', 'sle', 'sgt', 'sge', '=', '==', '!=', '<', '<=', '>', '>=']);

function constantCell(constant) {
  return Object.freeze({ state: CONSTANT, constant, reason: null });
}

function overdefined(reason) {
  return Object.freeze({ state: OVERDEFINED, constant: null, reason: reason ?? null });
}

/**
 * Meet. Two different constants are overdefined; a constant met with top stays
 * the constant, which is exactly what lets an unreachable predecessor contribute
 * nothing to a phi.
 */
export function meet(left, right) {
  if (left.state === UNDEFINED) return right;
  if (right.state === UNDEFINED) return left;
  if (left.state === OVERDEFINED) return left;
  if (right.state === OVERDEFINED) return right;
  if (sameBitvector(left.constant, right.constant)) return left;
  return overdefined('predecessors disagree');
}

/** Widening threshold. Convergence has to be bounded, not merely likely. */
const DEFAULT_LIMITS = Object.freeze({
  maxVisitsPerValue: 6,
  // The primary bound is work, not wall clock, so the point at which SCCP stops
  // is a property of the input rather than of the machine. The heaviest function
  // in the frozen corpus reaches ~5,400 items; the bound is set an order of
  // magnitude above that so it limits pathological inputs without truncating
  // ordinary ones.
  maxWorkItems: 50000,
});

function normalizeLimits(raw) {
  const limits = { ...DEFAULT_LIMITS };
  const invalid = [];
  if (raw == null) return { limits, invalid };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      limits: { ...limits, maxVisitsPerValue: 0, maxWorkItems: 0 },
      invalid: ['sccpLimits must be a plain object'],
    };
  }
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (!Object.hasOwn(raw, key)) continue;
    let value;
    try { value = raw[key]; } catch { value = null; }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      limits[key] = value;
    } else {
      limits[key] = 0;
      invalid.push(`${key} must be a finite non-negative safe integer`);
    }
  }
  return { limits, invalid };
}

function widthOf(value) {
  const bits = Number(value?.bits ?? 0);
  return isSupportedWidth(bits) ? bits : null;
}

function constantOfValue(value) {
  const bits = widthOf(value);
  if (bits == null) return null;
  const raw = value?.def?.extra?.value ?? value?.const;
  if (raw == null) return null;
  try { return bitvector(raw, bits); } catch { return null; }
}

function valueProvenance(value) {
  const ids = [
    ...(Array.isArray(value?.origin?.instructionIds) ? value.origin.instructionIds : []),
    ...(Array.isArray(value?.def?.origin?.instructionIds) ? value.def.origin.instructionIds : []),
  ];
  const inputValueIds = [
    ...(Array.isArray(value?.def?.args) ? value.def.args.map((argument) => argument?.value?.id) : []),
    ...(Array.isArray(value?.def?.incoming) ? value.def.incoming.map((incoming) => incoming?.value?.id) : []),
  ].filter((id) => id != null).sort((left, right) => Number(left) - Number(right));
  const provenance = Object.freeze({
    valueId: value?.id ?? null,
    definitionBlock: value?.def?.block ?? null,
    instructionIds: Object.freeze([...new Set(ids)].sort()),
    inputValueIds: Object.freeze([...new Set(inputValueIds)]),
    operation: value?.def?.op ?? null,
    operator: value?.def?.sub ?? null,
  });
  return provenance;
}

// A frozen Map is still mutable through Map.prototype.set. Publication uses a
// small read-only view backed by a private snapshot so consumers can inspect
// facts without changing the digest-bearing artifact after the pass returns.
function readonlyMap(source) {
  const snapshot = new Map(source);
  const view = {
    get size() { return snapshot.size; },
    get(key) { return snapshot.get(key); },
    has(key) { return snapshot.has(key); },
    keys() { return snapshot.keys(); },
    values() { return snapshot.values(); },
    entries() { return snapshot.entries(); },
    forEach(callback, thisArg) {
      return snapshot.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
    [Symbol.iterator]() { return snapshot[Symbol.iterator](); },
  };
  return Object.freeze(view);
}

function immutableSnapshot(value, active = new Set()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object' || active.has(value)) return null;
  active.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => immutableSnapshot(item, active)));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const copy = {};
    for (const key of Object.keys(value).sort()) copy[key] = immutableSnapshot(value[key], active);
    return Object.freeze(copy);
  } catch {
    return null;
  } finally {
    active.delete(value);
  }
}

function attachValueProvenance(fact, value) {
  if (fact == null) return fact;
  const prior = fact.provenance ?? {};
  const own = valueProvenance(value);
  if (Object.keys(prior).length === 0) {
    return Object.freeze({
      ...fact,
      valueId: value?.id ?? fact.valueId ?? null,
      provenance: own,
    });
  }
  const instructionIds = [
    ...(Array.isArray(prior.instructionIds) ? prior.instructionIds : []),
    ...own.instructionIds,
  ];
  const inputValueIds = [
    ...(Array.isArray(prior.inputValueIds) ? prior.inputValueIds : []),
    ...own.inputValueIds,
  ];
  return Object.freeze({
    ...fact,
    valueId: value?.id ?? fact.valueId ?? null,
    provenance: Object.freeze({
      ...prior,
      valueId: value?.id ?? fact.valueId ?? null,
      definitionBlock: value?.def?.block ?? prior.definitionBlock ?? null,
      instructionIds: Object.freeze([...new Set(instructionIds)].sort()),
      inputValueIds: Object.freeze([...new Set(inputValueIds)].sort((left, right) => Number(left) - Number(right))),
      operation: own.operation ?? prior.operation ?? null,
      operator: own.operator ?? prior.operator ?? null,
    }),
  });
}

/** The generic operator name for a definition, or null when it is not modelled. */
function operatorOf(definition) {
  const op = definition?.op;
  const sub = definition?.sub;
  if (op === 'bin') return { kind: 'binary', operator: sub };
  if (op === 'un') return { kind: 'unary', operator: sub };
  if (op === 'mov') {
    if (sub == null) return { kind: 'copy', operator: 'copy' };
    if (sub === 'trunc' || sub === 'zext' || sub === 'sext') return { kind: 'cast', operator: sub };
    return null;
  }
  if (op === 'bfx' && sub === 'extract') return { kind: 'extract', operator: 'extract' };
  if (op === 'bfi' && sub === 'insert') return { kind: 'insert', operator: 'insert' };
  if (op === 'sel') return { kind: 'select', operator: 'select' };
  if (op === 'const') return { kind: 'const', operator: 'const' };
  return null;
}

function argumentValues(definition) {
  return (definition?.args ?? []).map((argument) => argument?.value ?? null);
}

/**
 * The reason a definition is not foldable.
 *
 * Recorded rather than swallowed, so a missed optimization is visible as a
 * missed optimization instead of looking like an operation nobody tried.
 */
function unmodelledReason(definition) {
  const op = definition?.op;
  if (op === 'load') return 'value comes from memory';
  if (op === 'cmp') return 'comparison result depends on target-defined flag semantics';
  if (op === 'clobber') return 'value is clobbered by an opaque operation';
  if (op === 'unknown') return 'operation is not represented in the semantic IR';
  if (op === 'call') return 'value is produced by a call';
  return `operation is not modelled: ${op}${definition?.sub ? `/${definition.sub}` : ''}`;
}

/**
 * Runs SCCP over one function's canonical CFG and SSA facts.
 *
 * `analysis` is the authoritative state; the pass reads `cfg` and `ssa` from it
 * and stages `ranges`. It never writes to the IR.
 */
export function runSccpPass(context = {}, budget = {}, area = null) {
  const analysis = context.analysis;
  const cfg = analysis?.get('cfg');
  const ssa = analysis?.get('ssa');
  const blocks = cfg?.blocks ?? [];
  const values = ssa?.values ?? [];
  const resolvedIdentity = context.resolvedAnalysisIdentity ?? canonicalAnalysisIdentity(context);
  if (!resolvedIdentity.valid) {
    return createPassResult({
      descriptor: SCCP_PASS,
      status: 'unsupported',
      changed: false,
      completeness: 'unknown',
      stopReason: `invalid-identity:${resolvedIdentity.reason}`,
      diagnostics: [{
        severity: 'warning',
        code: 'phase8.sccp.identity',
        message: 'SCCP refused to publish scalar facts without a validated canonical identity.',
        reason: resolvedIdentity.reason,
      }],
    });
  }
  const normalizedLimits = normalizeLimits(context.sccpLimits);
  const limits = normalizedLimits.limits;

  const cells = new Map();
  const ranges = new Map();
  const facts = new Map();
  const edgeFacts = new Map();
  const visits = new Map();
  const executableEdges = new Set();
  const executableBlocks = new Set();
  // Executable predecessors per block, maintained alongside the edge set. A phi
  // asks "is this predecessor reachable" once per incoming value per revisit;
  // answering it by scanning the edge set made that O(edges) and dominated the
  // whole pass on a 300-value function (EP-016: profile the hot path).
  const executablePredecessors = new Map();
  const diagnostics = [];
  let widened = 0;
  let work = 0;
  if (normalizedLimits.invalid.length > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'phase8.sccp.invalid-budget',
      message: 'SCCP received an invalid resource limit and published a conservative partial result.',
      reason: normalizedLimits.invalid.join('; '),
    });
  }
  let budgetExhausted = normalizedLimits.invalid.length > 0;

  const valueById = new Map(values.map((value) => [value.id, value]));
  const blockByIndex = new Map(blocks.map((block) => [block.index, block]));

  const cellOf = (value) => (value == null ? overdefined('missing operand') : cells.get(value.id) ?? TOP);
  const factOfValue = (value) => {
    if (value == null) return null;
    const known = facts.get(value.id);
    if (known != null) return known;
    const range = ranges.get(value.id);
    const bits = widthOf(value);
    return range == null || bits == null ? null : factFromRange(range, { valueId: value.id });
  };
  const rangeOfValue = (value) => {
    if (value == null) return null;
    const knownFact = facts.get(value.id);
    if (knownFact?.range) return knownFact.range;
    const known = ranges.get(value.id);
    if (known) return known;
    const bits = widthOf(value);
    return bits == null ? null : fullRange(bits);
  };

  // Worklists are queues, not stacks.  Keeping a cursor avoids O(n) Array.shift
  // churn on loop-heavy functions, while the pending sets collapse the many
  // duplicate notifications produced when one fact change fans out to several
  // uses.  A queued value is always evaluated after the latest predecessor
  // update, so coalescing notifications does not skip a fixed-point step.
  const valueWorklist = [];
  let valueWorkHead = 0;
  const pendingValues = new Set();
  const enqueueValue = (valueId) => {
    if (valueId == null || pendingValues.has(valueId)) return;
    pendingValues.add(valueId);
    valueWorklist.push(valueId);
  };
  const hasValueWork = () => valueWorkHead < valueWorklist.length;
  const takeValue = () => {
    const valueId = valueWorklist[valueWorkHead++];
    pendingValues.delete(valueId);
    if (valueWorkHead > 1024 && valueWorkHead * 2 >= valueWorklist.length) {
      valueWorklist.splice(0, valueWorkHead);
      valueWorkHead = 0;
    }
    return valueId;
  };

  const blockWorklist = [];
  let blockWorkHead = 0;
  const pendingBlocks = new Set();
  const enqueueBlock = (blockIndex) => {
    if (blockIndex == null || pendingBlocks.has(blockIndex)) return;
    pendingBlocks.add(blockIndex);
    blockWorklist.push(blockIndex);
  };
  const hasBlockWork = () => blockWorkHead < blockWorklist.length;
  const takeBlock = () => {
    const blockIndex = blockWorklist[blockWorkHead++];
    pendingBlocks.delete(blockIndex);
    if (blockWorkHead > 1024 && blockWorkHead * 2 >= blockWorklist.length) {
      blockWorklist.splice(0, blockWorkHead);
      blockWorkHead = 0;
    }
    return blockIndex;
  };

  function markEdge(from, to, kind) {
    const key = `${from}->${to}:${kind}`;
    if (executableEdges.has(key)) return;
    executableEdges.add(key);
    if (!executablePredecessors.has(to)) executablePredecessors.set(to, new Set());
    executablePredecessors.get(to).add(from);
    if (!executableBlocks.has(to)) {
      executableBlocks.add(to);
      enqueueBlock(to);
    } else {
      // The block was already reachable, but a new incoming edge changes every
      // phi in it: a predecessor that used to contribute nothing now does.
      for (const phi of blockByIndex.get(to)?.phis ?? []) if (phi?.dst?.id != null) enqueueValue(phi.dst.id);
    }
  }

  function setCell(valueId, proposed, proposedRange, proposedFact = null) {
    const previous = cells.get(valueId) ?? TOP;
    const previousFact = facts.get(valueId) ?? (ranges.get(valueId)
      ? factFromRange(ranges.get(valueId), { valueId })
      : null);
    const previousRange = previousFact?.range ?? ranges.get(valueId) ?? null;
    const seen = (visits.get(valueId) ?? 0) + 1;
    visits.set(valueId, seen);

    // Cells only ever move down the lattice. Re-evaluating a value can transiently
    // read an operand as not-yet-evaluated, and letting the cell climb back to
    // top on that reading makes the worklist oscillate forever instead of
    // converging — the whole analysis then reports `partial` on a five-block
    // function. Meeting with the previous cell is what makes the chain finite.
    const next = meet(previous, proposed);

    // Product facts ascend by union for the same reason: a monotone chain plus
    // widening is what bounds convergence. The compatibility range is derived
    // from this one product, never maintained as a second truth.
    let candidateFact = proposedFact ?? (proposedRange == null ? null : factFromRange(proposedRange, { valueId }));
    if (candidateFact != null && candidateFact.valueId !== valueId) candidateFact = Object.freeze({ ...candidateFact, valueId });
    let effectiveFact = candidateFact;
    if (previousFact != null && candidateFact != null && previousFact.bits === candidateFact.bits) {
      // Provenance is attached once, when a changed fact is committed below;
      // keeping it out of the lattice join avoids repeatedly unioning origin
      // arrays while a loop revisits a scalar value.
      effectiveFact = joinFacts(previousFact, candidateFact, { provenance: false });
      if (!sameFact(previousFact, effectiveFact) && seen > limits.maxVisitsPerValue) {
        // A value that keeps moving is widened rather than chased; the
        // alternative is a fixed point that exists in theory and not inside a
        // browser budget.
        effectiveFact = widenFacts(previousFact, effectiveFact);
        widened += 1;
      }
      if (effectiveFact.valueId !== valueId) effectiveFact = Object.freeze({ ...effectiveFact, valueId });
    }
    const effectiveRange = effectiveFact?.range ?? proposedRange;

    // Two cells are equal when the state matches and either both carry no
    // constant or they carry the same one. `sameBitvector(null, null)` is false
    // by design — a missing constant is not a constant — so comparing cells
    // through it alone reports a change on every revisit of an overdefined
    // value, and the worklist never terminates.
    const sameConstant = previous.constant == null && next.constant == null
      ? true
      : sameBitvector(previous.constant, next.constant);
    const cellChanged = previous.state !== next.state || !sameConstant;
    const rangeChanged = effectiveRange != null && (previousRange == null || !sameRange(previousRange, effectiveRange));
    const factChanged = effectiveFact != null && !sameFact(previousFact, effectiveFact);
    if (!cellChanged && !rangeChanged && !factChanged) return;
    // Provenance is needed only for a fact that will actually be committed.
    // Attaching it before the no-change check cloned instruction/input arrays
    // on every loop revisit even when the semantic fact was unchanged.  The
    // delayed attachment preserves the same publication contents while keeping
    // SCCP's bounded work path allocation-stable.
    if (effectiveFact != null) {
      effectiveFact = attachValueProvenance(effectiveFact, valueById.get(valueId));
    }
    cells.set(valueId, next);
    if (effectiveRange != null) ranges.set(valueId, effectiveRange);
    if (effectiveFact != null) facts.set(valueId, effectiveFact);
    for (const use of valueById.get(valueId)?.uses ?? []) {
      const target = use?.dst?.id ?? use?.id;
      if (target != null) enqueueValue(target);
    }
    // A use list that does not cover phis in successor blocks would leave a phi
    // stale, so successors' phis are re-queued explicitly.
    const definition = valueById.get(valueId)?.def;
    const block = definition?.block;
    if (block != null) {
      for (const successor of blockByIndex.get(block)?.succ ?? []) {
        for (const phi of blockByIndex.get(successor)?.phis ?? []) if (phi?.dst?.id != null) enqueueValue(phi.dst.id);
      }
    }
  }

  function evaluatePhi(value) {
    const definition = value.def;
    const bits = widthOf(value);
    let cell = TOP;
    let range = bits == null ? null : emptyRange(bits);
    let fact = bits == null ? null : emptyFact(bits, { valueId: value.id });
    let contributed = false;
    for (const incoming of definition?.incoming ?? []) {
      const from = incoming?.from;
      const source = incoming?.value;
      if (from == null) return {
        cell: overdefined('phi predecessor is unknown'),
        range: bits == null ? null : fullRange(bits),
        fact: bits == null ? null : fullFact(bits, { valueId: value.id, reason: 'phi predecessor is unknown' }),
      };
      // Only executable predecessors contribute. This is the whole point of the
      // "conditional" in SCCP.
      if (!executablePredecessors.get(definition.block)?.has(from)) continue;
      contributed = true;
      cell = meet(cell, cellOf(source));
      const sourceFact = factOfValue(source);
      const sourceRange = sourceFact?.range ?? rangeOfValue(source);
      if (bits != null && sourceFact != null && sourceFact.bits === bits) fact = joinFacts(fact, sourceFact, { provenance: false });
      else if (bits != null && sourceRange != null && sourceRange.bits === bits) fact = joinFacts(fact, factFromRange(sourceRange, {
        valueId: value.id,
      }), { provenance: false });
      else if (bits != null) fact = fullFact(bits, { valueId: value.id, reason: 'phi incoming width disagrees' });
    }
    // A reachable phi with no executable incoming edge is not the empty set.
    // The empty seed is an implementation detail; publishing it would let a
    // missing predecessor masquerade as a proof that the value is dead.
    if (!contributed && bits != null) {
      return {
        cell: overdefined('phi has no executable predecessors'),
        range: fullRange(bits),
        fact: fullFact(bits, { valueId: value.id, reason: 'phi has no executable predecessors' }),
      };
    }
    range = fact?.range ?? range;
    if (fact?.valueId !== value.id && fact != null) fact = Object.freeze({ ...fact, valueId: value.id });
    return { cell, range, fact };
  }

  function evaluateValue(value) {
    const definition = value.def;
    const bits = widthOf(value);
    if (bits == null) return { cell: overdefined(`unsupported width: ${value?.bits}`), range: null };
    if (value.kind === 'phi' || definition?.op === 'phi') return evaluatePhi(value);
    if (value.kind === 'arg' || value.kind === 'undef' || definition == null) {
      return { cell: overdefined(value.kind === 'arg' ? 'function argument' : 'value has no definition'), range: fullRange(bits) };
    }

    const shape = operatorOf(definition);
    if (shape == null) {
      return { cell: overdefined(unmodelledReason(definition)), range: fullRange(bits) };
    }
    if (shape.kind === 'const') {
      const constant = constantOfValue(value);
      return constant == null
        ? { cell: overdefined('constant has no representable value'), range: fullRange(bits) }
        : { cell: constantCell(constant), range: singleton(constant) };
    }

    const operands = argumentValues(definition);
    const operandCells = operands.map((operand) => cellOf(operand));
    // An operand nobody has reached yet leaves this value at top too: concluding
    // anything from an unevaluated operand would be reading uninitialised state.
    if (operandCells.some((cell) => cell.state === UNDEFINED)) return { cell: TOP, range: null };

    const constants = operandCells.map((cell) => cell.constant);
    const allConstant = operandCells.every((cell) => cell.state === CONSTANT);

    if (shape.kind === 'copy') {
      const source = operands[0];
      const cell = operandCells[0] ?? overdefined('copy has no source');
      const sourceFact = factOfValue(source);
      const sourceRange = rangeOfValue(source);
      if (cell.state === CONSTANT && cell.constant.bits !== bits) {
        // A copy that changes width is a cast the IR did not label; do not
        // silently reinterpret the bits.
        return { cell: overdefined('copy changes width without a declared cast'), range: fullRange(bits) };
      }
      const copiedFact = sourceFact != null && sourceFact.bits === bits
        ? sourceFact
        : factFromRange(sourceRange && sourceRange.bits === bits ? sourceRange : fullRange(bits), {
          valueId: value.id,
        });
      return { cell, range: copiedFact.range, fact: Object.freeze({ ...copiedFact, valueId: value.id }) };
    }

    if (shape.kind === 'cast') {
      const source = operands[0];
      const sourceRange = rangeOfValue(source);
      if (allConstant) {
        const folded = shape.operator === 'trunc' ? truncate(constants[0], bits)
          : shape.operator === 'zext' ? zeroExtend(constants[0], bits)
            : signExtend(constants[0], bits);
        if (folded != null) return { cell: constantCell(folded), range: singleton(folded) };
        return { cell: overdefined(`cast is not representable: ${shape.operator}`), range: fullRange(bits) };
      }
      if (sourceRange == null) return { cell: overdefined('cast source has no range'), range: fullRange(bits) };
      const sourceFact = factOfValue(source) ?? factFromRange(sourceRange, {
        valueId: source?.id ?? null,
      });
      const castedFact = shape.operator === 'trunc' ? truncateFact(sourceFact, bits)
        : shape.operator === 'zext' ? zeroExtendFact(sourceFact, bits)
          : signExtendFact(sourceFact, bits);
      const widenedRange = { range: castedFact.range, exact: castedFact.status === 'exact', reason: castedFact.reason };
      if (!widenedRange.exact && widenedRange.reason) {
        diagnostics.push({
          severity: 'info',
          code: 'phase8.sccp.precision-loss',
          message: `Range precision lost across ${shape.operator} for value ${value.id}.`,
          reason: widenedRange.reason,
        });
      }
      return { cell: overdefined(`operand of ${shape.operator} is not constant`), range: widenedRange.range, fact: Object.freeze({ ...castedFact, valueId: value.id }) };
    }

    if (shape.kind === 'unary') {
      if (allConstant) {
        const folded = evaluateUnary(shape.operator, constants[0]);
        if (folded != null && folded.bits === bits) return { cell: constantCell(folded), range: singleton(folded) };
        if (folded != null) return { cell: overdefined('unary result width disagrees with the value width'), range: fullRange(bits) };
      }
      if (shape.operator === 'sext') {
        // `un/sext` is a cast spelled as a unary operation.
        const sourceRange = rangeOfValue(operands[0]);
        if (allConstant) {
          const folded = signExtend(constants[0], bits);
          if (folded != null) return { cell: constantCell(folded), range: singleton(folded) };
        }
        if (sourceRange != null) {
          const sourceFact = factOfValue(operands[0]) ?? factFromRange(sourceRange, {
            valueId: operands[0]?.id ?? null,
          });
          const castedFact = signExtendFact(sourceFact, bits);
          return { cell: overdefined('operand is not constant'), range: castedFact.range, fact: Object.freeze({ ...castedFact, valueId: value.id }) };
        }
      }
      return { cell: overdefined(`unary ${shape.operator} is not foldable here`), range: fullRange(bits) };
    }

    if (shape.kind === 'binary') {
      const isComparison = COMPARISON_OPERATORS.has(shape.operator);
      // A comparison is a one-bit semantic value regardless of the width a
      // malformed producer put on its destination.  Never widen the result to
      // the operand/destination width: that would publish a fabricated scalar
      // (and can make a branch treat arbitrary bits as a predicate).
      const resultBits = isComparison ? 1 : bits;
      if (isComparison && bits !== 1) {
        const malformed = fullFact(1, {
          valueId: value.id,
          status: 'malformed',
          reason: 'comparison result width is not one bit',
          provenance: valueProvenance(value),
        });
        return {
          cell: overdefined('comparison result width is not one bit'),
          range: malformed.range,
          fact: malformed,
        };
      }
      if (allConstant) {
        const folded = evaluateBinary(shape.operator, constants[0], constants[1]);
        if (folded != null && folded.bits === resultBits) return { cell: constantCell(folded), range: singleton(folded) };
        if (folded == null) {
          const reason = `binary ${shape.operator} is not exactly modelled for these operands`;
          diagnostics.push({
            severity: 'info',
            code: 'phase8.sccp.unmodelled-operation',
            message: `Value ${value.id} was not folded.`,
            reason,
          });
          return { cell: overdefined(reason), range: fullRange(resultBits) };
        }
        return { cell: overdefined('binary result width disagrees with the value width'), range: fullRange(resultBits) };
      }
      const leftFact = factOfValue(operands[0]);
      const rightFact = factOfValue(operands[1]);
      const leftRange = leftFact?.range ?? rangeOfValue(operands[0]);
      const rightRange = rightFact?.range ?? rangeOfValue(operands[1]);
      if (leftRange == null || rightRange == null) return { cell: overdefined('operand has no range'), range: fullRange(resultBits) };
      const combined = evaluateBinaryFact(shape.operator,
        leftFact ?? factFromRange(leftRange, {
          valueId: operands[0]?.id ?? null,
        }),
        rightFact ?? factFromRange(rightRange, {
          valueId: operands[1]?.id ?? null,
        }), { provenance: false });
      return {
        cell: overdefined(`operands of ${shape.operator} are not both constant`),
        range: combined.range.bits === resultBits ? combined.range : fullRange(resultBits),
        fact: Object.freeze({ ...combined, valueId: value.id }),
      };
    }

    if (shape.kind === 'extract') {
      if (allConstant) {
        const low = definition.extra?.lsb ?? definition.extra?.low ?? definition.extra?.offset;
        const folded = low == null ? null : extractField(constants[0], low, bits);
        if (folded != null) return { cell: constantCell(folded), range: singleton(folded) };
      }
      return { cell: overdefined('bit-field extract is not foldable here'), range: fullRange(bits) };
    }

    if (shape.kind === 'insert') {
      if (allConstant && constants.length >= 2) {
        const low = definition.extra?.lsb ?? definition.extra?.low ?? definition.extra?.offset;
        const folded = low == null ? null : insertField(constants[0], constants[1], low);
        if (folded != null && folded.bits === bits) return { cell: constantCell(folded), range: singleton(folded) };
      }
      return { cell: overdefined('bit-field insert is not foldable here'), range: fullRange(bits) };
    }

    if (shape.kind === 'select') {
      const conditionCell = operandCells[0];
      if (conditionCell?.state === CONSTANT) {
        // The condition decides which arm survives; the other contributes
        // nothing, exactly as an unreachable phi predecessor does.
        const chosen = conditionCell.constant.value === 0n ? operandCells[2] : operandCells[1];
        const chosenValue = conditionCell.constant.value === 0n ? operands[2] : operands[1];
        if (chosen != null) {
          const chosenFact = factOfValue(chosenValue);
          const chosenRange = chosenFact?.range ?? rangeOfValue(chosenValue);
          const resultFact = chosenFact && chosenFact.bits === bits
            ? Object.freeze({ ...chosenFact, valueId: value.id })
            : factFromRange(chosenRange && chosenRange.bits === bits ? chosenRange : fullRange(bits), {
              valueId: value.id,
            });
          return { cell: chosen, range: resultFact.range, fact: resultFact };
        }
      }
      const armFacts = [factOfValue(operands[1]), factOfValue(operands[2])].filter((fact) => fact?.bits === bits);
      const armRanges = armFacts.map((fact) => fact.range);
      return {
        cell: meet(operandCells[1] ?? overdefined('select arm missing'), operandCells[2] ?? overdefined('select arm missing')),
        range: armRanges.length === 2 ? join(armRanges[0], armRanges[1]) : fullRange(bits),
        fact: armFacts.length === 2 ? Object.freeze({ ...joinFacts(armFacts[0], armFacts[1], { provenance: false }), valueId: value.id }) : fullFact(bits, { valueId: value.id, reason: 'select arm fact missing' }),
      };
    }

    return { cell: overdefined('operation shape is not modelled'), range: fullRange(bits) };
  }

  function evaluate(value) {
    const result = evaluateValue(value);
    if (result == null || result.range == null) return result;
    if (result.fact != null) return result;
    return {
      ...result,
      fact: factFromRange(result.range, {
        valueId: value.id,
        reason: result.cell?.reason,
      }),
    };
  }

  function edgeKey(from, to, kind) { return `${from}->${to}:${kind}`; }

  function recordEdgeFact(from, edge, { reachable = true, factsForEdge = new Map(), predicate = null } = {}) {
    if (edge?.to == null) return;
    const key = edgeKey(from, edge.to, edge.kind ?? 'branch');
    const orderedFacts = [...factsForEdge.entries()]
      .filter(([valueId, fact]) => valueId != null && fact != null)
      .sort(([left], [right]) => Number(left) - Number(right));
    const factMap = new Map(orderedFacts);
    const existing = edgeFacts.get(key);
    // Reachability is monotone. A previously accepted edge cannot be withdrawn
    // by a later work-list visit; an initially unknown predicate therefore never
    // creates an unsound promise that a later pass silently retracts.
    const finalReachability = existing?.reachable === true && reachable === false ? true : reachable;
    edgeFacts.set(key, Object.freeze({
      edgeId: key,
      from,
      to: edge.to,
      kind: edge.kind ?? 'branch',
      reachable: finalReachability,
      status: budgetExhausted ? 'partial' : 'complete',
      // Predicates may carry a shared-target switch-label array. Snapshot the
      // complete evidence graph so mutating a nested publication field cannot
      // change what consumers observe without changing the digest.
      predicate: predicate == null ? null : immutableSnapshot(predicate),
      facts: factMap,
      // The direct getter preserves the small pre-fix edge-fact API while the
      // structured `facts` map carries metadata and remains the canonical
      // projection for new consumers.
      get: (valueId) => factMap.get(valueId),
      provenance: immutableSnapshot({
        edge: `${from}->${edge.to}`,
        condition: predicate?.conditionId ?? null,
      }),
    }));
  }

  function refinementForCondition(condition, truth) {
    const definition = condition?.def;
    if (definition?.op !== 'bin') return new Map();
    const operands = argumentValues(definition);
    if (operands.length < 2) return new Map();
    return refineComparisonFacts(definition.sub,
          factOfValue(operands[0]) ?? factFromRange(rangeOfValue(operands[0]), {
            valueId: operands[0]?.id ?? null,
          }),
      factOfValue(operands[1]) ?? factFromRange(rangeOfValue(operands[1]), {
        valueId: operands[1]?.id ?? null,
      }),
      truth);
  }

  function edgeIsImpossible(refinement) {
    return [...refinement.values()].some((fact) => fact?.range?.kind === 'empty');
  }

  function processSwitch(block, terminator, edges) {
    const selector = terminator.selectorValue ?? terminator.conditionValue ?? argumentValues(terminator)[0];
    const selectorFact = factOfValue(selector);
    // A selector whose producer has not reached a fixed cell yet is different
    // from an unknown selector.  Defer publication so a later exact selector
    // can discard impossible case/default edges without stale reachability
    // surviving from this first visit.
    if (selector == null || selectorFact == null) {
      // A missing value is malformed evidence, not an unevaluated producer.
      // Keeping all switch successors executable is the only sound response;
      // deferring here would make every successor look unreachable forever.
      if (selector != null && valueById.has(selector.id) && widthOf(selector) != null) return;
      for (const edge of edges) {
        recordEdgeFact(block.index, edge, {
          reachable: true,
          predicate: { kind: 'switch', conditionId: selector?.id ?? null, malformed: true },
        });
        markEdge(block.index, edge.to, edge.kind ?? 'switch');
      }
      return;
    }
    const rawCases = terminator.cases ?? terminator.extra?.cases ?? [];
    const cases = Array.isArray(rawCases) ? rawCases : [];
    const normalizedCases = cases.map((entry, index) => {
      const rawValue = Array.isArray(entry) ? entry[0] : entry?.value ?? entry?.caseValue ?? entry?.constant;
      const to = Array.isArray(entry) ? entry[1] : entry?.to ?? entry?.target;
      try {
        return { value: rawValue == null ? null : BigInt(rawValue), to, index };
      } catch {
        return { value: null, to, index, malformed: true };
      }
    }).filter((entry) => entry.value != null && entry.to != null);
    const complete = terminator.casesComplete === true || terminator.extra?.casesComplete === true;
    const selectorMax = maxUnsigned(selectorFact.bits);
    const labelWidthMismatch = normalizedCases.some((entry) => entry.value < 0n || entry.value > selectorMax);
    const malformed = !Array.isArray(rawCases) || cases.some((entry, index) => {
      const normalized = normalizedCases.find((candidate) => candidate.index === index);
      return normalized == null || normalized.malformed;
    }) || normalizedCases.some((entry, index, all) => all.some((other) => other !== entry
      && other.value === entry.value && other.to !== entry.to)) || labelWidthMismatch;
    const byTarget = new Map();
    for (const entry of normalizedCases) {
      if (!byTarget.has(entry.to)) byTarget.set(entry.to, []);
      byTarget.get(entry.to).push(entry);
    }
    const selectorConstant = selectorFact?.constant?.value ?? null;
    for (const edge of edges) {
      const entries = edge.kind === 'switch-case' ? (byTarget.get(edge.to) ?? []) : [];
      let refinement = new Map();
      let reachable = true;
      if (!malformed && entries.length > 0 && selectorFact != null) {
        // Several case labels may share one target.  The edge fact is their
        // union, never just the last label (which would be falsely precise).
        const caseFacts = entries.map((entry) => refineComparisonFacts('eq', selectorFact,
          factFromRange(singleton({ value: BigInt.asUintN(selectorFact.bits, entry.value), bits: selectorFact.bits }), { valueId: null }), true));
        const candidates = caseFacts.map((factsForCase) => factsForCase.get(selectorFact.valueId) ?? selectorFact);
        const selectorCases = candidates.reduce((merged, fact) => joinFacts(merged, fact), null);
        if (selectorCases != null && selectorFact.valueId != null) refinement.set(selectorFact.valueId, selectorCases);
        reachable = candidates.some((fact) => fact?.range?.kind !== 'empty');
      } else if (edge.kind === 'switch-default' && complete && selectorFact != null) {
        // A default complement generally has multiple disconnected pieces.  A
        // singleton selector is the one case where the complement is exact.
        if (!malformed && selectorConstant != null) {
          const covered = normalizedCases.some((entry) => BigInt.asUintN(selectorFact.bits, entry.value) === selectorConstant);
          reachable = !covered;
          if (!reachable && selectorFact.valueId != null) {
            refinement.set(selectorFact.valueId, emptyFact(selectorFact.bits, {
              valueId: selectorFact.valueId,
              reason: 'switch default is impossible for the proven selector',
            }));
          }
        }
      }
      recordEdgeFact(block.index, edge, {
        reachable,
        factsForEdge: refinement,
        predicate: {
          kind: 'switch',
          conditionId: selector?.id ?? null,
          caseValue: entries.length <= 1 ? entries[0]?.value ?? null : entries.map((entry) => entry.value),
          malformed,
        },
      });
      if (reachable) markEdge(block.index, edge.to, edge.kind);
    }
  }

  function processTerminator(block) {
    const terminator = (block.insts ?? []).at(-1);
    const edges = Array.isArray(block.successorEdges) && block.successorEdges.length > 0
      ? block.successorEdges
      : (block.succ ?? []).map((to) => ({ to, kind: 'branch' }));
    if (edges.length === 0) return;
    if (terminator?.op === 'switch') {
      processSwitch(block, terminator, edges);
      return;
    }
    if (terminator?.op !== 'cbr') {
      for (const edge of edges) recordEdgeFact(block.index, edge, {
        reachable: true,
        predicate: { kind: 'unconditional', conditionId: null },
      });
      for (const edge of edges) markEdge(block.index, edge.to, edge.kind ?? 'unconditional');
      return;
    }
    const condition = terminator.conditionValue;
    const cell = condition == null ? overdefined('branch has no condition value') : cellOf(condition);
    // A condition nobody has evaluated yet is not "unknown", it is "not yet
    // known". Marking both arms executable here would be permanent — edges are
    // only ever added — and the branch could never be folded afterwards no
    // matter what the condition turns out to be.
    if (cell.state === UNDEFINED) {
      // An unsupported-width condition never received an initial lattice cell;
      // it is malformed evidence, not an unevaluated value.  Keep both arms
      // reachable conservatively rather than inventing an unreachable block.
      if (condition == null || !valueById.has(condition.id) || widthOf(condition) == null) {
        for (const edge of edges) {
          recordEdgeFact(block.index, edge, {
            reachable: true,
            predicate: { kind: 'branch', conditionId: condition?.id ?? null, malformed: true },
          });
          markEdge(block.index, edge.to, edge.kind ?? 'branch');
        }
      }
      return;
    }
    const conditionFact = factOfValue(condition);
    const conditionProof = condition != null
      && widthOf(condition) === 1
      && conditionFact?.bits === 1
      && ['exact', 'conservative'].includes(conditionFact.status);
    // Refinement and CFG pruning require a proved one-bit predicate. A
    // malformed comparator (including a destination declared wider than one
    // bit) is not a truth value, even if its operands happen to look useful.
    if (!conditionProof) {
      for (const edge of edges) {
        recordEdgeFact(block.index, edge, {
          reachable: true,
          predicate: {
            kind: 'branch',
            conditionId: condition?.id ?? null,
            truth: null,
            malformed: true,
            proofStatus: conditionFact?.status ?? null,
          },
        });
        markEdge(block.index, edge.to, edge.kind ?? 'branch');
      }
      return;
    }
    const hasConstantCondition = cell.state === CONSTANT && cell.constant.bits === 1;
    // A proved condition makes exactly one arm executable. Otherwise derive
    // branch-local scalar facts from a canonical comparison, never by mutating
    // the global fact map.
    const taken = hasConstantCondition ? cell.constant.value !== 0n : null;
    for (const edge of edges) {
      const isTrueArm = edge.kind === 'conditional-true';
      const isFalseArm = edge.kind === 'conditional-false' || edge.kind === 'fallthrough';
      let reachable = true;
      let factsForEdge = new Map();
      if (hasConstantCondition) {
        reachable = (taken && isTrueArm) || (!taken && isFalseArm) || (!isTrueArm && !isFalseArm);
      } else if (isTrueArm || isFalseArm) {
        factsForEdge = refinementForCondition(condition, isTrueArm);
        reachable = !edgeIsImpossible(factsForEdge);
      }
      recordEdgeFact(block.index, edge, {
        reachable,
        factsForEdge,
        predicate: { kind: 'branch', conditionId: condition?.id ?? null, truth: isTrueArm ? true : isFalseArm ? false : null },
      });
      if (reachable) markEdge(block.index, edge.to, edge.kind);
    }
  }

  // Which block's terminator each value can decide. Re-running every terminator
  // after every value evaluation was the second half of the cost; a value that
  // is not a branch condition cannot change any edge.
  const conditionOwners = new Map();
  for (const block of blocks) {
    const terminator = (block.insts ?? []).at(-1);
    const conditionId = terminator?.op === 'cbr'
      ? terminator.conditionValue?.id
      : terminator?.op === 'switch'
        ? (terminator.selectorValue ?? terminator.conditionValue ?? argumentValues(terminator)[0])?.id
        : null;
    if (conditionId == null) continue;
    if (!conditionOwners.has(conditionId)) conditionOwners.set(conditionId, []);
    conditionOwners.get(conditionId).push(block);
  }

  // Values with no definition — function arguments, undefined values, anything
  // the IR presents without a producer — are overdefined from the start. They
  // are never reached by the worklist, so leaving them at top would mean a
  // branch on an argument never resolves and every block behind it looks
  // unreachable.
  for (const value of values) {
    if (value.def != null || value.kind === 'phi') continue;
    const bits = widthOf(value);
    const known = constantOfValue(value);
    cells.set(value.id, known != null ? constantCell(known) : overdefined(value.kind === 'arg' ? 'function argument' : 'value has no definition'));
    if (bits != null) {
      const range = known != null ? singleton(known) : fullRange(bits);
      ranges.set(value.id, range);
      facts.set(value.id, factFromRange(range, {
        valueId: value.id,
        reason: known == null ? 'function argument' : null,
        provenance: valueProvenance(value),
      }));
    }
  }

  const entry = blocks.find((block) => block.isEntry) ?? blocks[0];
  if (entry != null) {
    executableBlocks.add(entry.index);
    enqueueBlock(entry.index);
  }

  const aborted = () => {
    try { return typeof budget.shouldAbort === 'function' && budget.shouldAbort() === true; }
    catch { return true; }
  };

  while ((hasBlockWork() || hasValueWork()) && !budgetExhausted) {
    if (work >= limits.maxWorkItems || aborted()) { budgetExhausted = true; break; }
    work += 1;

    if (hasBlockWork()) {
      const index = takeBlock();
      const block = blockByIndex.get(index);
      if (!block) continue;
      for (const phi of block.phis ?? []) if (phi?.dst?.id != null) enqueueValue(phi.dst.id);
      for (const instruction of block.insts ?? []) {
        const destination = instruction?.dst;
        if (destination?.id != null) enqueueValue(destination.id);
        // The branch condition is an operand, not a destination. If it is
        // defined in another executable block it has a cell already; queueing it
        // here costs one evaluation and removes the ordering dependency.
        if (instruction?.op === 'cbr' && instruction.conditionValue?.id != null) enqueueValue(instruction.conditionValue.id);
      }
      processTerminator(block);
      continue;
    }

    const valueId = takeValue();
    const value = valueById.get(valueId);
    if (!value) continue;
    const definitionBlock = value.def?.block;
    // A value defined in a block nobody can reach has no meaning yet.
    if (definitionBlock != null && !executableBlocks.has(definitionBlock)) continue;
    const evaluated = evaluate(value);
    const { cell, range } = evaluated;
    // Keep the complete product returned by the canonical range owner.  The
    // compatibility range is only one projection; dropping `fact` here would
    // silently discard known bits, congruence, alignment, and pointer-offset
    // evidence before publication.
    setCell(valueId, cell, range, evaluated.fact);
    // Folding a branch condition can make an edge executable, so exactly the
    // terminators this value decides are reconsidered — not every terminator.
    for (const owner of conditionOwners.get(valueId) ?? []) {
      if (executableBlocks.has(owner.index)) processTerminator(owner);
    }
  }

  // Materialize conservative block-entry joins from the edge-local facts. This
  // is a projection of the same edge map, not another path/value analysis.
  const blockEntryFacts = new Map();
  for (const entry of edgeFacts.values()) {
    if (entry.reachable !== true) continue;
    if (!blockEntryFacts.has(entry.to)) blockEntryFacts.set(entry.to, new Map());
    const merged = blockEntryFacts.get(entry.to);
    for (const [valueId, fact] of entry.facts) {
      const prior = merged.get(valueId);
      merged.set(valueId, prior == null ? fact : joinFacts(prior, fact));
    }
  }
  for (const [block, valueFacts] of blockEntryFacts) blockEntryFacts.set(block, new Map(
    [...valueFacts.entries()].sort(([left], [right]) => Number(left) - Number(right)),
  ));

  const unreachableBlocks = blocks.filter((block) => !executableBlocks.has(block.index)).map((block) => block.index);

  /*
   * A work-limited run has not proved that its worklist is at a fixed point.
   * Even a singleton reached before the cutoff is therefore not safe to expose
   * as an exact scalar fact: an unvisited predecessor may still widen it.  Keep
   * the result structurally useful for diagnostics, but publish full-width
   * partial facts and no constants.  Cancellation is handled by the enclosing
   * transaction and never reaches this publication path.
   */
  const degradePartialFact = (fact) => fact == null || !isSupportedWidth(fact.bits)
    ? fact
    : fullFact(fact.bits, {
      valueId: fact.valueId,
      status: 'partial',
      reason: 'fixed point not reached before budget exhaustion',
      provenance: fact.provenance,
    });
  const publishedFacts = budgetExhausted
    ? new Map(values
      .map((value) => {
        const known = facts.get(value.id);
        const bits = widthOf(value);
        const fallback = known ?? (bits == null ? null : fullFact(bits, {
          valueId: value.id,
          status: 'partial',
          reason: 'fixed point not reached before budget exhaustion',
        }));
        return [value.id, degradePartialFact(fallback)];
      })
      .filter(([, fact]) => fact != null))
    : facts;
  const publishedRanges = budgetExhausted
    ? new Map([...publishedFacts.entries()].map(([valueId, fact]) => [valueId, fact.range]))
    : ranges;
  const publishedEdgeFacts = budgetExhausted
    ? new Map([...edgeFacts.entries()].map(([key, edge]) => {
      const partialFacts = new Map([...edge.facts.entries()].map(([valueId, fact]) => [valueId, degradePartialFact(fact)]));
      return [key, Object.freeze({
        ...edge,
        status: 'partial',
        facts: partialFacts,
        get: (valueId) => partialFacts.get(valueId),
      })];
    }))
    : edgeFacts;
  const publishedBlockEntryFacts = budgetExhausted
    ? new Map([...blockEntryFacts.entries()].map(([block, valueFacts]) => [block, new Map(
      [...valueFacts.entries()].map(([valueId, fact]) => [valueId, degradePartialFact(fact)]),
    )]))
    : blockEntryFacts;
  const numericMap = (source) => new Map([...source].sort(([left], [right]) => Number(left) - Number(right)));
  const lexicalMap = (source) => new Map([...source].sort(([left], [right]) => String(left).localeCompare(String(right))));
  const outputFactsMutable = numericMap(publishedFacts);
  const outputRangesMutable = numericMap(publishedRanges);
  const outputEdgesMutable = lexicalMap(publishedEdgeFacts);
  const outputBlockEntryFactsMutable = numericMap(publishedBlockEntryFacts);
  const provenConstants = budgetExhausted
    ? []
    : [...outputFactsMutable.entries()]
      .filter(([, fact]) => fact?.constant != null && ['exact', 'conservative'].includes(fact.status));
  const newlyProven = provenConstants.filter(([valueId]) => {
    const value = valueById.get(valueId);
    return value != null && constantOfValue(value) == null;
  });
  const inputIdentity = resolvedIdentity.identity;
  const inputVersions = typeof analysis?.snapshot === 'function' ? analysis.snapshot() : null;

  const boundedDiagnostics = diagnostics.slice(0, 24);
  if (budgetExhausted) {
    const budgetReason = normalizedLimits.invalid.length > 0
      ? `Invalid resource limits: ${normalizedLimits.invalid.join('; ')}`
      : `The worklist exceeded ${limits.maxWorkItems} items or the pass was cancelled`;
    boundedDiagnostics.push({
      severity: 'warning',
      code: 'phase8.sccp.budget',
      message: 'SCCP stopped before reaching a fixed point.',
      reason: `${budgetReason}; the published ranges are sound but not maximally precise.`,
    });
  }
  if (widened > 0) {
    boundedDiagnostics.push({
      severity: 'info',
      code: 'phase8.sccp.widened',
      message: `${widened} value ranges were widened to reach a fixed point.`,
      reason: `A value revisited more than ${limits.maxVisitsPerValue} times is widened rather than chased, so convergence is bounded.`,
    });
  }

  const digestFact = (fact) => fact == null ? null : ({
    valueId: fact.valueId ?? null,
    bits: fact.bits,
    range: fact.range,
    knownZero: fact.knownZero,
    knownOne: fact.knownOne,
    congruence: fact.congruence,
    alignment: fact.alignment,
    pointerOffset: fact.pointerOffset,
    constant: fact.constant,
    status: fact.status,
    reason: fact.reason,
    provenance: fact.provenance,
  });
  const digestFactMap = (source) => [...source.entries()]
    .map(([valueId, fact]) => [valueId, digestFact(fact)]);
  const digestRangeMap = (source) => [...source.entries()]
    .map(([valueId, range]) => [valueId, range]);
  const digestEdgeMap = (source) => [...source.entries()].map(([key, edge]) => [key, {
    edgeId: edge.edgeId,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    reachable: edge.reachable,
    status: edge.status,
    predicate: edge.predicate,
    facts: digestFactMap(edge.facts),
    provenance: edge.provenance,
  }]);
  const digestBlockFacts = (source) => [...source.entries()]
    .map(([block, valueFacts]) => [block, digestFactMap(valueFacts)]);
  const digestMap = (source) => [...source.entries()];
  const budgetEvidence = Object.freeze({
    maxVisitsPerValue: limits.maxVisitsPerValue,
    maxWorkItems: limits.maxWorkItems,
    workItems: work,
    widenedValueCount: widened,
    exhausted: budgetExhausted,
  });

  const outputFacts = readonlyMap(outputFactsMutable);
  const outputRanges = readonlyMap(outputRangesMutable);
  const outputEdges = readonlyMap([...outputEdgesMutable.entries()].map(([key, edge]) => {
    const factsView = readonlyMap(edge.facts);
    return [key, Object.freeze({
      ...edge,
      facts: factsView,
      get: (valueId) => factsView.get(valueId),
    })];
  }));
  const outputBlockEntryFacts = readonlyMap([...outputBlockEntryFactsMutable.entries()]
    .map(([block, valueFacts]) => [block, readonlyMap(valueFacts)]));
  const outputConstants = readonlyMap(budgetExhausted ? [] : provenConstants.map(([valueId, cell]) => [valueId, cell.constant]));
  const outputOverdefinedReasons = readonlyMap([...cells.entries()]
    .filter(([, cell]) => cell.state === OVERDEFINED && cell.reason)
    .map(([valueId, cell]) => [valueId, cell.reason]));
  const outputVisitCounts = readonlyMap(visits);
  const outputDiagnostics = Object.freeze(boundedDiagnostics
    .map((diagnostic) => immutableSnapshot(diagnostic) ?? Object.freeze({
      severity: 'warning', code: 'phase8.sccp.invalid-diagnostic', message: 'Invalid SCCP diagnostic omitted.',
    })));
  const outputFunctionOrigin = immutableSnapshot(context.ir?.origin ?? null);
  const outputInputVersions = immutableSnapshot(inputVersions);

  const result = {
    contractVersion: SCCP_PASS.contractVersion,
    passVersion: SCCP_PASS.version,
    identity: inputIdentity,
    provenance: Object.freeze({
      producer: SCCP_PASS.id,
      producerVersion: SCCP_PASS.version,
      canonicalOwner: 'phase8/range.js + phase8/sccp.js',
      inputVersions: outputInputVersions,
      functionOrigin: outputFunctionOrigin,
    }),
    // Constants the IR did not already carry. Reporting the total would flatter
    // the pass with facts it did not produce.
    constants: outputConstants,
    newlyProvenConstantCount: newlyProven.length,
    // The product fact map is the sole scalar semantic truth. Compatibility
    // ranges/constants below are projections retained for existing consumers.
    facts: outputFacts,
    ranges: outputRanges,
    edgeFacts: outputEdges,
    blockEntryFacts: outputBlockEntryFacts,
    executableEdges: Object.freeze([...executableEdges].sort()),
    unreachableBlockIndexes: Object.freeze(unreachableBlocks.sort((left, right) => left - right)),
    overdefinedReasons: outputOverdefinedReasons,
    widenedValueCount: widened,
    workItems: work,
    // Per-value revisit counts. A value that dominates this map is the value
    // whose lattice or range is not converging, which is the first thing to look
    // at when the pass reports `partial`.
    visitCounts: outputVisitCounts,
    // Truthfully partial when the worklist was cut off: a fixed point that was
    // not reached is not a fixed point.
    completeness: budgetExhausted ? 'partial' : 'complete',
    budget: budgetEvidence,
    diagnostics: outputDiagnostics,
  };

  // The scalar artifact has its own digest in addition to the enclosing Phase 8
  // ledger digest.  Maps, closures, and compatibility getters are intentionally
  // projected into sorted data so replay identity covers semantic facts and
  // diagnostics without depending on object insertion order or runtime timing.
  result.publicationDigest = stableDigest({
    contractVersion: result.contractVersion,
    passVersion: result.passVersion,
    identity: result.identity,
    provenance: result.provenance,
    constants: [...result.constants.entries()],
    facts: digestFactMap(outputFacts),
    // `ranges` is the compatibility projection of `facts`; digest the narrow
    // projection instead of serializing every product fact a second time.  The
    // canonical fact map above still covers all scalar semantics, while this
    // retains replay sensitivity to a compatibility-map change.
    ranges: digestRangeMap(outputRanges),
    edgeFacts: digestEdgeMap(outputEdges),
    blockEntryFacts: digestBlockFacts(outputBlockEntryFacts),
    executableEdges: result.executableEdges,
    unreachableBlockIndexes: result.unreachableBlockIndexes,
    overdefinedReasons: digestMap(result.overdefinedReasons),
    widenedValueCount: result.widenedValueCount,
    workItems: result.workItems,
    visitCounts: digestMap(result.visitCounts),
    completeness: result.completeness,
    budget: result.budget,
    diagnostics: result.diagnostics,
  });

  Object.freeze(result);
  if (area != null) area.stage('ranges', result);

  return createPassResult({
    descriptor: SCCP_PASS,
    // A produced analysis is a change: downstream reuse has to see a new version.
    status: 'changed',
    changed: true,
    completeness: result.completeness,
    // SCCP rewrites nothing. It produces an analysis, which is a different kind
    // of change and is recorded as one; the values it made a claim about are in
    // the published facts themselves, keyed by SSA value id.
    transforms: [],
    produced: ['ranges'],
    diagnostics: outputDiagnostics,
    invalidated: [],
  });
}

/** A short human summary, used by diagnostics and evidence. */
export function describeSccp(result) {
  return [
    `constants=${result.constants.size}`,
    `newlyProven=${result.newlyProvenConstantCount}`,
    `ranges=${result.ranges.size}`,
    `executableEdges=${result.executableEdges.length}`,
    `unreachableBlocks=${result.unreachableBlockIndexes.length}`,
    `widened=${result.widenedValueCount}`,
    `completeness=${result.completeness}`,
  ].join(' ');
}

export { describeRange };
