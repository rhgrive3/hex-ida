import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeManagedInterprocedural,
  buildManagedMethodSummary,
} from '../../../js/managed/shared/bridge-v2.js';
import { createManagedMethodId, createVMOperationId } from '../../../js/managed/shared/identity.js';
import { createVMEffectBundle, createVMEffectFunction } from '../../../js/managed/shared/vm-effects.js';

function loweredCall({ methodId = 'caller', target, dispatchKind, unresolved = false, completeness = 'complete' }) {
  return {
    methodId,
    semanticIr: {
      nodes: [{
        id: `${methodId}:call`,
        kind: 'call',
        call: { targetEntityIds: [target], completeness },
        metadata: { dispatchKind, targetUnresolved: unresolved },
      }],
    },
    cfg: { blocks: [] },
  };
}

const internalTargets = [
  'managed-method:managed-type:app:HostnameParser:parse',
  'managed-method:managed-type:app:NativeImage:decode',
  'managed-method:managed-type:app:ImportantService:run',
  'managed-method:managed-type:app:GhostState:advance',
  'managed-method:managed-type:app:JniAdapter:invoke',
  'managed-method:managed-type:app:PInvokeCoordinator:run',
];

test('#4802 resolved canonical managed method names do not become external by substring', () => {
  for (const target of internalTargets) {
    const result = buildManagedMethodSummary(loweredCall({ target, dispatchKind: 'direct' }));
    assert.deepEqual(result.directCalls.map((call) => call.target), [target], target);
    assert.equal(result.externalCalls.length, 0, target);
    assert.equal(result.summary.unknownCallEffects.length, 0, target);
    assert.equal(result.completeness, 'complete', target);
  }
});

test('#4802 explicit external dispatch metadata remains authoritative without name keywords', () => {
  const cases = [
    { dispatchKind: 'jni-native', target: 'LCalc;->compute()V' },
    { dispatchKind: 'host-import', target: 'env.abort' },
    { dispatchKind: 'pinvoke', target: 'KERNEL32!Beep' },
    { dispatchKind: 'external', target: 'opaque.foreign.target' },
  ];
  for (const entry of cases) {
    const result = buildManagedMethodSummary(loweredCall({ ...entry, unresolved: true, completeness: 'partial' }));
    assert.equal(result.directCalls.length, 0, entry.dispatchKind);
    assert.deepEqual(result.externalCalls.map((call) => call.target), [entry.target], entry.dispatchKind);
    assert.equal(result.summary.unknownCallEffects.length, 1, entry.dispatchKind);
    assert.equal(result.completeness, 'partial', entry.dispatchKind);
  }
});


test('#4802 first-party VM effect dispatch metadata survives lowering into external classification', () => {
  for (const entry of [
    { frontendId: 'jvm', dispatchKind: 'jni-native', target: 'LCalc;.compute()V' },
    { frontendId: 'wasm', dispatchKind: 'host-import', target: 'env.abort' },
  ]) {
    const methodId = createManagedMethodId(`managed-mod:test:${entry.frontendId}`, 0);
    const bundle = createVMEffectBundle({
      frontendId: entry.frontendId,
      methodId,
      operationId: createVMOperationId(methodId, 0),
      bytecodeOffset: 0,
      opcode: 0,
      mnemonic: 'external_call',
      callEffects: [{ target: entry.target, dispatchKind: entry.dispatchKind, unresolved: true }],
      completeness: 'partial',
      unknownEffects: [{ category: 'calls', reason: 'external-call-effects-unresolved' }],
    });
    const vmFunction = createVMEffectFunction({
      methodId,
      frontendId: entry.frontendId,
      bundles: [bundle],
      aggregateCompleteness: 'partial',
    });
    const result = buildManagedMethodSummary(vmFunction);
    assert.deepEqual(result.externalCalls.map((call) => call.target), [entry.target], entry.dispatchKind);
    assert.equal(result.dynamicCalls.length, 0, entry.dispatchKind);
  }
});

test('#4802 explicit external identity namespaces are structural, not arbitrary substrings', () => {
  const explicitExternalTargets = [
    'jni:java.lang.System.nanoTime',
    'jni-native:java.lang.System.nanoTime',
    'host:env.abort',
    'host-import:env.abort',
    'import:env.abort',
    'native:kernel32.Beep',
    'pinvoke:kernel32.Beep',
  ];
  for (const target of explicitExternalTargets) {
    const result = buildManagedMethodSummary(loweredCall({
      target,
      dispatchKind: 'unknown',
      unresolved: true,
      completeness: 'partial',
    }));
    assert.deepEqual(result.externalCalls.map((call) => call.target), [target], target);
  }
});

test('#4802 direct edge to an internal method with an external-looking name survives SCC construction', () => {
  const callerId = 'managed-method:managed-type:app:Caller:run';
  const calleeId = 'managed-method:managed-type:app:HostnameParser:parse';
  const caller = loweredCall({ methodId: callerId, target: calleeId, dispatchKind: 'direct' });
  const callee = loweredCall({ methodId: calleeId, target: callerId, dispatchKind: 'direct' });
  const analysis = analyzeManagedInterprocedural([caller, callee]);

  assert.equal(analysis.truncated, false);
  assert.equal(analysis.components.length, 1,
    'the two confirmed internal edges must form one strongly connected component');
  assert.deepEqual(new Set(analysis.components[0]), new Set([callerId, calleeId]));
});
