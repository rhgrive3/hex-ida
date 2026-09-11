/**
 * P7-3c — A3 interprocedural summary solving.
 *
 * Local summaries (P7-3a) leave every call an opaque boundary. This pass closes
 * the ones it can, by condensing the call graph into strongly connected
 * components and solving the resulting DAG bottom-up. Recursive components are
 * solved to a fixed point with a finite effect lattice, so mutual recursion
 * terminates deterministically rather than by luck of traversal order.
 *
 * Three rules shape the implementation, and each of them exists because the
 * convenient alternative is unsound:
 *
 *  - A callee whose summary is missing, stale, incomplete or cancelled
 *    contributes conservative unknown-call effects. It never contributes
 *    nothing (P7-INV-004).
 *  - An indirect call whose candidate set is not proven exhaustive contributes
 *    the union of its candidates *plus* unknown-call effects. Candidates are
 *    never averaged into an answer (§9.4).
 *  - A component that does not converge inside its budget publishes as
 *    incomplete, or not at all. It never publishes as complete (P7-INV-010).
 *
 * The pass is demand-driven: it solves the components reachable from the
 * requested roots, not the whole program (P7-INV-009).
 */

import { createAnalysisStatus, mergeAnalysisStatus, weakestCompleteness } from '../status.js';
import { mergeOriginSets } from '../../core/identity/origin.js';
import {
  EFFECT_SOURCES,
  createFunctionSummary,
  createMemoryEffect,
  createUnknownCallEffect,
  functionSummaryDigest,
} from './contract.js';

export const INTERPROCEDURAL_ANALYZER_ID = 'phase7.summary.interprocedural';
export const INTERPROCEDURAL_ANALYZER_VERSION = '1.3.0';

export const INTERPROCEDURAL_DEFAULT_BUDGET = Object.freeze({
  maxIterationsPerComponent: 16,
  maxComponents: 4096,
  maxEffectsPerSummary: 512,
});

function fail(code) { throw new TypeError(code); }

/**
 * Condenses the call graph into strongly connected components.
 *
 * Tarjan's algorithm, iterative so a deep call graph cannot overflow the
 * JavaScript stack. Components come back in reverse topological order, which is
 * exactly the bottom-up order the solve wants.
 */
export function condenseCallGraph(roots, successorsOf, {
  maxComponents = INTERPROCEDURAL_DEFAULT_BUDGET.maxComponents,
  maxNodes = Math.max(10000, maxComponents),
  maxEdges = Math.max(50000, maxNodes * 4),
  signal = null,
} = {}) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;
  let truncated = false;
  let traversedEdges = 0;

  for (const root of roots) {
    if (signal?.aborted) return { components, truncated: true, cancelled: true };
    if (index.has(root)) continue;
    if (index.size >= maxNodes) {
      truncated = true;
      return { components, truncated };
    }
    const work = [{ node: root, successors: null, state: 0 }];
    while (work.length) {
      if (signal?.aborted) return { components, truncated: true, cancelled: true };
      const frame = work[work.length - 1];
      if (frame.successors == null) {
        index.set(frame.node, counter);
        low.set(frame.node, counter);
        counter += 1;
        stack.push(frame.node);
        onStack.add(frame.node);
        frame.successors = [...successorsOf(frame.node)].sort();
      }
      if (frame.state < frame.successors.length) {
        if (++traversedEdges > maxEdges) {
          truncated = true;
          return { components, truncated };
        }
        const next = frame.successors[frame.state];
        frame.state += 1;
        if (!index.has(next)) {
          if (index.size >= maxNodes) {
            truncated = true;
            return { components, truncated };
          }
          work.push({ node: next, successors: null, state: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(next)));
        }
        continue;
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = [];
        for (;;) {
          const member = stack.pop();
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        if (components.length >= maxComponents) { truncated = true; return { components, truncated }; }
        components.push(component.sort());
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1];
        low.set(parent.node, Math.min(low.get(parent.node), low.get(frame.node)));
      }
    }
  }
  return { components, truncated };
}

function broadEffect(source, addressSpaces = ['memory']) {
  return createMemoryEffect({ regionKind: 'unknown', broad: true, addressSpaces, source });
}

/**
 * Versioned external-model wire contract. A model is authority only when its
 * identity is bound to the requested target and snapshot, its producer says
 * it is current and complete, and every effect/control fact is validated.
 * Empty arrays are valid explicit evidence of absence; omitted or malformed
 * arrays are not evidence at all and must keep the unknown-call fallback.
 */
export const LIBRARY_MODEL_SCHEMA = 'phase7-library-model';
export const LIBRARY_MODEL_VERSION = '1';
export const LIBRARY_MODEL_PROVENANCE_SCHEMA = 'phase7-library-model-provenance';

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function nonEmptyModelString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalModelEvidenceIds(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const entries = Array.from(values);
  if (!entries.every(nonEmptyModelString)) return null;
  return [...new Set(entries.map((value) => value.trim()))].sort();
}

function validateLibraryModelEffect(effect) {
  if (!isPlainRecord(effect)
    || effect.source !== 'library-model'
    || typeof effect.broad !== 'boolean'
    || (effect.broad !== true && !nonEmptyModelString(effect.regionId))) {
    return null;
  }
  if (!Array.isArray(effect.addressSpaces) || !Array.isArray(effect.evidenceIds)) return null;
  const addressSpaces = Array.from(effect.addressSpaces);
  const evidenceIds = Array.from(effect.evidenceIds);
  if (addressSpaces.length === 0 || !addressSpaces.every(nonEmptyModelString)
    || evidenceIds.length === 0 || !evidenceIds.every(nonEmptyModelString)) return null;
  try {
    const normalized = createMemoryEffect({ ...effect, addressSpaces, evidenceIds });
    if (normalized.source !== 'library-model'
      || normalized.addressSpaces.length === 0
      || normalized.evidenceIds.length === 0) return null;
    return normalized;
  } catch {
    return null;
  }
}

function validateLibraryModelEscape(escape, provenanceEvidenceIds) {
  if (!isPlainRecord(escape)
    || !nonEmptyModelString(escape.kind)
    || (escape.target != null && !nonEmptyModelString(escape.target))) return null;
  const evidenceIds = canonicalModelEvidenceIds(escape.evidenceIds);
  if (!evidenceIds) return null;
  return Object.freeze({
    kind: escape.kind.trim(),
    target: escape.target == null ? null : escape.target.trim(),
    evidenceIds: [...new Set([...evidenceIds, ...provenanceEvidenceIds])].sort(),
  });
}

/**
 * Validates and normalizes the canonical library-model contract for one call
 * target. Returning null is deliberate: malformed, stale, incomplete, or
 * mis-bound models follow the same fail-closed path as a missing model.
 */
export function validateLibraryModel(model, { targetEntityId, snapshotId } = {}) {
  try {
    const target = typeof targetEntityId === 'string' ? targetEntityId.trim() : '';
    const snapshot = typeof snapshotId === 'string' ? snapshotId.trim() : '';
    if (!isPlainRecord(model)
      || model.modelSchema !== LIBRARY_MODEL_SCHEMA
      || model.modelVersion !== LIBRARY_MODEL_VERSION
      || !target
      || model.targetEntityId !== target
      || !snapshot
      || model.snapshotId !== snapshot
      || model.completeness !== 'complete'
      || model.stopReason !== null
      || model.current !== true
      || !isPlainRecord(model.provenance)
      || model.provenance.schema !== LIBRARY_MODEL_PROVENANCE_SCHEMA
      || !nonEmptyModelString(model.provenance.providerId)
      || !nonEmptyModelString(model.provenance.providerVersion)) {
      return null;
    }

    const provenanceEvidenceIds = canonicalModelEvidenceIds(model.provenance.evidenceIds);
    if (!provenanceEvidenceIds
      || !Array.isArray(model.memoryReadRegions)
      || !Array.isArray(model.memoryWriteRegions)
      || !Array.isArray(model.escapes)
      || ![true, false, 'unknown'].includes(model.noreturn)
      || ![true, false, 'unknown'].includes(model.mayThrow)) {
      return null;
    }

    const normalizeEffects = (values) => Array.from(values, validateLibraryModelEffect).map((effect) => {
      if (!effect) return null;
      return createMemoryEffect({
        ...effect,
        evidenceIds: [...new Set([...effect.evidenceIds, ...provenanceEvidenceIds])],
      });
    });
    const memoryReadRegions = normalizeEffects(model.memoryReadRegions);
    const memoryWriteRegions = normalizeEffects(model.memoryWriteRegions);
    const escapes = Array.from(model.escapes, (escape) =>
      validateLibraryModelEscape(escape, provenanceEvidenceIds));
    if (memoryReadRegions.some((effect) => effect == null)
      || memoryWriteRegions.some((effect) => effect == null)
      || escapes.some((escape) => escape == null)) return null;

    return Object.freeze({
      memoryReadRegions: Object.freeze(memoryReadRegions),
      memoryWriteRegions: Object.freeze(memoryWriteRegions),
      escapes: Object.freeze(escapes),
      noreturn: model.noreturn,
      mayThrow: model.mayThrow,
    });
  } catch {
    // Treat hostile getters, proxies, and future-shaped values as missing
    // evidence rather than allowing untrusted model input to escape the gate.
    return null;
  }
}

/** Authority rank: lower wins, because proven evidence outranks a model. */
const SOURCE_AUTHORITY_RANK = new Map(EFFECT_SOURCES.map((source, index) => [source, index]));

function strongestSource(left, right) {
  const leftRank = SOURCE_AUTHORITY_RANK.get(left) ?? SOURCE_AUTHORITY_RANK.size;
  const rightRank = SOURCE_AUTHORITY_RANK.get(right) ?? SOURCE_AUTHORITY_RANK.size;
  return leftRank <= rightRank ? left : right;
}

function compareCodeUnitStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mergeEscapes(values) {
  const byKey = new Map();
  for (const escape of values) {
    const evidenceIds = [...new Set(escape.evidenceIds)].sort();
    const key = JSON.stringify([escape.kind, escape.target ?? null]);
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, Object.freeze({ ...escape, evidenceIds }));
      continue;
    }
    byKey.set(key, Object.freeze({
      ...prior,
      evidenceIds: [...new Set([...prior.evidenceIds, ...evidenceIds])].sort(),
    }));
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => compareCodeUnitStrings(left, right))
    .map(([, escape]) => escape);
}


function mergedRegionProof(left, right) {
  if (!left || !right || left.id !== right.id || left.kind !== right.kind) return null;
  try { return { ...left, origin: mergeOriginSets(left.origin, right.origin) }; }
  catch { return null; }
}

function mergeEffects(lists, cap) {
  const effectiveCap = Number.isSafeInteger(cap) && cap >= 1 ? cap : 1;
  const byKey = new Map();
  let broad = null;
  for (const effect of lists.flat()) {
    if (effect.broad) {
      // One broad effect subsumes every specific one in its address spaces, so
      // the merge keeps a single broad entry rather than an unbounded list.
      const spaces = [...new Set([...(broad?.addressSpaces ?? []), ...effect.addressSpaces])].sort();
      broad = createMemoryEffect({ ...effect, addressSpaces: spaces });
      continue;
    }
    const key = `${effect.regionId}\u0000${effect.regionKind}`;
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, effect);
      continue;
    }
    // Same region and kind means one logical region effect: union its
    // coverage and provenance instead of dropping every later observation.
    // Address spaces add up (a region may be reached through more than one),
    // evidence accumulates, and authority keeps the stronger of the two
    // sources independently of input order.
    byKey.set(key, createMemoryEffect({
      regionId: effect.regionId,
      regionKind: effect.regionKind,
      region: mergedRegionProof(prior.region ?? null, effect.region ?? null),
      broad: false,
      addressSpaces: [...new Set([...prior.addressSpaces, ...effect.addressSpaces])].sort(),
      source: strongestSource(prior.source, effect.source),
      evidenceIds: [...new Set([...prior.evidenceIds, ...effect.evidenceIds])].sort(),
    }));
  }
  const specific = [...byKey.values()];
  if (broad) {
    const combined = [broad, ...specific];
    if (combined.length <= effectiveCap) return combined;
    const dropped = combined.slice(effectiveCap);
    const allDroppedSpaces = dropped.flatMap((eff) => eff.addressSpaces || []);
    const mergedSpaces = [...new Set([...(broad.addressSpaces || []), ...allDroppedSpaces])].sort();
    const finalBroad = createMemoryEffect({ ...broad, addressSpaces: mergedSpaces });
    return [finalBroad, ...combined.slice(1, effectiveCap)];
  }
  if (specific.length > effectiveCap) {
    // Rather than truncate a list a consumer would read as exhaustive, collapse
    // to one broad effect across all present address spaces: less precise, still sound.
    const spaces = [...new Set(specific.flatMap((eff) => eff.addressSpaces || ['memory']))].sort();
    return [broadEffect('unknown-call-fallback', spaces.length ? spaces : ['memory'])];
  }
  return specific;
}

function unionKnowledge(values) {
  if (values.some((value) => value === 'unknown')) return 'unknown';
  return values.some((value) => value === true);
}

/**
 * Solves interprocedural summaries for the components reachable from `roots`.
 *
 * `localSummaries` maps functionId to its P7-3a local summary. `libraryModels`
 * maps a callee id to a versioned external model; a model is consulted only
 * when no proven summary exists, and it never overrides contradictory binary
 * evidence — it is applied to callees the binary does not define.
 */
export function solveInterproceduralSummaries({
  roots,
  localSummaries,
  libraryModels = new Map(),
  budget = {},
  snapshotId = 'snapshot-unbound',
  budgetClass = null,
  signal = null,
} = {}) {
  const limits = { ...INTERPROCEDURAL_DEFAULT_BUDGET, ...budget };
  const locals = localSummaries instanceof Map ? localSummaries : new Map(Object.entries(localSummaries ?? {}));
  const models = libraryModels instanceof Map ? libraryModels : new Map(Object.entries(libraryModels ?? {}));
  if (!Array.isArray(roots) || roots.length === 0) fail('interprocedural-roots-required');

  const status = (completeness, stopReason) => createAnalysisStatus({
    snapshotId,
    analyzerId: INTERPROCEDURAL_ANALYZER_ID,
    analyzerVersion: INTERPROCEDURAL_ANALYZER_VERSION,
    completeness,
    budgetClass,
    stopReason,
  });

  if (signal?.aborted) {
    return { summaries: new Map(), components: [], status: status('partial', 'cancelled'), iterations: 0 };
  }

  // A summary is usable for a function only when the map key and the
  // producer-declared identity agree. A mis-keyed reachable callee is treated
  // as missing evidence so its caller takes the conservative unknown-call
  // path; only a requested root is rejected outright (#6208).
  const isValidLocal = (functionId) => {
    const local = locals.get(functionId);
    return !!local && local.functionId === functionId;
  };
  const calleesOf = (functionId) => {
    const local = locals.get(functionId);
    if (!isValidLocal(functionId)) return [];
    const direct = local.directCalls.flatMap((call) => call.targetEntityIds);
    const indirect = local.indirectCallSets.flatMap((set) => set.candidateEntityIds);
    return [...new Set([...direct, ...indirect])].filter(isValidLocal);
  };
  for (const root of roots) {
    if (!isValidLocal(root)) fail('interprocedural-local-summary-identity-mismatch');
  };

  const { components, truncated, cancelled } = condenseCallGraph(roots, calleesOf, {
    maxComponents: limits.maxComponents,
    maxNodes: limits.maxNodes,
    maxEdges: limits.maxEdges,
    signal,
  });
  if (cancelled || signal?.aborted) {
    return { summaries: new Map(), components, status: status('partial', 'cancelled'), iterations: 0 };
  }
  if (truncated) {
    return { summaries: new Map(), components, status: status('truncated', 'budget-exhausted'), iterations: 0 };
  }

  const solved = new Map();
  let totalIterations = 0;
  let worstStopReason = null;
  let worstCompleteness = 'complete';

  for (const component of components) {
    if (signal?.aborted) {
      return { summaries: solved, components, status: status('partial', 'cancelled'), iterations: totalIterations };
    }
    const recursive = component.length > 1
      || calleesOf(component[0]).includes(component[0]);

    let iterations = 0;
    let changed = true;
    let converged = true;
    const componentDigests = new Map();

    // Members of a recursive component start at the bottom of the effect
    // lattice — no effects — and the transfer functions only ever add. That is
    // the standard least-fixed-point construction for a may-analysis: the
    // intermediate states are optimistic and unsound, and that is fine because
    // only the fixed point is ever published. A component that does not reach
    // one is republished conservatively below, never left in its optimistic
    // intermediate state.
    while (changed) {
      if (iterations >= limits.maxIterationsPerComponent) { converged = false; break; }
      iterations += 1;
      totalIterations += 1;
      changed = false;
      for (const functionId of component) {
        const next = composeSummary({ functionId, locals, models, solved, component, limits, status, snapshotId });
        const digest = functionSummaryDigest(next);
        if (componentDigests.get(functionId) !== digest) {
          componentDigests.set(functionId, digest);
          solved.set(functionId, next);
          changed = true;
        }
      }
      if (!recursive) break;
    }

    if (!converged) {
      // The optimistic intermediate state is not a publishable answer. Every
      // member is replaced by a conservative summary carrying an explicit
      // recursion-unconverged effect, so callers see a bounded incomplete
      // result instead of a plausible-looking complete one (P7-INV-010).
      for (const functionId of component) {
        solved.set(functionId, composeSummary({
          functionId, locals, models, solved, component, limits, status, snapshotId, unconverged: true,
        }));
      }
      worstStopReason = 'iteration-limit';
      worstCompleteness = weakestCompleteness(worstCompleteness, 'truncated');
    }
  }

  for (const summary of solved.values()) {
    worstCompleteness = weakestCompleteness(worstCompleteness, summary.status.completeness);
    if (summary.status.stopReason && !worstStopReason) worstStopReason = summary.status.stopReason;
  }
  if (worstCompleteness === 'complete') worstStopReason = null;
  else if (!worstStopReason) worstStopReason = 'evidence-missing';

  return {
    summaries: solved,
    components,
    iterations: totalIterations,
    status: status(worstCompleteness, worstStopReason),
  };
}

function composeSummary({ functionId, locals, models, solved, component, limits, status, snapshotId, unconverged = false }) {
  const local = locals.get(functionId);
  if (!local) fail('interprocedural-missing-local-summary');
  if (local.functionId !== functionId) fail('interprocedural-local-summary-identity-mismatch');

  // A local P7-3a summary records a placeholder for every call it could not
  // resolve: an `unknownCallEffect` plus broad fallback memory effects. Once
  // the callee is solved, that placeholder must be *replaced* by the callee's
  // proven effects, not unioned with them — inheriting both keeps the call
  // boundary open forever and pins every upstream summary conservative
  // (#5851). A call site counts as resolved only when every one of its targets
  // has a solved summary; a model-covered or still-unknown target keeps the
  // local fallback in place.
  const resolvedCallSites = new Set();
  // A summary can exist in the solve map while still being partial (for
  // example, because its own callee or memory evidence is unresolved). Such a
  // summary is not enough to replace this caller's conservative fallback: only
  // a complete callee proves that the call boundary is closed.
  const isCompleteSolved = (target) => solved.get(target)?.status?.completeness === 'complete';
  for (const call of local.directCalls) {
    if (call.targetEntityIds.length > 0 && call.targetEntityIds.every(isCompleteSolved)) {
      resolvedCallSites.add(call.callSiteId);
    }
  }
  for (const set of local.indirectCallSets) {
    if (set.exhaustive && set.candidateEntityIds.length > 0
      && set.candidateEntityIds.every(isCompleteSolved)) {
      resolvedCallSites.add(set.callSiteId);
    }
  }
  // Local fallback effects are only replaceable when every unknown the local
  // pass recorded points at a resolved call site. An unknown from any other
  // node — an unresolved memory effect, a stale identity, a non-exhaustive
  // candidate set — keeps the whole local fallback, because the broad effects
  // are not attributable per call site and dropping them would claim more
  // than the solve proved.
  const replaceCallFallbacks = local.unknownCallEffects.length > 0
    && local.unknownCallEffects.every((unknown) => resolvedCallSites.has(unknown.callSiteId));
  const notCallFallback = (effect) => effect.source !== 'unknown-call-fallback';

  const reads = [replaceCallFallbacks ? local.memoryReadRegions.filter(notCallFallback) : local.memoryReadRegions];
  const writes = [replaceCallFallbacks ? local.memoryWriteRegions.filter(notCallFallback) : local.memoryWriteRegions];
  const unknowns = replaceCallFallbacks ? [] : [...local.unknownCallEffects];
  const calleeStatuses = [];
  const noreturn = [local.noreturn];
  const mayThrow = [local.mayThrow];
  const escapes = [...local.escapes];

  const accumulateCallee = (callee) => {
    reads.push(callee.memoryReadRegions);
    writes.push(callee.memoryWriteRegions);
    escapes.push(...callee.escapes);
    // Keep provenance-bearing unresolved effects and control-flow knowledge in
    // lockstep with the memory dimensions for every resolved call edge.
    unknowns.push(...callee.unknownCallEffects);
    noreturn.push(callee.noreturn);
    mayThrow.push(callee.mayThrow);
    calleeStatuses.push(callee.status);
  };

  for (const call of local.directCalls) {
    for (const target of call.targetEntityIds) {
      const callee = solved.get(target);
      if (callee) {
        // Propagated unknowns keep the *originating* call site rather than
        // accumulating a path prefix. A growing identifier would make the
        // effect lattice infinite and the recursive fixed point would never
        // converge — the exact summary-growth failure §9.4 warns about.
        accumulateCallee(callee);
        continue;
      }
      if (component.includes(target)) {
        // A member of our own component that this iteration has not reached
        // yet. It contributes nothing for now; the fixed point revisits it, and
        // the optimistic intermediate state is never published.
        continue;
      }
      const model = models.get(target);
      const validatedModel = model && !locals.has(target)
        ? validateLibraryModel(model, { targetEntityId: target, snapshotId })
        : null;
      if (validatedModel) {
        // A library model applies only where the binary does not define the
        // callee, so it can never override contradictory binary evidence.
        reads.push(validatedModel.memoryReadRegions);
        writes.push(validatedModel.memoryWriteRegions);
        escapes.push(...validatedModel.escapes);
        noreturn.push(validatedModel.noreturn);
        mayThrow.push(validatedModel.mayThrow);
        continue;
      }
      writes.push([broadEffect('unknown-call-fallback')]);
      unknowns.push(createUnknownCallEffect({
        callSiteId: call.callSiteId,
        reason: locals.has(target) ? 'summary-missing' : 'library-model-missing',
        targetEntityIds: [target],
      }));
      noreturn.push('unknown');
      mayThrow.push('unknown');
    }
  }

  for (const set of local.indirectCallSets) {
    for (const candidate of set.candidateEntityIds) {
      const callee = solved.get(candidate);
      if (callee) {
        accumulateCallee(callee);
        continue;
      }
      if (component.includes(candidate)) continue;
      const model = models.get(candidate);
      const validatedModel = model && !locals.has(candidate)
        ? validateLibraryModel(model, { targetEntityId: candidate, snapshotId })
        : null;
      if (validatedModel) {
        reads.push(validatedModel.memoryReadRegions);
        writes.push(validatedModel.memoryWriteRegions);
        escapes.push(...validatedModel.escapes);
        noreturn.push(validatedModel.noreturn);
        mayThrow.push(validatedModel.mayThrow);
        continue;
      }
      writes.push([broadEffect('unknown-call-fallback')]);
      unknowns.push(createUnknownCallEffect({
        callSiteId: set.callSiteId,
        reason: locals.has(candidate) ? 'summary-missing' : 'library-model-missing',
        targetEntityIds: [candidate],
      }));
      noreturn.push('unknown');
      mayThrow.push('unknown');
    }
    if (!set.exhaustive) {
      writes.push([broadEffect('unknown-call-fallback')]);
      if (!unknowns.some((unknown) => unknown.callSiteId === set.callSiteId)) {
        unknowns.push(createUnknownCallEffect({ callSiteId: set.callSiteId, reason: 'indirect-incomplete-target-set' }));
      }
    }
  }

  if (unconverged) {
    writes.push([broadEffect('unknown-call-fallback')]);
    reads.push([broadEffect('unknown-call-fallback')]);
    unknowns.push(createUnknownCallEffect({ callSiteId: functionId, reason: 'recursion-unconverged' }));
  }

  const unknownsByKey = new Map();
  for (const unknown of unknowns) {
    const key = `${unknown.callSiteId}\u0000${unknown.reason}`;
    const prior = unknownsByKey.get(key);
    if (!prior) {
      unknownsByKey.set(key, unknown);
      continue;
    }
    // Same call site and reason means one logical unresolved call; the target
    // and evidence payloads must union rather than last-wins, or every
    // candidate but the final one vanishes from the published provenance.
    unknownsByKey.set(key, createUnknownCallEffect({
      callSiteId: unknown.callSiteId,
      reason: unknown.reason,
      targetEntityIds: [...prior.targetEntityIds, ...unknown.targetEntityIds],
      evidenceIds: [...prior.evidenceIds, ...unknown.evidenceIds],
    }));
  }
  const dedupedUnknowns = [...unknownsByKey.values()];
  const hasUnknown = dedupedUnknowns.length > 0;
  const localStatus = status(
    hasUnknown ? (unconverged ? 'truncated' : 'partial') : 'complete',
    hasUnknown ? (unconverged ? 'iteration-limit' : 'evidence-missing') : null,
  );

  return createFunctionSummary({
    functionId,
    inputs: local.inputs,
    returnValues: local.returnValues,
    // Return provenance is a local return-expression fact. Composition must
    // preserve it exactly once the component converges; otherwise the solved
    // A3 summary becomes less informative than its local input. An unconverged
    // optimistic state is never allowed to publish exact provenance.
    returnProvenance: unconverged ? [] : local.returnProvenance,
    registerEffects: local.registerEffects,
    memoryReadRegions: mergeEffects(reads, limits.maxEffectsPerSummary),
    memoryWriteRegions: mergeEffects(writes, limits.maxEffectsPerSummary),
    escapes: mergeEscapes(escapes),
    allocations: local.allocations,
    frees: local.frees,
    directCalls: local.directCalls,
    indirectCallSets: local.indirectCallSets,
    unknownCallEffects: dedupedUnknowns,
    noreturn: hasUnknown ? 'unknown' : unionKnowledge(noreturn),
    mayThrow: hasUnknown ? 'unknown' : unionKnowledge(mayThrow),
    stackDelta: local.stackDelta,
    semanticFacts: local.semanticFacts,
    status: calleeStatuses.length ? mergeAnalysisStatus(localStatus, calleeStatuses) : localStatus,
  });
}
