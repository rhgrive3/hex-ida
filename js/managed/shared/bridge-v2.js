import { deepFreeze } from '../../core/identity/index.js';
import { createAnalysisStatus } from '../../analysis/status.js';
import { createFunctionSummary, createMemoryEffect, createUnknownCallEffect } from '../../analysis/summary/contract.js';
import { condenseCallGraph } from '../../analysis/summary/interprocedural.js';
import * as legacy from './bridge.js';
import { lowerVMEffectsToSemanticIr } from './bridge-lowering-v2.js';

export const MANAGED_BRIDGE_VERSION = legacy.MANAGED_BRIDGE_VERSION;
export const queryManagedSymbolicVerification = legacy.queryManagedSymbolicVerification;
export const queryManagedRuntimeProvider = legacy.queryManagedRuntimeProvider;
export const buildManagedTypeConstraintGraph = legacy.buildManagedTypeConstraintGraph;
export { lowerVMEffectsToSemanticIr };

function ensureLowered(value, options) {
  return value && Array.isArray(value.bundles) ? lowerVMEffectsToSemanticIr(value, options) : value;
}

export function buildManagedMethodSummary(loweredOrFunction, options = {}) {
  const lowered = ensureLowered(loweredOrFunction, options);
  const methodId = lowered.methodId || 'method_0';
  const semanticIr = lowered.semanticIr;
  const cfg = lowered.cfg;
  const directCalls = [];
  const dynamicCalls = [];
  const externalCalls = [];
  const memoryReads = [];
  const memoryWrites = [];
  const unknownCallEffects = [];
  const thrownExceptions = [];

  for (const node of semanticIr.nodes) {
    if (node.kind === 'call' && node.call) {
      const call = node.call;
      const candidates = call.targetEntityIds || [];
      const isExternal = candidates.some((c) => {
        const lc = String(c).toLowerCase();
        return lc.includes('jni') || lc.includes('host') || lc.includes('import') || lc.includes('native') || lc.includes('pinvoke');
      });
      const dispatchKind = node.metadata?.dispatchKind || 'unknown';
      const targetUnresolved = node.metadata?.targetUnresolved === true;
      if (candidates.length === 1 && !isExternal && dispatchKind === 'direct' && !targetUnresolved) {
        directCalls.push({ target: candidates[0], dispatchKind: 'direct', unresolved: false, nodeId: node.id });
        if (call.completeness !== 'complete') {
          unknownCallEffects.push(createUnknownCallEffect({
            callSiteId: node.id,
            reason: 'summary-incomplete',
            targetEntityIds: candidates,
            evidenceIds: [node.id],
          }));
        }
      } else if (isExternal) {
        externalCalls.push({ target: candidates[0] || 'external', dispatchKind: 'external', unresolved: true, nodeId: node.id });
        unknownCallEffects.push(createUnknownCallEffect({
          callSiteId: node.id,
          reason: 'unresolved-target',
          targetEntityIds: candidates,
          evidenceIds: [node.id],
        }));
      } else {
        dynamicCalls.push({ targets: candidates, dispatchKind: 'dynamic', unresolved: true, nodeId: node.id });
        unknownCallEffects.push(createUnknownCallEffect({
          callSiteId: node.id,
          reason: 'indirect-incomplete-target-set',
          targetEntityIds: candidates,
          evidenceIds: [node.id],
        }));
      }
    } else if (node.kind === 'load') {
      memoryReads.push(createMemoryEffect({ regionKind: 'heap', broad: false, addressSpaces: ['memory'], source: 'instruction', evidenceIds: [node.id] }));
    } else if (node.kind === 'store') {
      memoryWrites.push(createMemoryEffect({ regionKind: 'heap', broad: false, addressSpaces: ['memory'], source: 'instruction', evidenceIds: [node.id] }));
    } else if (node.kind === 'trap') {
      thrownExceptions.push({ kind: 'trap', nodeId: node.id });
    }
  }

  const hasExceptionEdges = cfg.blocks.some((b) => (b.successors || []).some((s) => s.kind === 'exception'));
  const completeness = unknownCallEffects.length > 0 ? 'partial' : 'complete';
  if (unknownCallEffects.length > 0) {
    memoryWrites.push(createMemoryEffect({
      regionKind: 'unknown', broad: true, addressSpaces: ['memory'], source: 'unknown-call-fallback',
      evidenceIds: unknownCallEffects.map((u) => u.callSiteId),
    }));
  }
  const status = createAnalysisStatus({
    snapshotId: options.snapshotId || 'managed-summary-v1', analyzerId: 'managed.method.summary', analyzerVersion: '1.0.0',
    completeness, stopReason: completeness === 'complete' ? null : 'evidence-missing',
  });
  const summary = createFunctionSummary({ functionId: methodId, status, memoryReadRegions: memoryReads, memoryWriteRegions: memoryWrites, unknownCallEffects });
  return deepFreeze({ methodId, summary, directCalls, dynamicCalls, externalCalls, thrownExceptions, hasExceptionEdges, completeness });
}

export function analyzeManagedInterprocedural(methods, options = {}) {
  const methodMap = new Map();
  for (const method of methods) {
    const summary = buildManagedMethodSummary(method, options);
    methodMap.set(summary.methodId, summary);
  }
  const roots = [...methodMap.keys()];
  const successorsOf = (id) => {
    const entry = methodMap.get(id);
    return entry ? entry.directCalls.map((call) => call.target).filter((target) => methodMap.has(target)) : [];
  };
  const { components, truncated } = condenseCallGraph(roots, successorsOf, options);
  return deepFreeze({ components, truncated, summaries: methodMap });
}

export function decompileManagedMethod(loweredOrFunction, options = {}) {
  return legacy.decompileManagedMethod(ensureLowered(loweredOrFunction, options), options);
}
