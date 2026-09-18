import { deepFreeze } from '../../core/identity/index.js';
import { createAnalysisStatus } from '../../analysis/status.js';
import { createFunctionSummary, createMemoryEffect, createUnknownCallEffect, createDirectCall } from '../../analysis/summary/contract.js';
import { condenseCallGraph } from '../../analysis/summary/interprocedural.js';
import * as legacy from './bridge.js';
import { lowerVMEffectsToSemanticIr as lowerCore } from './bridge-lowering-v2.js';
import { overlayDexLowering } from './bridge-dex-overlay-v2.js';
import { overlayJvmControlLowering } from './bridge-jvm-control-overlay-v2.js';
import { overlayJvmObjectLowering } from './bridge-jvm-object-overlay-v2.js';
import { overlayJvmLocalLowering } from './bridge-jvm-local-overlay-v2.js';
import { overlayManagedI32ShiftCounts } from './bridge-shift-count-overlay-v2.js';
import { overlayWasmNarrowLoadExtensions } from './bridge-wasm-narrow-load-overlay-v2.js';
import { assertVMEffectFunctionBundleOwnership } from './vm-effects.js';
import { overlayWasmSelect, projectWasmSelectView } from './bridge-wasm-select-overlay-v2.js';
import { isManagedExternalCall } from './call-classification.js';

export const MANAGED_BRIDGE_VERSION = legacy.MANAGED_BRIDGE_VERSION;
export const queryManagedSymbolicVerification = legacy.queryManagedSymbolicVerification;
export const queryManagedRuntimeProvider = legacy.queryManagedRuntimeProvider;
export const buildManagedTypeConstraintGraph = legacy.buildManagedTypeConstraintGraph;
const UNREPRESENTABLE_EFFECT_REASON = 'managed-effect-shape-unrepresentable';
const UNRESOLVED_MEMORY_WIDTH_REASON = 'managed-memory-width-unresolved';
const UNREPRESENTED_POSSIBLE_EXCEPTION_REASON = 'managed-possible-exception-control-unrepresented';
const UNREPRESENTABLE_EFFECT_FIELDS = Object.freeze([
  Object.freeze(['memoryEffects', 'memory']),
  Object.freeze(['callEffects', 'calls']),
  Object.freeze(['controlEffects', 'control']),
]);
const EXACT_BUNDLE_COMPLETENESS = new Set(['exact', 'exact-with-intrinsic']);

function effectRepresentabilityGap(bundle) {
  const categories = [];
  let collapsed = false;
  for (const [field, category] of UNREPRESENTABLE_EFFECT_FIELDS) {
    const count = Array.isArray(bundle?.[field]) ? bundle[field].length : 0;
    if (count > 0) categories.push(category);
    if (field !== 'memoryEffects' && count > 1) collapsed = true;
  }
  return collapsed || categories.length > 1 ? categories : null;
}

function maskUnrepresentableEffects(value) {
  if (!value || !Array.isArray(value.bundles)) return value;
  let changed = false;
  const bundles = value.bundles.map((bundle) => {
    const categories = effectRepresentabilityGap(bundle);
    if (!categories) return bundle;
    changed = true;
    const gaps = categories.map((category) => ({ category, categories: [category], reason: UNREPRESENTABLE_EFFECT_REASON }));
    return deepFreeze({
      ...bundle,
      completeness: EXACT_BUNDLE_COMPLETENESS.has(bundle.completeness) ? 'partial' : bundle.completeness,
      unknownEffects: [...gaps, ...(bundle.unknownEffects ?? [])],
    });
  });
  if (!changed) return value;
  return deepFreeze({
    ...value,
    bundles,
    aggregateCompleteness: value.aggregateCompleteness === 'unknown' ? 'unknown' : 'partial',
  });
}

/*
 * #8857 — possibleExceptions is producer authority for a conditional runtime
 * transfer. Until that predicate has a canonical exceptional-control form, an
 * exact bundle must not become a complete normal-only Semantic IR node. The
 * one existing structural exception is the DEX receiver-null memory fault:
 * bridge-lowering-v2 already turns receiverNullException into a canonical
 * null-reference memory fault, so that authority is not downgraded twice.
 */
function possibleExceptionsAlreadyStructured(bundle) {
  const possibleExceptions = Array.isArray(bundle?.possibleExceptions) ? bundle.possibleExceptions : [];
  if (possibleExceptions.length === 0) return true;
  const hasReceiverNullFault = (bundle.memoryEffects ?? []).some((effect) =>
    effect?.space === 'field' && effect.receiverNullException === true);
  return hasReceiverNullFault && possibleExceptions.every((exception) =>
    exception && typeof exception === 'object' && !Array.isArray(exception) && exception.kind === 'null-reference');
}

function maskUnrepresentedPossibleExceptions(value) {
  if (!value || !Array.isArray(value.bundles)) return value;
  let changed = false;
  const bundles = value.bundles.map((bundle) => {
    const possibleExceptions = Array.isArray(bundle?.possibleExceptions) ? bundle.possibleExceptions : [];
    if (possibleExceptions.length === 0 || possibleExceptionsAlreadyStructured(bundle)) return bundle;
    changed = true;
    const priorUnknowns = Array.isArray(bundle.unknownEffects) ? bundle.unknownEffects : [];
    const hasReason = priorUnknowns.some((effect) => effect?.reason === UNREPRESENTED_POSSIBLE_EXCEPTION_REASON);
    const gap = { category: 'exceptions', categories: ['exceptions'], reason: UNREPRESENTED_POSSIBLE_EXCEPTION_REASON };
    return deepFreeze({
      ...bundle,
      completeness: EXACT_BUNDLE_COMPLETENESS.has(bundle.completeness) ? 'partial' : bundle.completeness,
      unknownEffects: hasReason ? priorUnknowns : [gap, ...priorUnknowns],
    });
  });
  if (!changed) return value;
  return deepFreeze({
    ...value,
    bundles,
    aggregateCompleteness: value.aggregateCompleteness === 'unknown' ? 'unknown' : 'partial',
  });
}

/*
 * #8799 — a missing memory-effect byteWidth is absence of storage-width proof,
 * never evidence for a 4-byte access. The legacy lowering core still carries a
 * 4-byte compatibility fallback, so the public v2 boundary must demote any
 * exact bundle that reaches it without a proven width before the fallback can
 * become canonical `complete` evidence. Producers that already publish a
 * positive byteWidth are byte-for-byte unchanged.
 */
function maskUnprovenMemoryWidths(value) {
  if (!value || !Array.isArray(value.bundles)) return value;
  let changed = false;
  const bundles = value.bundles.map((bundle) => {
    const memoryEffects = Array.isArray(bundle?.memoryEffects) ? bundle.memoryEffects : [];
    const missingWidth = memoryEffects.some((effect) =>
      effect && typeof effect === 'object' && !Array.isArray(effect) && effect.byteWidth == null);
    if (!missingWidth) return bundle;
    changed = true;
    const priorUnknowns = Array.isArray(bundle.unknownEffects) ? bundle.unknownEffects : [];
    const hasReason = priorUnknowns.some((effect) => effect?.reason === UNRESOLVED_MEMORY_WIDTH_REASON);
    const gap = { category: 'memory', categories: ['memory'], reason: UNRESOLVED_MEMORY_WIDTH_REASON };
    return deepFreeze({
      ...bundle,
      completeness: EXACT_BUNDLE_COMPLETENESS.has(bundle.completeness) ? 'partial' : bundle.completeness,
      unknownEffects: hasReason ? priorUnknowns : [gap, ...priorUnknowns],
    });
  });
  if (!changed) return value;
  return deepFreeze({
    ...value,
    bundles,
    aggregateCompleteness: value.aggregateCompleteness === 'unknown' ? 'unknown' : 'partial',
  });
}

export function lowerVMEffectsToSemanticIr(value, options = {}) {
  assertVMEffectFunctionBundleOwnership(value);
  const widthSafe = maskUnprovenMemoryWidths(value);
  const exceptionSafe = maskUnrepresentedPossibleExceptions(widthSafe);
  const representable = maskUnrepresentableEffects(exceptionSafe);
  const lowered = overlayJvmControlLowering(representable, overlayWasmSelect(representable, lowerCore(representable, options), options), options);
  const jvmLowered = overlayJvmObjectLowering(representable, lowered, options);
  const wasmLowered = overlayWasmNarrowLoadExtensions(representable, jvmLowered, options);
  const locallyOverlaid = overlayJvmLocalLowering(representable, overlayDexLowering(representable, wasmLowered), options);
  const overlaid = overlayManagedI32ShiftCounts(representable, locallyOverlaid, options);
  const hasUnrepresentedFunctionExit = representable.bundles?.some((bundle) =>
    bundle.controlEffects?.some((effect) => effect.kind === 'switch'
      && (effect.caseKinds?.some((kind) => kind === 'function-exit')
        || effect.defaultKind === 'function-exit')),
  );
  if (!hasUnrepresentedFunctionExit || overlaid.semanticIr?.completeness !== 'complete') return overlaid;
  const unknowns = Array.isArray(overlaid.semanticIr.unknowns) ? overlaid.semanticIr.unknowns : [];
  if (unknowns.some((item) => item?.reason === 'switch-function-exit-edge-unrepresented')) return overlaid;
  return deepFreeze({
    ...overlaid,
    semanticIr: deepFreeze({
      ...overlaid.semanticIr,
      completeness: 'partial',
      unknowns: [...unknowns, { reason: 'switch-function-exit-edge-unrepresented', categories: ['control'] }],
    }),
  });
}

function ensureLowered(value, options) { return value && Array.isArray(value.bundles) ? lowerVMEffectsToSemanticIr(value, options) : value; }

const SUMMARY_SCANNED_NODE_KINDS = new Set(['call', 'load', 'store', 'trap']);
const SUMMARY_UNKNOWN_NODE_MEMORY_CATEGORIES = new Set(['memory', 'heap', 'other']);
const SUMMARY_UNKNOWN_FUNCTION_MEMORY_CATEGORIES = new Set(['memory', 'heap']);
export function buildManagedMethodSummary(loweredOrFunction, options = {}) {
  const lowered = ensureLowered(loweredOrFunction, options);
  const methodId = lowered.methodId || 'method_0';
  const semanticIr = lowered.semanticIr;
  const cfg = lowered.cfg;
  const directCalls = [], dynamicCalls = [], externalCalls = [], memoryReads = [], memoryWrites = [], unknownCallEffects = [], thrownExceptions = [], semanticFacts = [];
  const nodesById = new Map((semanticIr.nodes ?? []).map((node) => [node.id, node]));
  const valuesById = new Map((semanticIr.values ?? []).map((value) => [value.id, value]));
  const fieldIdentityForMemoryNode = (node) => {
    const direct = node.attributes?.fieldIdentity;
    if (typeof direct === 'string' && direct.length > 0 && direct === direct.trim()) return direct;
    const addressValueId = node.memory?.addressExpr?.valueId;
    const addressValue = valuesById.get(addressValueId);
    const addressNode = nodesById.get(addressValue?.definitionNodeId);
    const derived = addressNode?.attributes?.fieldIdentity;
    return typeof derived === 'string' && derived.length > 0 && derived === derived.trim() ? derived : null;
  };
  let hasLanguageThrow = false;
  let hasUnboundFieldOrdering = false;
  let hasPossibleExceptionAuthority = false;
  let hasUnrepresentedPossibleExceptionAuthority = false;
  for (const node of semanticIr.nodes) {
    const possibleExceptions = Array.isArray(node.metadata?.possibleExceptions) ? node.metadata.possibleExceptions : [];
    for (const exception of possibleExceptions) {
      hasPossibleExceptionAuthority = true;
      const record = exception && typeof exception === 'object' && !Array.isArray(exception) ? exception : { value: exception };
      const exceptionKind = typeof record.kind === 'string' && record.kind.length > 0 ? record.kind : 'managed-runtime-exception';
      const condition = typeof record.condition === 'string' && record.condition.length > 0 ? record.condition : null;
      const structurallyRepresented = node.memory?.faults?.some((fault) => fault?.kind === exceptionKind) === true;
      if (!structurallyRepresented) hasUnrepresentedPossibleExceptionAuthority = true;
      thrownExceptions.push({ kind: exceptionKind, nodeId: node.id, possible: true, condition, structurallyRepresented, details: record });
      semanticFacts.push({ kind: 'managed-possible-exception', nodeId: node.id, exceptionKind, condition, structurallyRepresented, details: record });
    }
    if (node.kind === 'call' && node.call) {
      const call = node.call, candidates = call.targetEntityIds || [];
      const dispatchKind=node.metadata?.dispatchKind||'unknown', targetUnresolved=node.metadata?.targetUnresolved===true;
      const isExternal = isManagedExternalCall(candidates, dispatchKind);
      if (candidates.length===1&&!isExternal&&dispatchKind==='direct'&&!targetUnresolved) { directCalls.push({target:candidates[0],dispatchKind:'direct',unresolved:false,nodeId:node.id}); if(call.completeness!=='complete')unknownCallEffects.push(createUnknownCallEffect({callSiteId:node.id,reason:'summary-incomplete',targetEntityIds:candidates,evidenceIds:[node.id]})); }
      else if(isExternal){externalCalls.push({target:candidates[0]||'external',dispatchKind:'external',unresolved:true,nodeId:node.id});unknownCallEffects.push(createUnknownCallEffect({callSiteId:node.id,reason:'unresolved-target',targetEntityIds:candidates,evidenceIds:[node.id]}));}
      else {dynamicCalls.push({targets:candidates,dispatchKind:'dynamic',unresolved:true,nodeId:node.id});unknownCallEffects.push(createUnknownCallEffect({callSiteId:node.id,reason:'indirect-incomplete-target-set',targetEntityIds:candidates,evidenceIds:[node.id]}));}
    } else if(node.kind==='load'||node.kind==='store'){
      const memory=node.memory??{};
      (node.kind==='load'?memoryReads:memoryWrites).push(createMemoryEffect({regionKind:'unknown',broad:true,addressSpaces:[memory.addressSpace||'memory'],source:'proven-summary',evidenceIds:[node.id]}));
      if(memory.volatility===true||memory.atomic===true||(memory.ordering!=null&&memory.ordering!=='unknown')) {
        const fieldIdentity=fieldIdentityForMemoryNode(node);
        const fieldScoped=memory.addressSpace==='field'||memory.addressSpace==='static-field';
        if(fieldScoped&&!fieldIdentity)hasUnboundFieldOrdering=true;
        semanticFacts.push({kind:'managed-memory-ordering',nodeId:node.id,addressSpace:memory.addressSpace||'memory',isWrite:node.kind==='store',volatility:memory.volatility??'unknown',atomic:memory.atomic??'unknown',ordering:memory.ordering??'unknown',...(fieldIdentity?{fieldIdentity}:{})});
      }
    }
    else if(node.kind==='trap'){
      // A language-level throw keeps its identity through the bridge (#7311):
      // the lowering stamps metadata.exceptionThrow and keeps the thrown
      // operand as the node's input, so the summary can name it instead of
      // collapsing it into a generic runtime trap.
      const languageThrow=node.metadata?.exceptionThrow===true;
      thrownExceptions.push({kind:languageThrow?'throw':'trap',nodeId:node.id,thrownValueId:languageThrow?(node.inputs?.[0]??null):null});
      if(languageThrow)hasLanguageThrow=true;
    }
  }
  const unknownEffectEvidence = new Set();
  let unknownEffectCalls = false;
  let functionLevelUnknownEffects = false;
  for (const node of semanticIr.nodes) {
    if (SUMMARY_SCANNED_NODE_KINDS.has(node.kind)) continue;
    const categories = node.unknown?.categories;
    if (!Array.isArray(categories)) continue;
    if (categories.some((category) => SUMMARY_UNKNOWN_NODE_MEMORY_CATEGORIES.has(category))) unknownEffectEvidence.add(node.id);
    if (categories.includes('calls')) { unknownEffectCalls = true; unknownCallEffects.push(createUnknownCallEffect({ callSiteId: node.id, reason: 'summary-incomplete', targetEntityIds: node.call?.targetEntityIds ?? [], evidenceIds: [node.id] })); }
  }
  for (const unknown of semanticIr.unknowns ?? []) {
    const categories = unknown?.categories;
    if (!Array.isArray(categories)) continue;
    if (categories.some((category) => SUMMARY_UNKNOWN_FUNCTION_MEMORY_CATEGORIES.has(category))) functionLevelUnknownEffects = true;
    if (categories.includes('calls') && unknownCallEffects.length === 0) { unknownEffectCalls = true; unknownCallEffects.push(createUnknownCallEffect({ callSiteId: methodId, reason: 'summary-incomplete', targetEntityIds: [], evidenceIds: [] })); }
  }
  const hasExceptionEdges=cfg.blocks.some(b=>(b.successors||[]).some(s=>s.kind==='exception')), completeness=(semanticIr.completeness!=null&&semanticIr.completeness!=='complete'||unknownCallEffects.length>0||hasLanguageThrow||hasUnrepresentedPossibleExceptionAuthority||hasUnboundFieldOrdering||unknownEffectEvidence.size>0||functionLevelUnknownEffects||unknownEffectCalls)?'partial':'complete';
  if(unknownCallEffects.length>0)memoryWrites.push(createMemoryEffect({regionKind:'unknown',broad:true,addressSpaces:['memory'],source:'unknown-call-fallback',evidenceIds:unknownCallEffects.map(u=>u.callSiteId)}));
  if(unknownEffectEvidence.size>0||functionLevelUnknownEffects){
    const evidenceIds=[...unknownEffectEvidence];
    if(!memoryReads.some((effect)=>effect.broad))memoryReads.push(createMemoryEffect({regionKind:'unknown',broad:true,addressSpaces:['memory'],source:'unknown-call-fallback',evidenceIds}));
    if(!memoryWrites.some((effect)=>effect.broad))memoryWrites.push(createMemoryEffect({regionKind:'unknown',broad:true,addressSpaces:['memory'],source:'unknown-call-fallback',evidenceIds}));
  }
  if(unknownCallEffects.length>0&&!memoryReads.some((effect)=>effect.broad))memoryReads.push(createMemoryEffect({regionKind:'unknown',broad:true,addressSpaces:['memory'],source:'unknown-call-fallback',evidenceIds:unknownCallEffects.map(u=>u.callSiteId)}));
  const status=createAnalysisStatus({snapshotId:options.snapshotId||'managed-summary-v1',analyzerId:'managed.method.summary',analyzerVersion:'1.0.0',completeness,stopReason:completeness==='complete'?null:'evidence-missing'});
  // Confirmed direct calls are canonical summary effects, not bridge-side
  // trivia: createFunctionSummary() hashes them into the dependency digest,
  // and a caller that has not yet composed its callee effects must not see
  // this method as call-free/pure (#5406). The target is the caller's own
  // claim ('abi-rule': the direct dispatch was proven by this method's IR,
  // not by a callee summary), so record it at the boundary.
  const summaryDirectCalls=directCalls.map((call)=>createDirectCall({callSiteId:call.nodeId,targetEntityIds:[call.target],effectSource:'abi-rule'}));
  const summary=createFunctionSummary({functionId:methodId,status,memoryReadRegions:memoryReads,memoryWriteRegions:memoryWrites,unknownCallEffects,directCalls:summaryDirectCalls,mayThrow:(hasPossibleExceptionAuthority||thrownExceptions.length>0)?true:'unknown',semanticFacts});
  return deepFreeze({methodId,summary,directCalls,dynamicCalls,externalCalls,thrownExceptions,hasExceptionEdges,completeness});
}
export function analyzeManagedInterprocedural(methods, options={}){const methodMap=new Map();for(const method of methods){const summary=buildManagedMethodSummary(method,options);methodMap.set(summary.methodId,summary)}const roots=[...methodMap.keys()],successorsOf=id=>{const entry=methodMap.get(id);return entry?entry.directCalls.map(c=>c.target).filter(t=>methodMap.has(t)):[]};const{components,truncated}=condenseCallGraph(roots,successorsOf,options);return deepFreeze({components,truncated,summaries:methodMap})}
export function decompileManagedMethod(loweredOrFunction,options={}){const lowered=ensureLowered(loweredOrFunction,options);return legacy.decompileManagedMethod(projectWasmSelectView(lowered),options)}
