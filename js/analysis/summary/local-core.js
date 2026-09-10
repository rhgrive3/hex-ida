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
  RETURN_SUMMARY_CANDIDATE_LIMIT,
  createFunctionSummary,
  createMemoryEffect,
  createUnknownCallEffect,
  summaryIdentityMatches,
} from './contract.js';

import { substituteReturnFact, RETURN_EQUATION_LIMIT, RETURN_ARGUMENT_LIMIT } from './return-equations.js';

export const LOCAL_SUMMARY_ANALYZER_ID = 'phase7.summary.local';
export const LOCAL_SUMMARY_ANALYZER_VERSION = '1.4.0';

const DEFAULT_ADDRESS_SPACES = Object.freeze(['memory']);

function parseIntegerConstant(candidate) {
  if (candidate == null) return null;
  const structured = typeof candidate === 'object' && !Array.isArray(candidate);
  if (structured) {
    if (candidate.kind !== 'bitvector') return null;
    if (!Number.isSafeInteger(candidate.widthBits) || candidate.widthBits <= 0) return null;
    if (!Object.hasOwn(candidate, 'value') || candidate.value == null) return null;
  }
  const raw = structured ? candidate.value : candidate;
  if (raw == null) return null;
  try {
    if (typeof raw === 'bigint') return raw;
    if (typeof raw === 'number') return Number.isSafeInteger(raw) ? BigInt(raw) : null;
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!/^[+-]?(?:0x[0-9a-f]+|\d+)$/i.test(text)) return null;
    return BigInt(text);
  } catch { return null; }
}

function integerConstant(value, node) {
  let parsed = null;
  for (const candidate of [
    value?.metadata?.constant,
    node?.attributes?.constant,
    node?.metadata?.constant,
    node?.constant,
  ]) {
    if (candidate == null) continue;
    const next = parseIntegerConstant(candidate);
    if (next == null) return null;
    if (parsed != null && parsed !== next) return null;
    parsed = next;
  }
  return parsed;
}

// Instruction origin evidence carries the same primitive non-empty string
// contract as the canonical origin set (#5776): a structured value must never
// launder into a canonical instruction evidence ID via String(), so malformed
// evidence fails closed instead of joining summary provenance.
function evidenceOf(node) {
  const raw = node.origin?.instructionIds ?? [];
  if (!Array.isArray(raw)) throw new TypeError('summary-invalid-instruction-evidence');
  const evidenceIds = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !value) throw new TypeError('summary-invalid-instruction-evidence');
    if (!evidenceIds.includes(value)) evidenceIds.push(value);
  }
  return evidenceIds;
}

function regionsFor(node, resolveRegion) {
  if (typeof resolveRegion !== 'function' || node.memory == null) return [];
  try {
    const resolved = resolveRegion(node.memory, { node });
    if (resolved == null) return [];
    return Array.isArray(resolved) ? resolved : [resolved];
  } catch { return []; }
}

function effectsForAccesses(node, scope, resolveRegion, source) {
  const effects = [];
  let complete = true;
  for (const access of scope.accesses ?? []) {
    const pseudoNode = { ...node, memory: access };
    const regions = regionsFor(pseudoNode, resolveRegion);
    if (!regions.length) {
      complete = false;
      effects.push(createMemoryEffect({
        regionKind: 'unknown', broad: true, addressSpaces: [access.addressSpace ?? 'memory'],
        source, evidenceIds: evidenceOf(node),
      }));
      continue;
    }
    for (const region of regions) {
      effects.push(createMemoryEffect({
        regionId: region.id, regionKind: region.kind,
        ...(region.kind === 'unknown' ? {} : { region }),
        broad: region.kind === 'unknown',
        addressSpaces: [access.addressSpace ?? 'memory'],
        source, evidenceIds: evidenceOf(node),
      }));
    }
  }
  return { effects, complete };
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
  if (scope.scope === 'accesses') {
    const resolved = effectsForAccesses(node, scope, resolveRegion, source);
    into.push(...resolved.effects);
    return resolved.complete;
  }
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
  // Set when an intrinsic's memory scope is unknown/missing: the summary
  // carries broad effects for it and must not claim complete memory semantics
  // (#5752).
  let intrinsicScopeUnknown = false;

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
  const returnEquationRows = [];
  let returnEquationsBounded = true;
  const nodeByOutput = new Map();
  const valueById = new Map((ir.values ?? []).map((value) => [String(value.id), value]));
  for (const n of ir.nodes ?? []) {
    for (const out of n.outputs ?? []) nodeByOutput.set(out, n);
  }

  const formalArgumentIndex = (valueId) => {
    // Raw/partial call IR may carry a malformed structured argument. Never
    // let an object reach String() here: its default spelling could collide
    // with a real value id (and null-prototype records throw on coercion).
    if (valueId == null || (typeof valueId === 'object' && valueId !== null) || typeof valueId === 'function') return -1;
    if (Array.isArray(ir.inputs)) return ir.inputs.indexOf(valueId);
    const value = valueById.get(String(valueId));
    const explicit = value?.metadata?.argumentIndex
      ?? value?.metadata?.argIndex
      ?? value?.metadata?.abiArgIndex;
    return typeof explicit === 'number' && Number.isSafeInteger(explicit) && explicit >= 0
      ? explicit
      : -1;
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
    const info = { targetProof, targets, resolved:null, identityMismatch:false };
    if (!targetProof.exhaustive || !targets.length || targets.length > RETURN_SUMMARY_CANDIDATE_LIMIT) return info;
    const resolved = [];
    for (const calleeId of targets) {
      if (options.signal?.aborted) return info;
      const supplied = calleeSummaries.get(calleeId);
      if (supplied == null) continue;
      if (!summaryIdentityMatches(supplied, summaryIdentityOptions(calleeId))) {
        info.identityMismatch = true;
        continue;
      }
      resolved.push(supplied);
    }
    if (resolved.length === targets.length) info.resolved = resolved;
    return info;
  };

  const callArgumentFacts = (callNode) => {
    const ids = Array.isArray(callNode.call?.arguments) ? callNode.call.arguments : (callNode.inputs ?? []);
    return ids.map(argument => {
      const valueId = argument && typeof argument === 'object'
        ? (!Array.isArray(argument) && Object.hasOwn(argument, 'valueId') ? argument.valueId : null) : argument;
      const argIndex = formalArgumentIndex(valueId);
      return argIndex < 0 ? { kind:'unknown' } : { kind:'arg', argIndex, offset:'0' };
    });
  };

  /**
   * Compose a call-produced return through the current function. A call result
   * is a boundary, not an argument of the current function; only a complete,
   * identity-matched callee summary can turn it into one of the finite return
   * facts. Any unrecognised alternative remains an explicit unknown member.
   */
  const composeCallReturnProvenance = (callNode, outputValueId, outerReturnIndex, outerOffset) => {
    const info = callInfo(callNode);
    const callees = info.resolved;
    if (!callees || callees.some(callee => !isCompleteStatus(callee.status) || callee.unknownCallEffects.length > 0)) return null;
    const callReturnIndex = (callNode.outputs ?? []).indexOf(outputValueId);
    if (callReturnIndex < 0) return null;
    const alternatives = [];
    for (const callee of callees) {
      const returns = callee.returnProvenance.filter(
        (provenance) => Number(provenance.returnIndex ?? 0) === callReturnIndex,
      );
      // One missing candidate return is unknown, not an empty set. It must
      // never disappear while composing the remaining finite alternatives.
      if (!returns.length) return null;
      alternatives.push(...returns);
    }
    // Canonical Semantic IR carries the argument list independently from a
    // runtime target value; an explicit empty array means a zero-argument
    // call, not a missing field. `callNode.inputs` is a legacy fallback for
    // fixtures that predate the canonical field, never an argument source
    // when the canonical field exists. Arguments may be plain value ids or
    // the canonical structured spelling ({ valueId }); the structured form is
    // unwrapped exactly as escape analysis does (#6151).
    const args = callArgumentFacts(callNode);
    return alternatives.map(provenance => substituteReturnFact(provenance, args, outerReturnIndex, outerOffset));
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
            ...(region.kind === 'unknown' ? {} : { region }),
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
            const rightValue = valueById.get(String(rightConst));
            const hasConstantSource = rightProducer != null || rightValue?.metadata?.constant != null;
            const num = hasConstantSource
              ? integerConstant(rightValue, rightProducer)
              : (typeof rightConst === 'number' || typeof rightConst === 'bigint' ? parseIntegerConstant(rightConst) : null);
            if (num != null) {
              offset += (producer.operator === 'sub' ? -BigInt(num) : BigInt(num));
              curr = producer.inputs?.[0];
            } else break;
          } else break;
        }
        const terminalProducer = nodeByOutput.get(curr);
        const inputIndex = formalArgumentIndex(curr);
        const fact = inputIndex >= 0
          ? { kind:'arg', returnIndex:retIdx, argIndex:inputIndex, offset:offset.toString() }
          : { kind:'unknown', returnIndex:retIdx };
        const row = { siteId:String(node.id), valueId:String(inputValId), returnIndex:retIdx, kind:'fact', fact };
        if (terminalProducer?.kind === 'call' && classifyCallTargetProof(terminalProducer.call).candidateEntityIds.length) {
          delete row.fact;
          Object.assign(row, { kind:'call', callSiteId:String(terminalProducer.id),
            callReturnIndex:terminalProducer.outputs.indexOf(curr), offset:offset.toString(), arguments:callArgumentFacts(terminalProducer) });
          if (row.arguments.length > RETURN_ARGUMENT_LIMIT) returnEquationsBounded = false;
        }
        if (returnEquationRows.length < RETURN_EQUATION_LIMIT) returnEquationRows.push(row);
        else returnEquationsBounded = false;
        const composed = terminalProducer?.kind === 'call'
          ? composeCallReturnProvenance(terminalProducer, curr, retIdx, offset)
          : null;
        if (composed) {
          returnProvenance.push(...composed);
          continue;
        }
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
      // An intrinsic whose memory scope the IR does not spell out gets a
      // broad effect, but ignoring applyScope's verdict here published
      // fully-complete summaries for semantics the analyzer never actually
      // understood (#5752). The unknown scope must weaken completeness too.
      const readUnderstood = applyScope({ node, scope: node.intrinsic?.memoryRead, resolveRegion, into: memoryReadRegions, source: 'abi-rule' });
      const writeUnderstood = applyScope({ node, scope: node.intrinsic?.memoryWrite, resolveRegion, into: memoryWriteRegions, source: 'abi-rule' });
      if (!readUnderstood || !writeUnderstood) intrinsicScopeUnknown = true;
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
      // Consuming an identity-matched callee summary authorizes folding its
      // effects in, not re-grading their authority: each effect keeps the
      // source it was built with, so a library-model or abi-rule fact cannot
      // be laundered into proven-summary by one composition step.
      for (const callee of resolved) {
        statuses.push(callee.status);
        memoryReadRegions.push(...callee.memoryReadRegions.map((effect) => createMemoryEffect({ ...effect })));
        memoryWriteRegions.push(...callee.memoryWriteRegions.map((effect) => createMemoryEffect({ ...effect })));
        for (const unknown of callee.unknownCallEffects) {
          // Keep the originating call site. Composing a path prefix here would
          // make the effect set grow every time a summary is recomposed, which is
          // what stops a recursive fixed point from converging.
          unknownCallEffects.push(unknown);
          controlUnknown = true;
          ensureBroadWrite(node);
        }
        if (callee.mayThrow === true) mayThrow = true;
        if (callee.mayThrow === 'unknown' || callee.noreturn === 'unknown') controlUnknown = true;
      }
      // A possible non-returning target does not prove that the call cannot
      // return. That fact requires agreement of the entire candidate set.
      if (resolved.every(callee => callee.noreturn === true)) sawNoreturnCall = true;
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
          summaryId: resolved[0].functionId, effectSource: 'proven-summary',
        });
      }
      continue;
    }

    const complete = node.call?.completeness === 'complete';
    const source = complete ? 'abi-rule' : 'unknown-call-fallback';
    const readOk = applyScope({ node, scope: node.call?.memoryRead, resolveRegion, into: memoryReadRegions, source });
    const writeOk = applyScope({ node, scope: node.call?.memoryWrite, resolveRegion, into: memoryWriteRegions, source });
    const nonExhaustiveTargets = targetProof.kind !== 'unknown' && !targetProof.exhaustive;
    const nonExhaustiveIndirect = targetProof.kind === 'indirect' && nonExhaustiveTargets;

    if (!complete || !readOk || !writeOk || nonExhaustiveTargets) {
      unknownCallEffects.push(createUnknownCallEffect({
        callSiteId: node.id,
        reason: identityMismatch
          ? 'summary-stale'
          : nonExhaustiveIndirect
          ? 'indirect-incomplete-target-set'
          : nonExhaustiveTargets
          ? 'unresolved-target'
          : targets.length ? 'summary-missing' : 'unresolved-target',
        targetEntityIds: targets,
        evidenceIds: evidenceOf(node),
      }));
      controlUnknown = true;
      ensureBroadWrite(node);
    } else if (node.call.noreturn == null || node.call.mayThrow == null) {
      // Omitted control knowledge is a missing fact, not a negative proof
      // (#5854): promoting null here would publish "returns / does not throw"
      // from raw IR that never carried the fact. Degrade to an unknown call
      // effect instead of folding in absent knowledge.
      unknownCallEffects.push(createUnknownCallEffect({
        callSiteId: node.id,
        reason: 'summary-incomplete',
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
    } else if (targets.length && targetProof.exhaustive) {
      directCalls.push({
        callSiteId: node.id, targetEntityIds: targets,
        summaryId: null, effectSource: source,
      });
    }
  }

  const hasUnknown = unknownCallEffects.length > 0 || intrinsicScopeUnknown;
  // A canonical Semantic IR may record what is missing at the function level:
  // `completeness: 'partial'|'unknown'` with the reasons in `ir.unknowns`,
  // while every individual node stays complete (#5226). Ignoring those fields
  // publishes a complete (even pure) summary for a function whose lowering
  // never covered part of its scope — missing work laundered into "no effect".
  const functionLevelUnknown = (ir.completeness != null && ir.completeness !== 'complete')
    || (Array.isArray(ir.unknowns) && ir.unknowns.length > 0);

  const localStatus = createAnalysisStatus({
    snapshotId: options.snapshotId ?? 'snapshot-unbound',
    analyzerId: LOCAL_SUMMARY_ANALYZER_ID,
    analyzerVersion: LOCAL_SUMMARY_ANALYZER_VERSION,
    completeness: hasUnknown || functionLevelUnknown ? 'partial' : 'complete',
    budgetClass: options.budgetClass ?? null,
    stopReason: hasUnknown || functionLevelUnknown ? 'evidence-missing' : null,
  });
  const status = statuses.length ? mergeAnalysisStatus(localStatus, statuses) : localStatus;

  const summary = createFunctionSummary({
    functionId: ir.functionId,
    inputs: [...readVariables],
    returnValues: [...returnValues],
    returnProvenance,
    returnEquations: returnEquationsBounded ? { version:1, rows:returnEquationRows } : null,
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
