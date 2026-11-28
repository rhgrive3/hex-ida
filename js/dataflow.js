/*
 * dataflow.js — stable compatibility API over Semantic IR facts.
 *
 * Semantic IR / SSA / Memory SSA is the primary and only semantic producer when
 * an IR can be built. dataflow-legacy.js remains exported for old callers and is
 * used only when IR construction itself is unavailable.
 */

export * from './dataflow-legacy.js';

import {
  findValueUpdates as legacyFindValueUpdates,
  constantComparisons as legacyConstantComparisons,
  amountOf as legacyAmountOf,
  selfRegisters,
} from './dataflow-legacy.js';
import { findIrValueUpdates } from './dataflow-ir.js';
import { findIrSemanticUpdates } from './dataflow-semantic.js';
import { findIrConstantComparisons } from './dataflow-ir-compare.js';
import { irFor, readModifyWrite, MK, pointerProvenance } from './ir.js';
import { withLightweightIdentity } from './core/identity/index.js';

export {
  legacyFindValueUpdates as findValueUpdatesLegacy,
  legacyConstantComparisons as constantComparisonsLegacy,
  legacyAmountOf as amountOfLegacy,
};

const updateCache = new WeakMap();
const unfilteredUpdateCache = new WeakMap();
const constantComparisonCache = new WeakMap();

export function stripHeavyIrRefs(update) {
  if (!update || typeof update !== 'object') return update;
  if (!('ir' in update) || update.ir == null) return update;
  const { ir: _ir, ...lite } = update;
  return lite;
}

function filterUpdatesByGlobals(updates, includeGlobals) {
  if (!Array.isArray(updates)) return [];
  if (includeGlobals) return updates.slice();
  return updates.filter((u) => !(u && u.location && u.location.irKind === MK.GLOBAL));
}

const ALLOWED_UPDATE_CACHE_OPTS = new Set(['includeGlobals']);
const ALLOWED_COMPARISON_CACHE_OPTS = new Set(['allowUnscopedPropagated']);

function hasOnlyAllowedOpts(opts, allowedKeys) {
  if (opts == null) return true;
  if (typeof opts !== 'object') return false;
  for (const key of Object.keys(opts)) {
    if (opts[key] === undefined) continue;
    if (!allowedKeys.has(key)) return false;
  }
  return true;
}

function isDefaultUpdateQuery(opts) {
  return opts == null || Object.keys(opts).length === 0;
}
function rememberUpdates(model, updates, opts) {
  if (isDefaultUpdateQuery(opts) && model && typeof model === 'object') updateCache.set(model, updates || []);
  return updates;
}

function selfFromIr(update) {
  if (!update || !update.ir) return false;
  const loc = update.ir.location || update.ir.store && update.ir.store.loc || update.ir.load && update.ir.load.loc;
  if (!loc || loc.kind !== MK.FIELD || !loc.base) return !!(update.location && update.location.self);
  const p = pointerProvenance(loc.base);
  return !!(p && p.root === 'arg:x0' && p.must !== false);
}

/** Which engine produced the semantic answer. Useful for diagnostics/tests. */
export function dataflowEngine(model, opts) {
  if (opts?.ir == null && !opts?.requireSemanticIr && typeof model?._precomputedEngine === 'string') {
    return model._precomputedEngine;
  }
  try {
    return withLightweightIdentity(() => irFor(model, opts && opts.ir)) ? 'semantic-ir' : 'legacy-fallback';
  } catch {
    return 'legacy-fallback';
  }
}

export function findValueUpdates(model, opts) {
  const includeGlobals = opts?.includeGlobals === true;
  const canUseCache = !!(
    model &&
    typeof model === 'object' &&
    !opts?.requireSemanticIr &&
    hasOnlyAllowedOpts(opts, ALLOWED_UPDATE_CACHE_OPTS)
  );
  if (canUseCache) {
    if (Array.isArray(model._precomputedUpdates)) {
      const filtered = filterUpdatesByGlobals(model._precomputedUpdates, includeGlobals);
      return rememberUpdates(model, filtered, opts);
    }
    const cachedAll = unfilteredUpdateCache.get(model);
    if (cachedAll) {
      const filtered = filterUpdatesByGlobals(cachedAll, includeGlobals);
      return rememberUpdates(model, filtered, opts);
    }
  }

  let ir = null;
  try {
    ir = withLightweightIdentity(() => irFor(model, opts && opts.ir));
  } catch { ir = null; }
  if (!ir) return rememberUpdates(model, legacyFindValueUpdates(model, opts), opts);

  let rmw = [];
  let direct = [];
  const computeUnfiltered = canUseCache;
  const queryOpts = computeUnfiltered ? { ...(opts || {}), includeGlobals: true } : opts;
  try {
    // The RMW proof is a graph walk consumed by both adapters. Keep the reuse
    // inside this one query so mutable/custom IR callers can never observe a
    // stale cross-query memoized proof.
    const precomputed = {
      ir,
      readModifyWriteProofs: readModifyWrite(ir),
    };
    const rawRmw = findIrValueUpdates(model, queryOpts, precomputed);
    rmw = computeUnfiltered
      ? rawRmw
      : filterUpdatesByGlobals(rawRmw, includeGlobals);
    const rawDirect = findIrSemanticUpdates(model, queryOpts, rmw, precomputed);
    direct = computeUnfiltered
      ? rawDirect
      : filterUpdatesByGlobals(rawDirect, includeGlobals);
  } catch {
    // IR existed but a consumer adapter failed. Do not silently replace a proven
    // semantic model with a different heuristic truth; expose the safe subset
    // without caching the partial failure result.
    return filterUpdatesByGlobals(rmw, includeGlobals);
  }

  const out = [...rmw, ...direct];
  for (const u of out) {
    if (u.location) u.location.self = u.location.self || selfFromIr(u);
  }
  out.sort((a, b) => b.confidence - a.confidence ||
    ((a.store && a.store.row) || 0) - ((b.store && b.store.row) || 0));
  if (computeUnfiltered) {
    const strippedOut = out.map(stripHeavyIrRefs);
    unfilteredUpdateCache.set(model, strippedOut);
    return rememberUpdates(model, filterUpdatesByGlobals(strippedOut, includeGlobals), opts);
  }
  return rememberUpdates(model, out, opts);
}

// Candidate distinctness is canonical memory/object identity, not the legacy
// display key. `x19@32` is only the physical-register spelling plus a
// displacement, so two different SSA objects reached through a reused physical
// register would count as one location and let an unscoped propagated
// comparison through the ambiguity gate (#5365). SSA-backed updates expose the
// canonical Memory-SSA key as `irKey`; the display key is only a fallback.
export function candidateLocationIdentity(loc) {
  if (loc.irKey != null) return 'ir:' + String(loc.irKey);
  if (loc.key != null) return String(loc.key);
  return null;
}

export function distinctCandidateLocations(updates) {
  const keys = new Set();
  for (const u of updates || []) {
    const loc = u && u.location;
    if (!loc || loc.stack) continue;
    const identity = candidateLocationIdentity(loc);
    if (identity == null) continue;
    keys.add(identity);
    if (keys.size > 1) break;
  }
  return keys.size;
}

function comparisonContextUpdates(model, opts) {
  if (!model || typeof model !== 'object') return [];
  if (opts && opts.ir) {
    try { return findValueUpdates(model, { ir: opts.ir }); } catch { return []; }
  }
  const cached = updateCache.get(model);
  if (cached) return cached;
  try { return findValueUpdates(model); } catch { return []; }
}

export function constantComparisons(model, opts) {
  const canUseCache = !!(
    model &&
    typeof model === 'object' &&
    hasOnlyAllowedOpts(opts, ALLOWED_COMPARISON_CACHE_OPTS)
  );
  if (canUseCache) {
    if (Array.isArray(model._precomputedConstants)) {
      let proven = model._precomputedConstants.slice();
      if (opts?.allowUnscopedPropagated !== true) {
        const context = comparisonContextUpdates(model, opts);
        if (distinctCandidateLocations(context) > 1) proven = proven.filter((c) => !c.propagated);
      }
      return proven;
    }
    const cached = constantComparisonCache.get(model);
    if (cached) {
      let proven = cached.slice();
      if (opts?.allowUnscopedPropagated !== true) {
        const context = comparisonContextUpdates(model, opts);
        if (distinctCandidateLocations(context) > 1) proven = proven.filter((c) => !c.propagated);
      }
      return proven;
    }
  }

  let ir = null;
  try {
    ir = withLightweightIdentity(() => irFor(model, opts && opts.ir));
  } catch { ir = null; }
  if (!ir) return legacyConstantComparisons(model);

  let proven = [];
  try { proven = findIrConstantComparisons(model, opts); } catch { return []; }
  if (canUseCache) {
    constantComparisonCache.set(model, proven.slice());
  }
  if (opts?.allowUnscopedPropagated !== true) {
    const context = comparisonContextUpdates(model, opts);
    if (distinctCandidateLocations(context) > 1) proven = proven.filter((c) => !c.propagated);
  }
  return proven;
}

const AMOUNT_OPS = new Set(['add', 'adds', 'sub', 'subs', 'mul', 'madd', 'msub',
  'smull', 'umull', 'sdiv', 'udiv', 'fadd', 'fsub', 'fmul', 'fdiv', 'lsl', 'lsr', 'asr']);
const CLAMP_OPS = new Set([
  'bic', 'csel', 'csinc', 'csneg', 'csinv', 'smax', 'smin', 'umax', 'umin',
  'fmax', 'fmin', 'fmaxnm', 'fminnm',
]);
const SCALE_OPS = new Set(['mul', 'madd', 'msub', 'smull', 'umull', 'sdiv', 'udiv',
  'fmul', 'fdiv', 'lsl', 'lsr', 'asr']);
const DIRECT_ORIGIN = new Set(['field', 'stack', 'global', 'imm', 'call', 'arg']);

export function amountOf(model, update) {
  if (!update || (update.engine !== 'ir-ssa' && update.engine !== 'ir-semantic')) {
    return legacyAmountOf(model, update);
  }

  let amount = null;
  let cappedBy = null;
  let clamped = false;
  let scaled = false;
  const ops = [];
  for (const step of update.steps || []) {
    if (!step || !step.op) continue;
    if (step.signMaskClampPart) continue;
    ops.push(step.op);
    const origin = step.otherOrigin;
    if (step.signMaskClamp === true || (step.op !== 'bic' && CLAMP_OPS.has(step.op))) {
      clamped = true;
      if (!cappedBy && origin && origin.kind === 'field') cappedBy = origin;
    }
    if (SCALE_OPS.has(step.op)) scaled = true;
    if (amount || !AMOUNT_OPS.has(step.op)) continue;
    const operandSide = step.sourceOperandIndex == null ? {} : {
      sourceOperandIndex: step.sourceOperandIndex,
      sourceOnLeft: step.sourceOnLeft === true,
    };
    if (origin && DIRECT_ORIGIN.has(origin.kind)) amount = { op: step.op, ...origin, ...operandSide };
    else if (step.imm != null) amount = { kind: 'imm', value: step.imm, op: step.op, row: step.row, engine: 'ir-ssa', ...operandSide };
  }
  return { amount, clamped, scaled, cappedBy, ops };
}

/* Low-level compatibility utility. It is not a semantic producer. */
export { selfRegisters };
