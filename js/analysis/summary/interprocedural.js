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
import { deepFreeze as deepFreezeSummaryView, stableDigest as summaryStableDigest, createEntityId as summaryEntityId } from '../../core/identity/index.js';
import { assertWorldScope as assertSummaryWorld, assertAssumptionSet as assertSummaryAssumptions } from '../../core/identity/world.js';
import { assertScopedAnalysisWork as assertSummaryWork, workStopStatus as summaryWorkStopStatus, AnalysisWorkStopped as SummaryWorkStopped } from '../../core/budgets/scoped-work.js';
import { ResourceBudget as SummaryResourceBudget, BudgetExceededError as SummaryBudgetExceededError } from '../../core/budgets/index.js';
import { snapshotContractData as strictSummaryData, recordFields as strictSummaryFields, exactInteger as strictSummaryInteger,
  exactString as strictSummaryString, stringSet as strictSummaryStrings } from '../../core/identity/structured.js';
import { summaryIdentityMatches } from './contract.js';
import {
  EFFECT_SOURCES,
  createFunctionSummary,
  createMemoryEffect,
  createUnknownCallEffect,
  functionSummaryDigest,
  RETURN_SUMMARY_CANDIDATE_LIMIT,
} from './contract.js';

import { substituteReturnAlternatives, RETURN_FACT_LIMIT } from './return-equations.js';

export const INTERPROCEDURAL_ANALYZER_ID = 'phase7.summary.interprocedural';
export const INTERPROCEDURAL_ANALYZER_VERSION = '1.4.0';

export const INTERPROCEDURAL_DEFAULT_BUDGET = Object.freeze({
  maxIterationsPerComponent: 16,
  maxComponents: 4096,
  maxEffectsPerSummary: 512,
  maxWorkItems: 2000000,
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

function weakestSource(left, right) {
  const leftRank = SOURCE_AUTHORITY_RANK.get(left) ?? SOURCE_AUTHORITY_RANK.size;
  const rightRank = SOURCE_AUTHORITY_RANK.get(right) ?? SOURCE_AUTHORITY_RANK.size;
  return leftRank >= rightRank ? left : right;
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

function effectAddressSpaces(effect) {
  if (effect.broad) return effect.addressSpaces?.length ? effect.addressSpaces : [];
  return effect.addressSpaces?.length ? effect.addressSpaces : ['memory'];
}

function mergeEffects(lists, cap) {
  const effectiveCap = Number.isSafeInteger(cap) && cap >= 1 ? cap : 1;
  const byKey = new Map();
  const broadByKey = new Map();
  for (const effect of lists.flat()) {
    if (effect.broad) {
      // A broad effect is already a coverage claim for every region in each
      // address space. Keep source and evidence attached to those spaces while
      // deduping repeated observations; a later broad effect must not rewrite
      // the authority of an earlier, disjoint space.
      const spaces = effect.addressSpaces.length ? effect.addressSpaces : [null];
      for (const addressSpace of spaces) {
        const key = `${effect.source}\u0000${addressSpace ?? ''}`;
        const prior = broadByKey.get(key);
        const addressSpaces = addressSpace == null ? [] : [addressSpace];
        broadByKey.set(key, createMemoryEffect({
          ...(prior ?? effect),
          broad: true,
          addressSpaces,
          evidenceIds: [...new Set([...(prior?.evidenceIds ?? []), ...effect.evidenceIds])].sort(),
        }));
      }
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
  const specific = [...byKey.values()].sort((left, right) => {
    const leftKey = `${left.regionId ?? ''}\u0000${left.regionKind}\u0000${SOURCE_AUTHORITY_RANK.get(left.source) ?? SOURCE_AUTHORITY_RANK.size}\u0000${left.addressSpaces.join(',')}\u0000${left.evidenceIds.join(',')}`;
    const rightKey = `${right.regionId ?? ''}\u0000${right.regionKind}\u0000${SOURCE_AUTHORITY_RANK.get(right.source) ?? SOURCE_AUTHORITY_RANK.size}\u0000${right.addressSpaces.join(',')}\u0000${right.evidenceIds.join(',')}`;
    return compareCodeUnitStrings(leftKey, rightKey);
  });
  const broad = [...broadByKey.values()].sort((left, right) => {
    const leftKey = `${SOURCE_AUTHORITY_RANK.get(left.source) ?? SOURCE_AUTHORITY_RANK.size}\u0000${left.addressSpaces.join(',')}\u0000${left.evidenceIds.join(',')}`;
    const rightKey = `${SOURCE_AUTHORITY_RANK.get(right.source) ?? SOURCE_AUTHORITY_RANK.size}\u0000${right.addressSpaces.join(',')}\u0000${right.evidenceIds.join(',')}`;
    return compareCodeUnitStrings(leftKey, rightKey);
  });
  const combined = [...broad, ...specific];
  if (broad.length === 0 && specific.length > effectiveCap) {
    const spaces = [...new Set(specific.flatMap(effectAddressSpaces))].sort();
    const evidenceIds = [...new Set(specific.flatMap((effect) => effect.evidenceIds || []))].sort();
    return [createMemoryEffect({
      regionKind: 'unknown',
      broad: true,
      addressSpaces: spaces,
      source: 'unknown-call-fallback',
      evidenceIds,
    })];
  }
  if (combined.length > effectiveCap) {
    // Any entry folded into a new broad claim loses its precise geometry. A
    // conservative fallback source is therefore required whenever a specific
    // effect is dropped; broad-only collapse can retain the weakest broad
    // authority without laundering a stronger source into another space.
    const kept = combined.slice(0, Math.max(0, effectiveCap - 1));
    const dropped = combined.slice(kept.length);
    const droppedSpaces = [...new Set(dropped.flatMap(effectAddressSpaces))].sort();
    const droppedEvidence = [...new Set(dropped.flatMap((effect) => effect.evidenceIds || []))].sort();
    const hasSpecific = dropped.some((effect) => !effect.broad);
    const source = hasSpecific
      ? 'unknown-call-fallback'
      : dropped.reduce((current, effect) => weakestSource(current, effect.source), dropped[0]?.source || 'unknown-call-fallback');
    const finalBroad = createMemoryEffect({
      regionKind: 'unknown',
      broad: true,
      addressSpaces: droppedSpaces,
      source,
      evidenceIds: droppedEvidence,
    });
    return [finalBroad, ...kept];
  }
  return combined;
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
  expectedSummaryDigests = new Map(),
  libraryModels = new Map(),
  budget = {},
  snapshotId = 'snapshot-unbound',
  budgetClass = null,
  signal = null,
} = {}) {
  const limits = { ...INTERPROCEDURAL_DEFAULT_BUDGET, ...budget };
  const sources = localSummaries instanceof Map ? localSummaries : new Map(Object.entries(localSummaries ?? {}));
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

  if (!(expectedSummaryDigests instanceof Map)) fail('interprocedural-expected-digests-required-map');
  if (!Number.isSafeInteger(limits.maxWorkItems) || limits.maxWorkItems < 0) fail('interprocedural-invalid-work-budget');
  const workBudget = new SummaryResourceBudget({ workUnits:limits.maxWorkItems }, { name:'interprocedural-summary' });
  const checkpoint = () => {
    if (signal?.aborted) throw new SummaryWorkStopped('cancelled', 'summary-cancelled');
    workBudget.consume('workUnits');
  };
  // Pin only the reachable source summaries. Invalid/stale envelopes are
  // explicit conservative placeholders, never re-stamped as exact facts.
  const pinned = new Map();
  const locals = {
    has:id => sources.has(id),
    get(id) {
      if (pinned.has(id)) return pinned.get(id);
      let source = sources.get(id);
      if (!source || source.functionId !== id) return null;
      // #6208's legacy API also accepts versionless EFFECT-only constructor
      // inputs. Never upgrade old wire versions, equation data or return facts.
      if (snapshotId === 'snapshot-unbound' && source.schemaVersion == null && source.contractVersion == null
        && source.returnEquations == null && !source.returnValues?.length && !source.returnProvenance?.length) {
        try { source = createFunctionSummary(source); } catch { /* rejected below */ }
      }
      // Preserve the legacy unbound effect-only API. It cannot certify a
      // return from a different snapshot: composeReturns still requires an
      // exact snapshot match. Explicit snapshot callers always reject stale
      // sources before graph discovery or effect composition.
      const expected = { functionId:id, ...(snapshotId === 'snapshot-unbound' ? {} : { snapshotId }) };
      const digestValid = !expectedSummaryDigests.has(id)
        || typeof expectedSummaryDigests.get(id) === 'string';
      if (expectedSummaryDigests.has(id)) expected.digest = expectedSummaryDigests.get(id);
      const local = digestValid && summaryIdentityMatches(source, expected)
        ? createFunctionSummary(source)
        : createFunctionSummary({ functionId:id, unknownCallEffects:[createUnknownCallEffect({
          callSiteId:id, reason:'summary-stale', targetEntityIds:[id] })],
        memoryReadRegions:[broadEffect('unknown-call-fallback')],
        memoryWriteRegions:[broadEffect('unknown-call-fallback')], status:status('partial', 'evidence-missing') });
      pinned.set(id, local);
      return local;
    },
  };

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
    let groundUnresolved = false;
    const componentDigests = new Map();

    // Members of a recursive component start at the bottom of the effect
    // lattice — no effects — and the transfer functions only ever add. That is
    // the standard least-fixed-point construction for a may-analysis: the
    // intermediate states are optimistic and unsound, and that is fine because
    // only the fixed point is ever published. A component that does not reach
    // one is republished conservatively below, never left in its optimistic
    // intermediate state.
    try {
      while (changed) {
        checkpoint();
        if (iterations >= limits.maxIterationsPerComponent) { converged = false; break; }
        iterations += 1;
        totalIterations += 1;
        changed = false;
        for (const functionId of component) {
          checkpoint();
          const next = composeSummary({ functionId, locals, models, solved, component, limits, status, snapshotId, checkpoint, groundUnresolved });
          const digest = functionSummaryDigest(next);
          if (componentDigests.get(functionId) !== digest) {
            componentDigests.set(functionId, digest);
            solved.set(functionId, next);
            changed = true;
          }
        }
        if (!changed && recursive && !groundUnresolved
          && component.some(id => hasEmptyReturnPositions(solved.get(id)))) {
          // Bottom is private, not a proof of noreturn. Revisit these empty
          // positions as unknown in THIS SCC transfer before publication.
          groundUnresolved = true;
          changed = true;
        }
        if (!recursive) break;
      }
      checkpoint();
    } catch (error) {
      if (!(error instanceof SummaryBudgetExceededError) && !(error instanceof SummaryWorkStopped)) throw error;
      // A stop in the middle of an SCC must not leak its optimistic members.
      for (const id of component) solved.delete(id);
      const cancelled = signal?.aborted || error.status === 'cancelled';
      return { summaries:solved, components, iterations:totalIterations,
        status:status(cancelled ? 'partial' : 'truncated', cancelled ? 'cancelled' : 'budget-exhausted') };
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

function hasEmptyReturnPositions(summary) {
  if (!summary?.returnEquations) return false;
  const positions = new Set(summary.returnProvenance.map(fact => fact.returnIndex ?? 0));
  return summary.returnEquations.sites.some(site => !positions.has(site.returnIndex));
}

// Reused df98376ae transfer: the local equation describes expressions; only
// the canonical SCC's current callee state can discover their return roots.
function composeReturns(local, locals, solved, component, snapshotId, checkpoint, groundUnresolved) {
  const unknowns = () => [...new Set([
    ...local.returnProvenance.map(fact => fact.returnIndex ?? 0),
    ...(local.returnEquations?.sites ?? []).map(site => site.returnIndex),
  ])].sort((a, b) => a - b).map(returnIndex => ({ kind:'unknown', returnIndex }));
  if (!summaryIdentityMatches(local, { functionId:local.functionId, snapshotId })
    || local.status.completeness !== 'complete' || local.unknownCallEffects.length) return unknowns();
  if (!local.returnEquations) return local.returnProvenance;
  const facts = new Map();
  const add = fact => { facts.set(JSON.stringify(fact), fact); };
  const direct = new Map(local.directCalls.map(call => [call.callSiteId, call]));
  const indirect = new Map(local.indirectCallSets.map(call => [call.callSiteId, call]));
  for (const row of local.returnEquations.rows) {
    checkpoint();
    if (row.kind === 'fact') { add(row.fact); }
    else {
      const call = direct.get(row.callSiteId), set = indirect.get(row.callSiteId);
      const targets = call?.targetEntityIds ?? set?.candidateEntityIds ?? [];
      if ((!call && !set?.exhaustive) || !targets.length || targets.length > RETURN_SUMMARY_CANDIDATE_LIMIT) {
        add({ kind:'unknown', returnIndex:row.returnIndex });
      } else for (const target of targets) {
        checkpoint();
        if (!summaryIdentityMatches(locals.get(target), { functionId:target, snapshotId })) {
          add({ kind:'unknown', returnIndex:row.returnIndex }); continue;
        }
        const callee = solved.get(target);
        if (!callee && component.includes(target)) continue; // private bottom
        if (!summaryIdentityMatches(callee, { functionId:target, snapshotId })
          || callee.status.completeness !== 'complete' || callee.unknownCallEffects.length) {
          add({ kind:'unknown', returnIndex:row.returnIndex }); continue;
        }
        const alternatives = callee.returnProvenance.filter(fact => (fact.returnIndex ?? 0) === row.callReturnIndex);
        if (!alternatives.length && (groundUnresolved || !component.includes(target)
          || !callee.returnEquations?.sites.some(site => site.returnIndex === row.callReturnIndex))) {
          add({ kind:'unknown', returnIndex:row.returnIndex });
        }
        for (const alternative of alternatives) {
          for (const fact of substituteReturnAlternatives(alternative, row.arguments, row.returnIndex, row.offset, checkpoint)) add(fact);
          if (facts.size > RETURN_FACT_LIMIT) return unknowns();
        }
      }
    }
    if (facts.size > RETURN_FACT_LIMIT) return unknowns();
  }
  return [...facts.values()];
}

function composeSummary({ functionId, locals, models, solved, component, limits, status, snapshotId, unconverged = false,
  checkpoint = () => {}, groundUnresolved = false }) {
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
    // Unknown effects and nonconvergence cannot publish strong return facts.
    returnProvenance: unconverged || hasUnknown ? []
      : composeReturns(local, locals, solved, component, snapshotId, checkpoint, groundUnresolved),
    returnEquations: local.returnEquations,
    returnSourceDigest: local.returnSourceDigest,
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
    status: mergeAnalysisStatus(localStatus,
      [...(replaceCallFallbacks ? [] : [status(local.status.completeness, local.status.stopReason)]), ...calleeStatuses]),
  });
}

/* SCPA demand execution: same transfer function, separately owned publication. */
export const DEMAND_SUMMARY_SESSION_VERSION = '1.0.0';
const DEMAND_SUMMARY_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEMAND_SUMMARY_OUTPUT_ROWS = 64;
const DEMAND_SUMMARY_TOTAL_LIMITS = Object.freeze({ workUnits: 2000000, residentBytes: 32 * 1024 * 1024,
  bytesRead: 64 * 1024 * 1024, calls: 4096, nodes: 65536, edges: 262144, results: 4096,
  artifactsMaterialized: 1024, pagesFetched: 4096, queueOperations: 1000000, transfers: 32768, steps: 128 });

/**
 * A single-writer, resumable execution of this owner's SCC transfer. Optimistic
 * recursive states are PRIVATE. A pause between two members of an SCC exposes
 * none of that SCC, unlike copying the old solver's working map mid-iteration.
 * Session checkpoints are diagnostic/restart hints, never canonical summaries.
 *
 * v1 is deliberately context-insensitive. Context specialization needs actual
 * argument/object substitution by this owner, not a new label on the same fact.
 */
export class DemandSummarySession {
  #world; #assumptions; #snapshotId; #limits; #locals; #models; #components;
  #successors; #settled = new Map(); #active = null; #component = 0;
  #iterations = 0; #transfers = 0; #busy = false; #closed = false; #id;
  #assertCurrent; #roots; #inputDigest; #statusFactory;
  #ledger; #terminalReason = null; #settledSizes = new Map(); #settledDigests = new Map();

  constructor(token, state) {
    if (token !== DEMAND_SUMMARY_CONSTRUCTOR) fail('demand-summary-use-prepare');
    this.#world = state.world; this.#assumptions = state.assumptions;
    this.#snapshotId = state.snapshotId; this.#limits = state.limits;
    this.#locals = state.locals; this.#models = state.models;
    this.#components = state.components; this.#successors = state.successors;
    this.#roots = state.roots; this.#inputDigest = state.inputDigest;
    this.#assertCurrent = state.assertCurrent; this.#id = state.id; this.#ledger = state.ledger;
    this.#statusFactory = (completeness, stopReason) => createAnalysisStatus({
      snapshotId: state.snapshotId, analyzerId: INTERPROCEDURAL_ANALYZER_ID,
      analyzerVersion: INTERPROCEDURAL_ANALYZER_VERSION, completeness,
      budgetClass: 'interactive', stopReason,
    });
  }
  get id() { return this.#id; }
  get done() { return this.#component >= this.#components.length; }
  get resumable() { return !this.#closed && !this.done && this.#terminalReason === null; }
  #consume(resource, amount = 1) {
    try { this.#ledger.consume(resource, amount); }
    catch (error) {
      if (error instanceof SummaryBudgetExceededError) this.#terminalReason = `session-${resource}-budget`;
      throw error;
    }
  }
  #charge(work, resource, amount = 1) {
    // Separate per-invocation and lifetime scopes both use ResourceBudget.
    // The lifetime ledger cannot be reset by consuming a new continuation.
    work.charge(resource, amount); this.#consume(resource, amount);
  }
  #current() {
    if (this.#closed) throw new Error('demand-summary-session-closed');
    // A host closure checks immutable input identities/negative-dependency
    // epochs. It is not supplied over the AI or plugin RPC interface.
    if (this.#assertCurrent && this.#assertCurrent() !== true) {
      this.close(); throw new Error('demand-summary-input-stale');
    }
  }
  #beginComponent() {
    const members = this.#components[this.#component];
    const activeValues = new Map();
    const solved = { get: (id) => activeValues.get(id) ?? this.#settled.get(id) };
    this.#active = { members, values: activeValues, solved, digests: new Map(), sizes: new Map(),
      position: 0, iteration: 1, changed: false, conservative: false, groundUnresolved: false,
      recursive: members.length > 1 || this.#successors.get(members[0]).includes(members[0]) };
    this.#iterations++;
  }
  #publishComponent() {
    const active = this.#active;
    // No await, event-loop yield or consumer callback in this atomic commit.
    for (const id of active.members) {
      this.#settled.set(id, active.values.get(id));
      this.#settledDigests.set(id, active.digests.get(id));
      this.#settledSizes.set(id, active.sizes.get(id));
    }
    this.#active = null; this.#component++;
  }
  #view(executionStatus, cost) {
    // A diagnostic result must remain bounded even after timeout. Digests and
    // retained payload sizes were computed before publication, not in this
    // finalizer; no expensive stringification occurs after a cancelled step.
    const values = [], omittedFunctionIds = [];
    let outputBytes = 0;
    let completeness = this.done ? 'complete' : 'partial';
    let reason = this.done ? null : 'dependency-missing';
    for (const [functionId, summary] of this.#settled) {
      completeness = weakestCompleteness(completeness, summary.status.completeness);
      reason ??= summary.status.stopReason;
      const bytes = this.#settledSizes.get(functionId) ?? DEMAND_SUMMARY_OUTPUT_BYTES + 1;
      if (values.length >= DEMAND_SUMMARY_OUTPUT_ROWS || outputBytes + bytes > DEMAND_SUMMARY_OUTPUT_BYTES) {
        omittedFunctionIds.push(functionId); continue;
      }
      outputBytes += bytes;
      values.push({ functionId, summary, digest: this.#settledDigests.get(functionId) });
    }
    values.sort((a, b) => a.functionId < b.functionId ? -1 : a.functionId > b.functionId ? 1 : 0);
    omittedFunctionIds.sort();
    if (omittedFunctionIds.length) { completeness = weakestCompleteness(completeness, 'partial'); reason = 'budget-exhausted'; }
    if (executionStatus !== 'completed' && executionStatus !== 'paused') {
      completeness = weakestCompleteness(completeness, 'partial');
      reason = executionStatus === 'stale' ? 'dependency-mismatch' : executionStatus;
    }
    if (completeness === 'complete') reason = null;
    return deepFreezeSummaryView({ schema: 'demand-summary-result/v1', sessionId: this.#id,
      worldId: this.#world.id, assumptionsId: this.#assumptions.id, snapshotId: this.#snapshotId,
      context: 'context-insensitive', inputDigest: this.#inputDigest,
      executionStatus, status: this.#statusFactory(completeness, reason),
      done: this.done, resumable: this.resumable, terminalReason: this.#terminalReason,
      summaries: values, requestedRoots: this.#roots,
      output: { complete: omittedFunctionIds.length === 0, omittedFunctionIds, estimatedBytes: outputBytes,
        maximumBytes: DEMAND_SUMMARY_OUTPUT_BYTES, maximumRows: DEMAND_SUMMARY_OUTPUT_ROWS,
        recovery: 'request-a-narrower-root-scope-or-read-settled-summary-through-host' },
      unresolvedRoots: this.#roots.filter((id) => !this.#settled.has(id)),
      components: { settled: this.#component, total: this.#components.length,
        activeMembers: this.#active?.members ?? [], activePublished: false },
      iterations: this.#iterations, transfers: this.#transfers, cost,
      cumulativeBudget: this.#ledger.snapshot() });
  }
  async step(work, { maximumTransfers = 256 } = {}) {
    assertSummaryWork(work);
    strictSummaryInteger(maximumTransfers, 'demand-summary-step-budget', { min: 1, max: 65536 });
    if (this.#busy) fail('demand-summary-concurrent-step');
    this.#current(); this.#busy = true;
    let transferred = 0;
    try {
      if (this.#terminalReason !== null) return this.#view('budget-exhausted', work.cost());
      this.#consume('steps');
      while (!this.done && transferred < maximumTransfers) {
        work.checkpoint(); this.#current();
        if (!this.#active) this.#beginComponent();
        const active = this.#active, functionId = active.members[active.position];
        const local = this.#locals.get(functionId);
        // Per-function cost includes caller effects/targets. A single transfer
        // still has the owner's maxEffectsPerSummary cap, not an unbounded SMT.
        const weight = 1 + local.memoryReadRegions.length + local.memoryWriteRegions.length
          + local.directCalls.reduce((n, call) => n + 1 + call.targetEntityIds.length, 0)
          + local.indirectCallSets.reduce((n, call) => n + 1 + call.candidateEntityIds.length, 0);
        this.#charge(work, 'workUnits', weight); this.#consume('transfers');
        const next = composeSummary({ functionId, locals: this.#locals, models: this.#models,
          solved: active.solved, component: active.members, limits: this.#limits,
          status: this.#statusFactory, snapshotId: this.#snapshotId, unconverged: active.conservative,
          groundUnresolved:active.groundUnresolved, checkpoint:() => this.#charge(work, 'workUnits') });
        let bounded;
        try { bounded = strictSummaryData(next, { allowBigInt: true, maxBytes: 1048576, maxNodes: 32768 }); }
        catch (error) {
          if (typeof error?.code !== 'string' || !error.code.startsWith('analysis-contract-') || !error.code.includes('budget')) throw error;
          this.#terminalReason = 'summary-transfer-payload-budget';
          throw new SummaryWorkStopped('budget-exhausted', this.#terminalReason);
        }
        const payloadBytes = 512 + JSON.stringify(bounded, (_, value) => typeof value === 'bigint' ? value.toString() : value).length * 2;
        this.#charge(work, 'residentBytes', payloadBytes);
        const digest = functionSummaryDigest(next);
        if (active.digests.get(functionId) !== digest) {
          active.digests.set(functionId, digest); active.sizes.set(functionId, payloadBytes); active.values.set(functionId, next); active.changed = true;
        }
        active.position++; transferred++; this.#transfers++;
        if (active.position === active.members.length) {
          if (!active.conservative && active.recursive && !active.changed && !active.groundUnresolved
            && active.members.some(id => hasEmptyReturnPositions(active.values.get(id)))) {
            active.groundUnresolved = true;
            active.changed = true;
          }
          work.checkpoint(); this.#current();
          if (active.conservative || !active.recursive || !active.changed) this.#publishComponent();
          else {
            active.position = 0; active.changed = false;
            if (active.iteration >= this.#limits.maxIterationsPerComponent) active.conservative = true;
            else { active.iteration++; this.#iterations++; }
          }
        }
        await work.yieldIfNeeded();
      }
      this.#current();
      return this.#view(this.done ? 'completed' : 'paused', work.cost());
    } catch (error) {
      if (error?.message === 'demand-summary-input-stale') return this.#view('stale', work.cost());
      const stopped = summaryWorkStopStatus(error, work.signal);
      if (!stopped) throw error;
      return this.#view(stopped, work.cost());
    } finally { this.#busy = false; }
  }
  /** Returns ONLY settled owner summaries, never the active SCC work map. */
  summary(functionId) { this.#current(); return this.#settled.get(functionId) ?? null; }
  checkpoint() {
    this.#current();
    return deepFreezeSummaryView({ schema: 'demand-summary-restart-hint/v1', sessionId: this.#id,
      inputDigest: this.#inputDigest, worldId: this.#world.id, assumptionsId: this.#assumptions.id,
      settledComponentCount: this.#component, settledFunctionIds: [...this.#settled.keys()].sort(),
      activeIteration: this.#active?.iteration ?? null, canonicalAuthority: false,
      restorePolicy: 'restart-from-pinned-inputs; no optimistic-state-import' });
  }
  close() {
    this.#closed = true; this.#active = null; this.#settled.clear(); this.#settledSizes.clear(); this.#settledDigests.clear();
    this.#locals.clear(); this.#models.clear(); this.#successors.clear();
  }
}
const DEMAND_SUMMARY_CONSTRUCTOR = Symbol('demand-summary-constructor');

/**
 * Prepare a bounded demand subgraph. Callers supply only their query frontier;
 * no whole-program materialization is requested here. Canonical transfer and
 * model validation remain the existing functions in this module.
 */
export async function prepareDemandSummarySession({ roots, localSummaries, libraryModels = new Map(),
  world, assumptions, snapshotId, work, limits = {}, assertCurrent = null,
  context = 'context-insensitive' } = {}) {
  assertSummaryWorld(world); assertSummaryAssumptions(assumptions, world); assertSummaryWork(work);
  strictSummaryString(snapshotId, 'demand-summary-snapshot');
  if (context !== 'context-insensitive') return deepFreezeSummaryView({ status: 'unsupported', reason: 'context-substitution-owner-unavailable', session: null });
  if (assertCurrent !== null && typeof assertCurrent !== 'function') fail('demand-summary-current-check');
  const pinnedRoots = strictSummaryStrings(roots, 'demand-summary-roots', 256);
  if (!pinnedRoots.length || !(localSummaries instanceof Map) || !(libraryModels instanceof Map)) fail('demand-summary-input-map');
  const options = strictSummaryData(limits);
  strictSummaryFields(options, ['maxIterationsPerComponent', 'maxComponents', 'maxEffectsPerSummary', 'maxNodes', 'maxEdges'], 'demand-summary-limit-fields');
  const caps = {
    maxIterationsPerComponent: strictSummaryInteger(options.maxIterationsPerComponent ?? 16, 'demand-summary-iterations', { min: 1, max: 256 }),
    maxComponents: strictSummaryInteger(options.maxComponents ?? 1024, 'demand-summary-components', { min: 1, max: 8192 }),
    maxEffectsPerSummary: strictSummaryInteger(options.maxEffectsPerSummary ?? 512, 'demand-summary-effects', { min: 1, max: 4096 }),
    maxNodes: strictSummaryInteger(options.maxNodes ?? 4096, 'demand-summary-nodes', { min: 1, max: 16384 }),
    maxEdges: strictSummaryInteger(options.maxEdges ?? 16384, 'demand-summary-edges', { min: 1, max: 131072 }),
  };
  const locals = new Map(), models = new Map(), successors = new Map(), queue = [...pinnedRoots], queued = new Set(queue);
  let cursor = 0, edges = 0;
  while (cursor < queue.length) {
    work.charge('nodes'); work.charge('workUnits'); work.charge('residentBytes', 1024);
    if (locals.size >= caps.maxNodes) return { status: 'budget-exhausted', reason: 'demand-summary-node-cap', session: null };
    const id = queue[cursor++], source = localSummaries.get(id);
    if (!summaryIdentityMatches(source, { functionId: id, snapshotId })) {
      if (pinnedRoots.includes(id)) return { status: 'unsupported', reason: 'demand-summary-root-identity', session: null };
      continue;
    }
    const detachedSource = strictSummaryData(source, { allowBigInt: true, maxBytes: 1048576, maxNodes: 32768 });
    work.charge('residentBytes', JSON.stringify(detachedSource, (_, value) => typeof value === 'bigint' ? value.toString() : value).length * 2);
    const local = createFunctionSummary(detachedSource); // preserve the sole owner contract
    locals.set(id, local);
    const targets = [...new Set([...local.directCalls.flatMap((call) => call.targetEntityIds),
      ...local.indirectCallSets.flatMap((call) => call.candidateEntityIds)])].sort();
    edges += targets.length;
    work.charge('edges', targets.length); work.charge('workUnits', targets.length);
    if (edges > caps.maxEdges) return { status: 'budget-exhausted', reason: 'demand-summary-edge-cap', session: null };
    const adjacent = [];
    for (const target of targets) {
      if (summaryIdentityMatches(localSummaries.get(target), { functionId: target, snapshotId })) {
        adjacent.push(target);
        if (!queued.has(target)) { queued.add(target); queue.push(target); work.charge('queueOperations'); }
      } else if (!localSummaries.has(target) && libraryModels.has(target)) {
        const model = strictSummaryData(libraryModels.get(target), { allowBigInt: true, maxBytes: 1048576 });
        work.charge('residentBytes', JSON.stringify(model, (_, value) => typeof value === 'bigint' ? value.toString() : value).length * 2);
        if (validateLibraryModel(model, { targetEntityId: target, snapshotId })) models.set(target, model);
      }
    }
    successors.set(id, adjacent);
    await work.yieldIfNeeded();
  }
  work.checkpoint();
  const condensed = condenseCallGraph(pinnedRoots, (id) => successors.get(id) ?? [], { ...caps, signal: work.signal });
  work.charge('workUnits', locals.size + edges);
  if (condensed.truncated || condensed.cancelled) return { status: condensed.cancelled ? 'cancelled' : 'budget-exhausted', reason: 'demand-summary-condensation-incomplete', session: null };
  if (assertCurrent && assertCurrent() !== true) return { status: 'stale', reason: 'demand-summary-input-stale', session: null };
  const input = { snapshotId, roots: pinnedRoots, context, limits: caps, worldId: world.id, assumptionsId: assumptions.id,
    localDigests: [...locals].map(([id, summary]) => [id, functionSummaryDigest(summary)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    models: [...models].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) };
  const inputDigest = summaryStableDigest(input);
  const id = summaryEntityId({ binaryId: world.binarySet[0].binaryId, kind: 'demand-summary-session-input', identity: input });
  const ledger = new SummaryResourceBudget(DEMAND_SUMMARY_TOTAL_LIMITS, { name: 'demand-summary-session' });
  // Preparation is part of the lifetime cost, including source reads charged
  // by the containing query. Counting shared preparation twice is conservative;
  // silently erasing it at the first resume would not be.
  try { for (const [resource, used] of Object.entries(work.cost().used)) ledger.consume(resource, used); }
  catch (error) {
    if (!(error instanceof SummaryBudgetExceededError)) throw error;
    return { status: 'budget-exhausted', reason: 'demand-summary-preparation-total-budget', session: null, cost: work.cost() };
  }
  const session = new DemandSummarySession(DEMAND_SUMMARY_CONSTRUCTOR, { world, assumptions, snapshotId, limits: caps,
    locals, models, successors, components: condensed.components, roots: pinnedRoots, inputDigest, id, assertCurrent, ledger });
  return { status: 'prepared', session, inputDigest, cost: work.cost() };
}
