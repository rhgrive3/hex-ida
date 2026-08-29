/**
 * P7-3a — local FunctionSummary construction.
 *
 * "Local" means: what this function's own body does, with every callee treated
 * as an opaque boundary unless the caller hands us a resolved summary for it.
 * The interprocedural fixed point (P7-3c) is what closes those boundaries; this
 * pass must not pre-empt it by guessing.
 *
 * The pass is deliberately conservative in one specific direction. Anything it
 * cannot resolve becomes a *broad* effect plus an explicit `unknownCallEffect`,
 * never an omission. An omission would read downstream as "this function does
 * not touch that memory", which is the precise shape of FM-4 and the reason the
 * contract refuses to build such a summary at all.
 */

import { createAnalysisStatus, isCompleteStatus, mergeAnalysisStatus } from '../status.js';
import {
  classifyCallTargetProof,
  createFunctionSummary,
  createMemoryEffect,
  createUnknownCallEffect,
  summaryIdentityMatches,
} from './contract.js';

export const LOCAL_SUMMARY_ANALYZER_ID = 'phase7.summary.local';
export const LOCAL_SUMMARY_ANALYZER_VERSION = '1.1.0';

const DEFAULT_ADDRESS_SPACES = Object.freeze(['memory']);

function evidenceOf(node) {
  return [...(node.origin?.instructionIds ?? [])].map(String);
}

function regionsFor(node, resolveRegion) {
  if (typeof resolveRegion !== 'function' || node.memory == null) return [];
  try {
    const resolved = resolveRegion(node.memory, { node });
    return Array.isArray(resolved) ? resolved : [resolved];
  } catch { return []; }
}

function effectsForAccesses(node, scope, resolveRegion, source) {
  const effects = [];
  for (const access of scope.accesses ?? []) {
    const pseudoNode = { ...node, memory: access };
    const regions = regionsFor(pseudoNode, resolveRegion);
    if (!regions.length) {
      effects.push(createMemoryEffect({
        regionKind: 'unknown', broad: true, addressSpaces: [access.addressSpace ?? 'memory'],
        source, evidenceIds: evidenceOf(node),
      }));
      continue;
    }
    for (const region of regions) {
      effects.push(createMemoryEffect({
        regionId: region.id, regionKind: region.kind,
        broad: region.kind === 'unknown',
        addressSpaces: [access.addressSpace ?? 'memory'],
        source, evidenceIds: evidenceOf(node),
      }));
    }
  }
  return effects;
}

function broadEffect(node, addressSpaces, source) {
  return createMemoryEffect({
    regionKind: 'unknown',
    broad: true,
    addressSpaces: addressSpaces?.length ? addressSpaces : DEFAULT_ADDRESS_SPACES,
    source,
    evidenceIds: evidenceOf(node),
  });
}

/**
 * Applies one call or intrinsic effect scope.
 *
 * `scope.scope` is the semantic IR's own vocabulary: `none` means proven no
 * effect, `accesses` means an enumerated list, `all` means everything in the
 * named address spaces, and `unknown` means we do not know — which is not the
 * same as `none` and must not collapse into it.
 */
function applyScope({ node, scope, resolveRegion, into, source }) {
  if (scope == null) { into.push(broadEffect(node, null, source)); return false; }
  if (scope.scope === 'none') return true;
  if (scope.scope === 'accesses') { into.push(...effectsForAccesses(node, scope, resolveRegion, source)); return true; }
  if (scope.scope === 'all') { into.push(broadEffect(node, scope.addressSpaces, source)); return true; }
  into.push(broadEffect(node, null, source));
  return false;
}

/**
 * Builds the local summary for one function.
 *
 * `calleeSummaries` maps a callee entity id to an already-proven summary. When
 * one is present the callee's effects are folded in with `proven-summary`
 * authority; when it is absent the call stays an explicit unknown boundary.
 */
export function buildLocalFunctionSummary(ir, cfg, ssa, memorySsa, options = {}) {
  const resolveRegion = options.resolveRegion ?? null;
  const calleeSummaries = options.calleeSummaries instanceof Map
    ? options.calleeSummaries
    : new Map(Object.entries(options.calleeSummaries ?? {}));

  const memoryReadRegions = [];
  const memoryWriteRegions = [];
  const unknownCallEffects = [];
  const directCalls = [];
  const indirectCallSets = [];
  const registerEffects = new Set();
  const readVariables = new Set();
  const writtenVariables = new Set();
  const returnValues = new Set();
  const statuses = [];

  let sawReturn = false;
  let sawNoreturnCall = false;
  let mayThrow = false;
  let controlUnknown = false;

  if (options.signal?.aborted) {
    return {
      summary: null,
      status: createAnalysisStatus({
        snapshotId: options.snapshotId ?? 'snapshot-unbound',
        analyzerId: LOCAL_SUMMARY_ANALYZER_ID,
        analyzerVersion: LOCAL_SUMMARY_ANALYZER_VERSION,
        completeness: 'partial',
        stopReason: 'cancelled',
      }),
    };
  }

  const ensureBroadWrite = (node) => {
    if (!memoryWriteRegions.some((effect) => effect.broad)) {
      memoryWriteRegions.push(broadEffect(node, null, 'unknown-call-fallback'));
    }
  };

  if (Array.isArray(ssa?.definitions) && Array.isArray(ssa?.uses) && ssa.uses.length > 0) {
    const defsByValueId = new Map(ssa.definitions.map((d) => [d.valueId, d]));
    const isEntryReaching = (valueId, visited = new Set()) => {
      if (visited.has(valueId)) return false;
      visited.add(valueId);
      const def = defsByValueId.get(valueId);
      if (!def) return true;
      if (def.kind === 'entry' || def.kind === 'undef') return true;
      if (def.kind === 'phi') {
        return (def.incoming ?? []).some((inc) => isEntryReaching(inc.valueId, visited));
      }
      return false;
    };
    for (const use of ssa.uses) {
      if (isEntryReaching(use.valueId)) {
        const def = defsByValueId.get(use.valueId);
        const varKey = def?.variableKey ?? use.variableKey;
        if (varKey) readVariables.add(varKey);
      }
    }
  }

  const returnProvenance = [];
  const nodeByOutput = new Map();
  const valueById = new Map((ir.values ?? []).map((value) => [String(value.id), value]));
  for (const n of ir.nodes ?? []) {
    for (const out of n.outputs ?? []) nodeByOutput.set(out, n);
  }

  const formalArgumentIndex = (valueId) => {
    if (Array.isArray(ir.inputs)) return ir.inputs.indexOf(valueId);
    const value = valueById.get(String(valueId));
    const explicit = value?.metadata?.argumentIndex
      ?? value?.metadata?.argIndex
      ?? value?.metadata?.abiArgIndex;
    const index = explicit == null ? null : Number(explicit);
    return Number.isSafeInteger(index) && index >= 0 ? index : -1;
  };

  const summaryIdentityOptions = (functionId) => {
    const configured = options.summaryIdentity ?? options.expectedSummaryIdentity;
    const identity = configured && typeof configured === 'object' && !Array.isArray(configured)
      ? configured
      : {};
    return {
      functionId,
      snapshotId: options.snapshotId ?? 'snapshot-unbound',
      analyzerId: options.summaryAnalyzerId ?? options.expectedSummaryAnalyzerId ?? identity.analyzerId ?? null,
      analyzerVersion: options.summaryAnalyzerVersion
        ?? options.expectedSummaryAnalyzerVersion
        ?? identity.analyzerVersion
        ?? null,
    };
  };

  const callInfo = (node) => {
    const targetProof = classifyCallTargetProof(node.call);
    const targets = targetProof.candidateEntityIds;
    const calleeId = targetProof.exactSingletonEntityId;
    const supplied = calleeId == null ? null : calleeSummaries.get(calleeId);
    const current = supplied != null && summaryIdentityMatches(supplied, summaryIdentityOptions(calleeId))
      ? supplied
      : null;
    return {
      targetProof,
      targets,
      supplied,
      resolved: current,
      identityMismatch: supplied != null && current == null,
    };
  };

  /**
   * Compose a call-produced return through the current function. A call result
   * is a boundary, not an argument of the current function; only a complete,
   * identity-matched callee summary can turn it into one of the finite return
   * facts. Any unrecognised alternative remains an explicit unknown member.
   */
  const composeCallReturnProvenance = (callNode, outputValueId, outerReturnIndex, outerOffset) => {
    const info = callInfo(callNode);
    const callee = info.resolved;
    if (!callee || !isCompleteStatus(callee.status) || callee.unknownCallEffects.length > 0) return null;
    const callReturnIndex = (callNode.outputs ?? []).indexOf(outputValueId);
    if (callReturnIndex < 0) return null;
    const alternatives = (callee.returnProvenance ?? []).filter(
      (provenance) => Number(provenance.returnIndex ?? 0) === callReturnIndex,
    );
    if (!alternatives.length) return null;
    const argumentIds = callNode.call?.arguments?.length ? callNode.call.arguments : callNode.inputs;
    const composed = [];
    for (const provenance of alternatives) {
      let offset;
      try { offset = BigInt(outerOffset ?? 0n) + BigInt(provenance.offset ?? 0n); }
      catch {
        composed.push({ kind: 'unknown', returnIndex: outerReturnIndex });
        continue;
      }
      if (provenance.kind === 'arg') {
        const argumentId = provenance.argIndex == null ? null : argumentIds?.[provenance.argIndex];
        if (argumentId == null) {
          composed.push({ kind: 'unknown', returnIndex: outerReturnIndex });
          continue;
        }
        // Semantic IR v2 carries actual call argument values. Use the
        // explicit formal mapping (legacy `ir.inputs` or value metadata); an
        // ABI call ordinal alone is not proof that an internal value is a
        // current function argument.
        const callerArgIndex = formalArgumentIndex(argumentId);
        if (!Number.isSafeInteger(callerArgIndex) || callerArgIndex < 0) {
          composed.push({ kind: 'unknown', returnIndex: outerReturnIndex });
          continue;
        }
        composed.push({
          kind: 'arg',
          returnIndex: outerReturnIndex,
          argIndex: callerArgIndex,
          offset: offset.toString(10),
        });
        continue;
      }
      if (provenance.kind === 'root' || provenance.kind === 'allocation') {
        const rootEntityId = provenance.rootEntityId ?? provenance.allocationSiteId ?? null;
        if (rootEntityId == null || !String(rootEntityId).trim()) {
          composed.push({ kind: 'unknown', returnIndex: outerReturnIndex });
          continue;
        }
        const fact = {
          kind: provenance.kind,
          returnIndex: outerReturnIndex,
          rootEntityId: String(rootEntityId),
          offset: offset.toString(10),
        };
        if (provenance.allocationSiteId != null) fact.allocationSiteId = String(provenance.allocationSiteId);
        composed.push(fact);
        continue;
      }
      composed.push({ kind: 'unknown', returnIndex: outerReturnIndex });
    }
    return composed;
  };

  for (const node of ir.nodes ?? []) {
    if (node.kind === 'load' || node.kind === 'store') {
      const into = node.kind === 'load' ? memoryReadRegions : memoryWriteRegions;
      const regions = regionsFor(node, resolveRegion);
      if (!regions.length) {
        into.push(broadEffect(node, [node.memory.addressSpace], 'proven-summary'));
      } else {
        for (const region of regions) {
          into.push(createMemoryEffect({
            regionId: region.id,
            regionKind: region.kind,
            broad: region.kind === 'unknown',
            addressSpaces: [node.memory.addressSpace],
            source: 'proven-summary',
            evidenceIds: evidenceOf(node),
          }));
        }
      }
      continue;
    }

    if (node.kind === 'state-read') {
      if (node.variable?.key && (!ssa?.uses || ssa.uses.length === 0)) {
        if (!writtenVariables.has(node.variable.key)) readVariables.add(node.variable.key);
      }
      continue;
    }
    if (node.kind === 'state-write') {
      if (node.variable?.key) {
        writtenVariables.add(node.variable.key);
        registerEffects.add(node.variable.key);
      }
      continue;
    }
    if (node.kind === 'return') {
      sawReturn = true;
      for (let retIdx = 0; retIdx < (node.inputs ?? []).length; retIdx++) {
        const inputValId = node.inputs[retIdx];
        returnValues.add(String(inputValId));
        let curr = inputValId;
        let offset = 0n;
        const visited = new Set();
        while (curr && !visited.has(curr)) {
          visited.add(curr);
          const producer = nodeByOutput.get(curr);
          if (!producer) break;
          if (producer.kind === 'copy' || producer.kind === 'bitcast') {
            curr = producer.inputs?.[0];
          } else if (producer.kind === 'binary' && (producer.operator === 'add' || producer.operator === 'sub')) {
            const rightConst = producer.inputs?.[1];
            const rightProducer = nodeByOutput.get(rightConst);
            const num = rightProducer?.constant != null ? rightProducer.constant : (typeof rightConst === 'number' || typeof rightConst === 'bigint' ? rightConst : null);
            if (num != null) {
              offset += (producer.operator === 'sub' ? -BigInt(num) : BigInt(num));
              curr = producer.inputs?.[0];
            } else break;
          } else break;
        }
        const terminalProducer = nodeByOutput.get(curr);
        const composed = terminalProducer?.kind === 'call'
          ? composeCallReturnProvenance(terminalProducer, curr, retIdx, offset)
          : null;
        if (composed) {
          returnProvenance.push(...composed);
          continue;
        }
        const inputIndex = formalArgumentIndex(curr);
        if (inputIndex >= 0) {
          returnProvenance.push({
            kind: 'arg',
            returnIndex: retIdx,
            argIndex: inputIndex,
            offset: offset.toString(10),
          });
        } else {
          // Absence of a recovered alternative is not proof that the other
          // alternatives are exhaustive. Keep an explicit unknown member so a
          // caller cannot turn one understood return path into a singleton.
          returnProvenance.push({ kind: 'unknown', returnIndex: retIdx });
        }
      }
      continue;
    }

    if (node.kind === 'intrinsic') {
      applyScope({ node, scope: node.intrinsic?.memoryRead, resolveRegion, into: memoryReadRegions, source: 'abi-rule' });
      applyScope({ node, scope: node.intrinsic?.memoryWrite, resolveRegion, into: memoryWriteRegions, source: 'abi-rule' });
      continue;
    }

    if (node.kind === 'unknown-memory-effect' || node.kind === 'unknown-state-write'
      || node.kind === 'unknown-control-effect' || node.kind === 'incomplete') {
      memoryReadRegions.push(broadEffect(node, null, 'unknown-call-fallback'));
      memoryWriteRegions.push(broadEffect(node, null, 'unknown-call-fallback'));
      unknownCallEffects.push(createUnknownCallEffect({
        callSiteId: node.id, reason: 'unresolved-target', evidenceIds: evidenceOf(node),
      }));
      controlUnknown = true;
      continue;
    }

    if (node.kind !== 'call') continue;

    const { targetProof, targets, resolved, identityMismatch } = callInfo(node);

    if (resolved) {
      // A callee summary can be exact only after the call-site target universe
      // itself is proven. A non-exhaustive singleton must not take this branch.
      statuses.push(resolved.status);
      memoryReadRegions.push(...resolved.memoryReadRegions.map((effect) => createMemoryEffect({ ...effect, source: 'proven-summary' })));
      memoryWriteRegions.push(...resolved.memoryWriteRegions.map((effect) => createMemoryEffect({ ...effect, source: 'proven-summary' })));
      for (const unknown of resolved.unknownCallEffects) {
        // Keep the originating call site. Composing a path prefix here would
        // make the effect set grow every time a summary is recomposed, which is
        // what stops a recursive fixed point from converging.
        unknownCallEffects.push(unknown);
        controlUnknown = true;
        ensureBroadWrite(node);
      }
      if (resolved.mayThrow === true) mayThrow = true;
      if (resolved.mayThrow === 'unknown') controlUnknown = true;
      if (resolved.noreturn === true) sawNoreturnCall = true;
      if (resolved.noreturn === 'unknown') controlUnknown = true;
      if (targetProof.kind === 'indirect') {
        indirectCallSets.push({
          callSiteId: node.id,
          candidateEntityIds: targets,
          exhaustive: true,
          evidenceIds: evidenceOf(node),
        });
      } else {
        directCalls.push({
          callSiteId: node.id, targetEntityIds: targets,
          summaryId: resolved.functionId, effectSource: 'proven-summary',
        });
      }
      continue;
    }

    const complete = node.call?.completeness === 'complete';
    const source = complete ? 'abi-rule' : 'unknown-call-fallback';
    const readOk = applyScope({ node, scope: node.call?.memoryRead, resolveRegion, into: memoryReadRegions, source });
    const writeOk = applyScope({ node, scope: node.call?.memoryWrite, resolveRegion, into: memoryWriteRegions, source });
    const nonExhaustiveIndirect = targetProof.kind === 'indirect' && !targetProof.exhaustive;

    if (!complete || !readOk || !writeOk || nonExhaustiveIndirect) {
      unknownCallEffects.push(createUnknownCallEffect({
        callSiteId: node.id,
        reason: identityMismatch
          ? 'summary-stale'
          : nonExhaustiveIndirect
          ? 'indirect-incomplete-target-set'
          : targets.length ? 'summary-missing' : 'unresolved-target',
        targetEntityIds: targets,
        evidenceIds: evidenceOf(node),
      }));
      controlUnknown = true;
      ensureBroadWrite(node);
    } else {
      if (node.call.mayThrow === true) mayThrow = true;
      if (node.call.mayThrow === 'unknown') controlUnknown = true;
      if (node.call.noreturn === true) sawNoreturnCall = true;
      if (node.call.noreturn === 'unknown') controlUnknown = true;
    }

    if (targetProof.kind === 'indirect') {
      indirectCallSets.push({
        callSiteId: node.id,
        candidateEntityIds: targets,
        exhaustive: targetProof.exhaustive,
        evidenceIds: evidenceOf(node),
      });
    } else if (targets.length) {
      directCalls.push({
        callSiteId: node.id, targetEntityIds: targets,
        summaryId: null, effectSource: source,
      });
    }
  }

  const hasUnknown = unknownCallEffects.length > 0;
  const localStatus = createAnalysisStatus({
    snapshotId: options.snapshotId ?? 'snapshot-unbound',
    analyzerId: LOCAL_SUMMARY_ANALYZER_ID,
    analyzerVersion: LOCAL_SUMMARY_ANALYZER_VERSION,
    completeness: hasUnknown ? 'partial' : 'complete',
    budgetClass: options.budgetClass ?? null,
    stopReason: hasUnknown ? 'evidence-missing' : null,
  });
  const status = statuses.length ? mergeAnalysisStatus(localStatus, statuses) : localStatus;

  const summary = createFunctionSummary({
    functionId: ir.functionId,
    inputs: [...readVariables],
    returnValues: [...returnValues],
    returnProvenance,
    registerEffects: [...registerEffects],
    memoryReadRegions,
    memoryWriteRegions,
    escapes: options.escapes ?? [],
    allocations: options.allocations ?? [],
    frees: options.frees ?? [],
    directCalls,
    indirectCallSets,
    unknownCallEffects,
    // With an unresolved call in the body, neither control fact is settled.
    noreturn: controlUnknown ? 'unknown' : (sawNoreturnCall && !sawReturn),
    mayThrow: controlUnknown ? 'unknown' : mayThrow,
    stackDelta: options.stackDelta ?? null,
    semanticFacts: options.semanticFacts ?? [],
    status,
  });

  return { summary, status };
}
