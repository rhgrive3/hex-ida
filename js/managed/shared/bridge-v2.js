import { deepFreeze } from '../../core/identity/index.js';
import { createAnalysisStatus } from '../../analysis/status.js';
import { createFunctionSummary, createMemoryEffect, createUnknownCallEffect, createDirectCall } from '../../analysis/summary/contract.js';
import { condenseCallGraph } from '../../analysis/summary/interprocedural.js';
import * as legacy from './bridge.js';
import { lowerVMEffectsToSemanticIr as lowerCore } from './bridge-lowering-v2.js';
import { overlayDexLowering } from './bridge-dex-overlay-v2.js';

export const MANAGED_BRIDGE_VERSION = legacy.MANAGED_BRIDGE_VERSION;
export const queryManagedSymbolicVerification = legacy.queryManagedSymbolicVerification;
export const queryManagedRuntimeProvider = legacy.queryManagedRuntimeProvider;
export const buildManagedTypeConstraintGraph = legacy.buildManagedTypeConstraintGraph;
export function lowerVMEffectsToSemanticIr(value, options = {}) { return overlayDexLowering(value, lowerCore(value, options)); }

function ensureLowered(value, options) { return value && Array.isArray(value.bundles) ? lowerVMEffectsToSemanticIr(value, options) : value; }

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
  for (const node of semanticIr.nodes) {
    if (node.kind === 'call' && node.call) {
      const call = node.call, candidates = call.targetEntityIds || [];
      const isExternal = candidates.some((c) => { const lc=String(c).toLowerCase(); return lc.includes('jni')||lc.includes('host')||lc.includes('import')||lc.includes('native')||lc.includes('pinvoke'); });
      const dispatchKind=node.metadata?.dispatchKind||'unknown', targetUnresolved=node.metadata?.targetUnresolved===true;
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
  const hasExceptionEdges=cfg.blocks.some(b=>(b.successors||[]).some(s=>s.kind==='exception')), completeness=(semanticIr.completeness!=null&&semanticIr.completeness!=='complete'||unknownCallEffects.length>0||hasLanguageThrow||hasUnboundFieldOrdering)?'partial':'complete';
  if(unknownCallEffects.length>0)memoryWrites.push(createMemoryEffect({regionKind:'unknown',broad:true,addressSpaces:['memory'],source:'unknown-call-fallback',evidenceIds:unknownCallEffects.map(u=>u.callSiteId)}));
  const status=createAnalysisStatus({snapshotId:options.snapshotId||'managed-summary-v1',analyzerId:'managed.method.summary',analyzerVersion:'1.0.0',completeness,stopReason:completeness==='complete'?null:'evidence-missing'});
  // Confirmed direct calls are canonical summary effects, not bridge-side
  // trivia: createFunctionSummary() hashes them into the dependency digest,
  // and a caller that has not yet composed its callee effects must not see
  // this method as call-free/pure (#5406). The target is the caller's own
  // claim ('abi-rule': the direct dispatch was proven by this method's IR,
  // not by a callee summary), so record it at the boundary.
  const summaryDirectCalls=directCalls.map((call)=>createDirectCall({callSiteId:call.nodeId,targetEntityIds:[call.target],effectSource:'abi-rule'}));
  const summary=createFunctionSummary({functionId:methodId,status,memoryReadRegions:memoryReads,memoryWriteRegions:memoryWrites,unknownCallEffects,directCalls:summaryDirectCalls,semanticFacts});
  return deepFreeze({methodId,summary,directCalls,dynamicCalls,externalCalls,thrownExceptions,hasExceptionEdges,completeness});
}
export function analyzeManagedInterprocedural(methods, options={}){const methodMap=new Map();for(const method of methods){const summary=buildManagedMethodSummary(method,options);methodMap.set(summary.methodId,summary)}const roots=[...methodMap.keys()],successorsOf=id=>{const entry=methodMap.get(id);return entry?entry.directCalls.map(c=>c.target).filter(t=>methodMap.has(t)):[]};const{components,truncated}=condenseCallGraph(roots,successorsOf,options);return deepFreeze({components,truncated,summaries:methodMap})}
export function decompileManagedMethod(loweredOrFunction,options={}){return legacy.decompileManagedMethod(ensureLowered(loweredOrFunction,options),options)}